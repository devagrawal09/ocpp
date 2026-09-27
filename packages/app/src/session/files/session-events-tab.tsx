import type { CodeModeEventInfo } from "@ocpp/client/promise"
import { Button } from "@ocpp/ui/button"
import { useDialog } from "@ocpp/ui/context/dialog"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@ocpp/ui/dialog"
import { Icon } from "@ocpp/ui/icon"
import { IconButton } from "@ocpp/ui/icon-button"
import { Switch } from "@ocpp/ui/switch"
import { Tooltip } from "@ocpp/ui/tooltip"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { same } from "@/runtime/persistence/equality"
import { useServerSDK } from "@/runtime/server/client"
import { useServer } from "@/runtime/server/current"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import { absoluteTime, eventsView, lastLabel, nextLabel, scheduleLabel, type EventLabelKey } from "./session-events"
import { PanelEmpty } from "./session-running-tab"

const statusTone = {
  running: "text-v2-text-text-muted",
  completed: "text-v2-state-fg-success",
  error: "text-v2-state-fg-danger",
  cancelled: "text-v2-state-fg-warning",
} as const

export function SessionEventsTab(props: {
  sessionID: string
  reveal: (target: { messageID: string; partID?: string }) => void
}) {
  const language = useLanguage()
  const data = useServer().ctx.data
  const sdk = useServerSDK()
  const dialog = useDialog()
  const [state, setState] = createStore({ failed: false, pending: {} as Record<string, boolean> })
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(timer))

  // A reconnect invalidates the list, and reading it again here brings the view back up to date.
  createEffect(() => {
    if (sdk.connection.status() !== "connected") return
    const sessionID = props.sessionID
    setState("failed", false)
    void data.session.event.sync(sessionID).catch(() => setState("failed", true))
  })

  // User actions skip the agent's permission rules; the server announces the change and the list follows.
  const act = (name: string, request: () => Promise<unknown>) => {
    if (state.pending[name]) return
    setState("pending", name, true)
    void request()
      .catch((error: unknown) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(error, language.t("common.requestFailed")),
        }),
      )
      .finally(() => setState("pending", name, false))
  }

  const remove = (name: string) =>
    dialog.show(() => (
      <Dialog fit>
        <DialogHeader hideClose>
          <DialogTitleGroup
            title={language.t("session.events.remove.title")}
            description={language.t("session.events.remove.confirm", { name })}
          />
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              dialog.close()
              act(name, () => sdk.api.session.event.remove({ sessionID: props.sessionID, name }))
            }}
          >
            {language.t("session.events.remove.button")}
          </Button>
        </DialogFooter>
      </Dialog>
    ))

  return (
    <SessionEventsView
      events={data.session.event.list(props.sessionID)}
      failed={state.failed}
      now={now()}
      pending={(name) => state.pending[name] === true}
      onToggle={(name, enabled) =>
        act(name, () =>
          enabled
            ? sdk.api.session.event.enable({ sessionID: props.sessionID, name })
            : sdk.api.session.event.disable({ sessionID: props.sessionID, name }),
        )
      }
      onRun={(name) =>
        act(name, () =>
          sdk.api.session.event.trigger({ sessionID: props.sessionID, name }).then((firing) => {
            if (firing.status === "skipped") showToast(language.t("session.events.run.skipped", { name }))
          }),
        )
      }
      onRemove={remove}
      onShow={(messageID) => props.reveal({ messageID })}
    />
  )
}

