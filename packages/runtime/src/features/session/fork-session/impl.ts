import { SessionEvent } from "@ocpp/schema/session-event"
import { SessionFact } from "@ocpp/schema/session-fact"
import { optional, PositiveInt } from "@ocpp/schema/schema"
import { SessionID } from "@ocpp/schema/session-id"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applySessionCreated,
  applySessionDeleted,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or deleted.
// Its Session lifecycle is the shared fold in session/lifecycle.ts; the rest
// is duplicated from create-session on purpose.
export type ForkSessionState = {
  sessions: Record<string, "live" | "deleted">
}

export const forkSessionStore = Context.Service<SliceStoreService<ForkSessionState, ForkSessionState, unknown>>(
  "@ocpp/runtime/ForkSessionStore",
)

export const createForkSessionState = (): ForkSessionState => ({ sessions: {} })

const sessionForked = sessionEvent("session-forked")
const blobsStored = sessionEvent("session-instruction-blobs-stored")
const historyCopied = sessionEvent("session-history-copied")
const notebookCopied = sessionEvent("session-codemode-notebook-copied")

// A fork is a Session of its own, not a child: it records where it came from
// in session-forked instead of a parent.
const { parentID: _parent, ...child } = SessionEvent.Created.data.fields
const { sessionID: _child, ...fork } = SessionEvent.Forked.data.fields
const copied = SessionFact.NotebookCopied.data.fields

type Message = (typeof SessionFact.HistoryCopied.Type)["data"]["messages"][number]

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    session: Schema.Struct(child),
    ...fork,
    parentID: SessionID,
    // The values the child's instructions refer to by hash, which its parent's facts stored.
    blobs: optional(SessionFact.InstructionBlobsStored.data.fields.blobs),
    // The parent's settled messages through the boundary, in order, which the child's history copies, and at most
    // how many bytes of them one fact holds.
    history: optional(
      Schema.Struct({ messages: SessionFact.HistoryCopied.data.fields.messages, pageBytes: PositiveInt }),
    ),
    // The parent's notebook through the boundary, as the host resolves it from where each value's message sits: the
    // values its history saved, and the parent's commands and events.
    notebook: optional(Schema.Struct({ values: copied.values, commands: copied.commands, events: copied.events })),
  }),
)

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

// The copied history in pages: each holds the messages that fit in its bytes, in order, and a message that does not
// fit in a page alone has one of its own.
const paginate = (messages: ReadonlyArray<Message>, pageBytes: number) => {
  const pages: Message[][] = []
  let size = 0
  for (const message of messages) {
    const length = bytes(message)
    const page = pages.at(-1)
    if (page !== undefined && size + length <= pageBytes) {
      page.push(message)
      size += length
      continue
    }
    pages.push([message])
    size = length
  }
  return pages
}

export const forkSession = implementCommand(specification)
  .inputSchema(input)
  .store(forkSessionStore)
  // The parent is a Session the decision reads.
  .consistencyKeys({ session: (command) => [command.session.sessionID, command.parentID] })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .handle(async (command, state) => {
    requireLiveSession(state, command.parentID)
    const sessionID = command.session.sessionID
    if (state.sessions[sessionID]) throw new CommandRejection("session-already-exists", "Session already exists")
    // A command or event is copied with the notebook value that handles it.
    const values = command.notebook?.values ?? {}
    const handled = <T extends { readonly handler: string }>(entries: Readonly<Record<string, T>>) =>
      Object.fromEntries(Object.entries(entries).filter(([, entry]) => Object.hasOwn(values, entry.handler)))
    // What the child inherits comes before the fork, whose projection checkpoints the copied notebook in the child's
    // instructions: the values its instructions refer to, its history, then its notebook. The child reads none of its
    // parent's facts.
    return [
      sessionCreated.create(command.session),
      ...(command.blobs === undefined || Object.keys(command.blobs).length === 0
        ? []
        : [blobsStored.create({ sessionID, blobs: command.blobs })]),
      ...(command.history === undefined ? [] : paginate(command.history.messages, command.history.pageBytes)).map(
        (messages) => historyCopied.create({ sessionID, messages }),
      ),
      ...(command.notebook === undefined || Object.keys(values).length === 0
        ? []
        : [
            notebookCopied.create({
              sessionID,
              values,
              commands: handled(command.notebook.commands),
              events: handled(command.notebook.events),
            }),
          ]),
      sessionForked.create({
        sessionID,
        parentID: command.parentID,
        boundary: command.boundary,
        ...(command.instructions === undefined ? {} : { instructions: command.instructions }),
        ...(command.instructionEntries === undefined ? {} : { instructionEntries: command.instructionEntries }),
        ...(command.tools === undefined ? {} : { tools: command.tools }),
      }),
    ]
  })
