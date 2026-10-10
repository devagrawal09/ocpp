import { describe, expect, test } from "bun:test"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { syncEditedFiles } from "../../src/acp/edit"
import { streamTurn } from "../../src/acp/event"
import { createSseFixture, durableEvent, ephemeralEvent } from "./sse-fixture"

type Connection = Pick<AgentSideConnection, "sessionUpdate"> & Partial<Pick<AgentSideConnection, "writeTextFile">>
type Fixture = ReturnType<typeof createSseFixture>

describe("acp edit sync", () => {
  test("does not sync edits when writeTextFile was not advertised", async () => {
    const writes: Parameters<AgentSideConnection["writeTextFile"]>[0][] = []

    await syncEditedFiles({
      connection: {
        writeTextFile: async (input) => {
          writes.push(input)
          return {}
        },
      },
      writeTextFile: false,
      sessionID: "ses_no_write",
      cwd: "/workspace",
      toolName: "edit",
      toolInput: { filePath: "/workspace/file.ts" },
      metadata: {},
    })

    expect(writes).toEqual([])
  })

  test("syncs the file a completed edit changed", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ocpp-acp-edit-"))
    const file = path.join(cwd, "file.ts")
    await fs.writeFile(file, "after")
    const writes: Parameters<AgentSideConnection["writeTextFile"]>[0][] = []
    const fixture = createSseFixture({
      onPrompt({ id, send }) {
        send(durableEvent("session-inbox-delivered", { sessionID: "ses_edit", inboxID: id }))
        called(send, "ses_edit", "msg_edit", "call_edit", "edit", {
          path: "file.ts",
          oldString: "before",
          newString: "after",
        })
        send(
          durableEvent("session-tool-settled", {
            sessionID: "ses_edit",
            assistantMessageID: "msg_edit",
            id: "call_edit",
            metadata: { files: [{ file: "file.ts" }], replacements: 1 },
            content: [{ type: "text", text: "edited" }],
            executed: true,
            outcome: "succeeded",
          }),
        )
        send(durableEvent("session-execution-settled", { sessionID: "ses_edit", outcome: "succeeded" }))
      },
    })
    const connection = {
      sessionUpdate: async () => {},
      writeTextFile: async (request) => {
        writes.push(request)
        return {}
      },
    } satisfies Connection

    try {
      await startTurn(fixture, connection, "ses_edit", "input_edit", cwd)
      expect(writes).toEqual([{ sessionId: "ses_edit", path: file, content: "after" }])
    } finally {
      await fixture.stop()
      await fs.rm(cwd, { recursive: true, force: true })
    }
  })

  test("syncs each file a completed patch changed", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ocpp-acp-patch-"))
    await Promise.all([
      fs.writeFile(path.join(cwd, "first.ts"), "two\n"),
      fs.writeFile(path.join(cwd, "second.ts"), "beta\n"),
    ])
    const writes: Parameters<AgentSideConnection["writeTextFile"]>[0][] = []
    const fixture = createSseFixture({
      onPrompt({ id, send }) {
        send(durableEvent("session-inbox-delivered", { sessionID: "ses_patch", inboxID: id }))
        called(send, "ses_patch", "msg_patch", "call_patch", "patch", { patchText: "*** Begin Patch" })
        send(
          durableEvent("session-tool-settled", {
            sessionID: "ses_patch",
            assistantMessageID: "msg_patch",
            id: "call_patch",
            metadata: { files: [{ file: "first.ts" }, { file: "second.ts" }] },
            content: [{ type: "text", text: "patched" }],
            executed: true,
            outcome: "succeeded",
          }),
        )
        send(durableEvent("session-execution-settled", { sessionID: "ses_patch", outcome: "succeeded" }))
      },
    })
    const connection = {
      sessionUpdate: async () => {},
      writeTextFile: async (request) => {
        writes.push(request)
        return {}
      },
    } satisfies Connection

    try {
      await startTurn(fixture, connection, "ses_patch", "input_patch", cwd)
      expect(writes.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
        { sessionId: "ses_patch", path: path.join(cwd, "first.ts"), content: "two\n" },
        { sessionId: "ses_patch", path: path.join(cwd, "second.ts"), content: "beta\n" },
      ])
    } finally {
      await fixture.stop()
      await fs.rm(cwd, { recursive: true, force: true })
    }
  })
})

function called(
  send: (event: unknown) => void,
  sessionID: string,
  assistantMessageID: string,
  id: string,
  name: string,
  input: Record<string, unknown>,
) {
  send(ephemeralEvent("session-tool-input-started", { sessionID, assistantMessageID, id, name }))
  send(durableEvent("session-tool-requested", { sessionID, assistantMessageID, id, name, input, executed: false }))
}

function startTurn(fixture: Fixture, connection: Connection, sessionID: string, inboxID: string, cwd: string) {
  return streamTurn({
    client: fixture.client,
    connection,
    sessionID,
    cwd,
    start: { type: "input", id: inboxID },
    writeTextFile: true,
    control: { cancelled: false, admission: new AbortController() },
    submit: (signal) => fixture.client.session.prompt({ sessionID, id: inboxID, text: "hello" }, { signal }),
  })
}