export function SessionEventsView(props: {
  events: readonly CodeModeEventInfo[] | undefined
  failed: boolean
  now: number
  pending: (name: string) => boolean
  onToggle: (name: string, enabled: boolean) => void
  onRun: (name: string) => void
  onRemove: (name: string) => void
  onShow: (messageID: string) => void
}) {
  const language = useLanguage()
  // Rows are keyed by name, so a refreshed list never remounts a row or drops its focus.
  const names = createMemo(() => (props.events ?? []).map((event) => event.name), [], { equals: same })
  const byName = createMemo(() => new Map((props.events ?? []).map((event) => [event.name, event])))
  const view = createMemo(() => eventsView(props.events, props.failed))

  return (
    <div class="h-full flex flex-col overflow-hidden" data-component="session-events-tab">
      <Show
        when={view() === "list"}
        fallback={
          <Show
            when={view() === "empty"}
            fallback={
              <div class="h-full flex items-center justify-center text-12-regular text-text-weak">
                {view() === "failed"
                  ? language.t("common.requestFailed")
                  : language.t("common.loading") + language.t("common.loading.ellipsis")}
              </div>
            }
          >
            <PanelEmpty
              title={language.t("session.events.empty.title")}
              description={language.t("session.events.empty.description")}
            />
          </Show>
        }
      >
        <ul class="min-h-0 overflow-y-auto p-2 flex flex-col gap-1" aria-label={language.t("session.tab.events")}>
          <For each={names()}>
            {(name) => (
              <Show when={byName().get(name)}>
                {(event) => (
                  <EventRow
                    event={event()}
                    now={props.now}
                    pending={props.pending(name)}
                    onToggle={(enabled) => props.onToggle(name, enabled)}
                    onRun={() => props.onRun(name)}
                    onRemove={() => props.onRemove(name)}
                    onShow={props.onShow}
                  />
                )}
              </Show>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}

function EventRow(props: {
  event: CodeModeEventInfo
  now: number
  pending: boolean
  onToggle: (enabled: boolean) => void
  onRun: () => void
  onRemove: () => void
  onShow: (messageID: string) => void
}) {
  const language = useLanguage()
  const format = () => ({
    t: (key: EventLabelKey, params?: Record<string, string | number>) => language.t(key, params),
    locale: language.intl(),
    now: props.now,
  })
  const runs = () => Number(props.event.runCount)
  const skips = () => Number(props.event.skipCount)

  return (
    <li
      data-slot="session-event-item"
      class="flex min-w-0 flex-col gap-1 rounded-[6px] px-2 py-2 hover:bg-v2-overlay-simple-overlay-hover focus-within:bg-v2-overlay-simple-overlay-hover"
    >
      <div class="flex min-w-0 items-center gap-2">
        <span class="min-w-0 flex-1 truncate font-mono text-[13px] font-[530] leading-text-compact text-v2-text-text-base">
          {props.event.name}
        </span>
        <Switch
          checked={props.event.enabled}
          disabled={props.pending}
          onChange={(enabled: boolean) => props.onToggle(enabled)}
          hideLabel
          class="shrink-0"
        >
          {language.t("session.events.toggle", { name: props.event.name })}
        </Switch>
      </div>
      <Show when={props.event.description}>
        <div dir="auto" class="text-[12px] leading-text-compact text-v2-text-text-muted line-clamp-2">
          {props.event.description}
        </div>
      </Show>
      <div class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] leading-text-compact text-v2-text-text-muted">
        <span class="min-w-0 truncate font-mono">{scheduleLabel(props.event.schedule, format())}</span>
        <span aria-hidden="true">·</span>
        <span
          class="min-w-0 truncate"
          title={props.event.nextFireAt ? absoluteTime(props.event.nextFireAt, language.intl()) : undefined}
        >
          {nextLabel(props.event, format())}
        </span>
        <span aria-hidden="true">·</span>
        <span class="min-w-0 truncate font-mono">{`${props.event.handler}()`}</span>
      </div>
      <Show
        when={props.event.lastMessageID}
        fallback={
          <div class="min-w-0 truncate text-[12px] leading-text-compact text-v2-text-text-faint">
            {lastLabel(props.event, format())}
          </div>
        }
      >
        {(messageID) => (
          <button
            type="button"
            class="flex min-w-0 items-center gap-1.5 self-start rounded-[4px] text-[12px] leading-text-compact text-start hover:underline focus-visible:underline focus-visible:outline-none"
            classList={{ [statusTone[props.event.lastStatus ?? "running"]]: true }}
            title={props.event.lastFiredAt ? absoluteTime(props.event.lastFiredAt, language.intl()) : undefined}
            aria-label={language.t("session.events.last.show", { name: props.event.name })}
            onClick={() => props.onShow(messageID())}
          >
            <span class="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
            <span class="min-w-0 truncate">{lastLabel(props.event, format())}</span>
          </button>
        )}
      </Show>
      <Show when={props.event.lastSummary}>
        <div
          dir="auto"
          class="min-w-0 break-words font-mono text-[12px] leading-text-compact text-v2-text-text-faint line-clamp-2"
        >
          {props.event.lastSummary}
        </div>
      </Show>
      <div class="flex min-w-0 items-center gap-1">
        <span class="min-w-0 flex-1 truncate text-[12px] leading-text-compact text-v2-text-text-faint">
          {[
            language.plural("session.events.runs", runs()),
            ...(skips() > 0 ? [language.plural("session.events.skips", skips())] : []),
          ].join(" · ")}
        </span>
        <Button
          size="small"
          variant="ghost"
          disabled={props.pending}
          aria-label={language.t("session.events.run.label", { name: props.event.name })}
          onClick={() => props.onRun()}
        >
          {language.t("session.events.run")}
        </Button>
        <Tooltip value={language.t("session.events.remove", { name: props.event.name })} placement="left">
          <IconButton
            icon={<Icon name="trash" size="small" />}
            variant="ghost-muted"
            size="small"
            disabled={props.pending}
            aria-label={language.t("session.events.remove", { name: props.event.name })}
            onClick={() => props.onRemove()}
          />
        </Tooltip>
      </div>
    </li>
  )
}
