import { SessionDriver } from "@ocpp/schema/session-driver"
import { getFilename } from "@ocpp/util/path"
import { useData } from "@ocpp/session-ui/context"
import { Icon } from "@ocpp/ui/icon"
import { IconButton } from "@ocpp/ui/icon-button"
import { Tooltip } from "@ocpp/ui/tooltip"
import { For, Show, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { same } from "@/runtime/persistence/equality"
import { useServerSDK } from "@/runtime/server/client"
import { useServer } from "@/runtime/server/current"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import { formatElapsed, linger, runningItems, type RunningItem } from "./session-running"

const kinds = {
  execution: { icon: "code", label: "session.running.kind.execution" },
  shell: { icon: "console", label: "session.running.kind.shell" },
  subagent: { icon: "subagent", label: "session.running.kind.subagent" },
} as const

/** What runs in the Session now, kept current from the state the app already receives. */
export function createSessionRunning(sessionID: Accessor<string | undefined>) {
  const data = useServer().ctx.data
  return createMemo(() => {
    const id = sessionID()
    if (!id) return []
    return runningItems({
      sessionID: id,
      messages: data.session.message.list(id),
      sessions: data.session.list(),
      status: data.session.status,
      shells: data.shell.listBySession(id),
    })
  })
}

export function SessionRunningTab(props: {
  running: Accessor<RunningItem[]>
  reveal: (target: { messageID: string; partID?: string }) => void
}) {
  const language = useLanguage()
  const sdk = useServerSDK()
  const session = useData()
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(timer))
  const items = createMemo((previous: RunningItem[]) => linger(previous, props.running(), now()), [])
  const [stopping, setStopping] = createStore<Record<string, boolean>>({})

  const stop = (item: RunningItem) => {
    const target = item.stop
    if (!target || stopping[item.id]) return
    setStopping(item.id, true)
    const request =
      target.type === "execution"
        ? sdk.api.session.execution.cancel({ sessionID: target.sessionID, executionID: target.executionID })
        : target.type === "shell"
          ? sdk.api.shell.remove({
              id: target.shellID,
              location: { directory: target.location.directory, workspace: target.location.workspaceID },
            })
          : sdk.api.session.interrupt({ sessionID: target.sessionID })
    void request
      .catch((error: unknown) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(error, language.t("common.requestFailed")),
        }),
      )
      .finally(() => setStopping(item.id, false))
  }

  return (
    <SessionRunningView
      items={items()}
      now={now()}
      stopping={(id) => stopping[id] === true}
      onShow={(item) => item.target && props.reveal(item.target)}
      onOpen={(item) => item.child && session.navigateToSession?.(item.child)}
      onStop={stop}
    />
  )
}

export function SessionRunningView(props: {
  items: readonly RunningItem[]
  now: number
  stopping: (id: string) => boolean
  onShow: (item: RunningItem) => void
  onOpen: (item: RunningItem) => void
  onStop: (item: RunningItem) => void
}) {
  const language = useLanguage()
  // Rows are keyed by ID, so a progress update never remounts a row or drops its focus.
  const ids = createMemo(() => props.items.map((item) => item.id), [], { equals: same })
  const byID = createMemo(() => new Map(props.items.map((item) => [item.id, item])))

  return (
    <div class="h-full flex flex-col overflow-hidden" data-component="session-running-tab">
      <Show
        when={ids().length > 0}
        fallback={
          <PanelEmpty
            title={language.t("session.running.empty.title")}
            description={language.t("session.running.empty.description")}
          />
        }
      >
        <ul class="min-h-0 overflow-y-auto p-2 flex flex-col gap-0.5" aria-label={language.t("session.tab.running")}>
          <For each={ids()}>
            {(id) => (
              <Show when={byID().get(id)}>
                {(item) => (
                  <RunningRow
                    item={item()}
                    nested={!!item().parent && byID().has(item().parent ?? "")}
                    now={props.now}
                    stopping={props.stopping(id)}
                    onShow={() => props.onShow(item())}
                    onOpen={() => props.onOpen(item())}
                    onStop={() => props.onStop(item())}
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

function RunningRow(props: {
  item: RunningItem
  nested: boolean
  now: number
  stopping: boolean
  onShow: () => void
  onOpen: () => void
  onStop: () => void
}) {
  const language = useLanguage()
  const label = () =>
    props.item.trigger
      ? language.t(`session.running.trigger.${props.item.trigger.type}`, { name: props.item.trigger.name })
      : props.item.label
  const opens = () => props.item.kind === "subagent" && !!props.item.child
  // Code and commands read as written; a subagent's task and an event's name read as prose.
  const code = () => props.item.kind !== "subagent" && !props.item.trigger
  const detail = () => {
    if (props.item.kind === "subagent")
      return [
        props.item.agent,
        props.item.driver &&
          (props.item.driver.native
            ? language.t("session.running.native", { driver: SessionDriver.names[props.item.driver.id] })
            : SessionDriver.names[props.item.driver.id]),
        props.item.title,
        props.item.directory &&
          language.t("session.running.directory", { directory: getFilename(props.item.directory) }),
        props.item.working === undefined
          ? undefined
          : language.t(props.item.working ? "session.running.working" : "session.running.waiting"),
      ]
        .filter((part) => !!part)
        .join(" · ")
    if (props.item.kind !== "execution") return ""
    if (!props.item.stop && props.item.finished === undefined) return language.t("session.running.starting")
    return language.plural("session.running.steps", props.item.steps ?? 0)
  }

  return (
    <li
      data-slot="session-running-item"
      data-kind={props.item.kind}
      class="flex min-w-0 items-start gap-1"
      classList={{
        "ms-4 border-s border-v2-border-border-muted ps-1": props.nested,
        "opacity-60": props.item.finished !== undefined,
      }}
    >
      <button
        type="button"
        class="flex min-w-0 flex-1 items-start gap-2 rounded-[6px] px-2 py-1.5 text-start transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none disabled:hover:bg-transparent"
        disabled={!opens() && !props.item.target}
        aria-label={language.t(opens() ? "session.running.open" : "session.running.show", { label: label() })}
        onClick={() => (opens() ? props.onOpen() : props.onShow())}
      >
        <Icon
          name={kinds[props.item.kind].icon}
          size="small"
          class="mt-px shrink-0 text-v2-icon-icon-muted"
          aria-hidden="true"
        />
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="flex min-w-0 items-center gap-2 text-[12px] leading-text-compact text-v2-text-text-muted">
            <span class="min-w-0 truncate">{language.t(kinds[props.item.kind].label)}</span>
            <span class="ms-auto shrink-0 tabular-nums">
              {props.item.finished === undefined
                ? formatElapsed(props.now - props.item.started, (key, params) => language.t(key, params))
                : language.t("session.running.finished")}
            </span>
          </span>
          <span
            dir="auto"
            class="truncate leading-text-compact text-v2-text-text-base"
            classList={{
              "font-mono text-[12px]": code(),
              "text-[13px] font-[440] tracking-[-0.04px]": !code(),
            }}
            title={props.item.trigger ? props.item.label : label()}
          >
            {label()}
          </span>
          <Show when={detail() || props.item.tool}>
            <span class="flex min-w-0 items-center gap-1 text-[12px] leading-text-compact text-v2-text-text-faint">
              <span class="min-w-0 truncate" title={props.item.directory}>
                {detail()}
              </span>
              <Show when={props.item.tool}>
                {(tool) => (
                  <>
                    <span aria-hidden="true">·</span>
                    <span class="min-w-0 truncate font-mono">{`tools.${tool()}`}</span>
                  </>
                )}
              </Show>
            </span>
          </Show>
        </span>
      </button>
      <Show when={props.item.stop}>
        <Tooltip value={language.t("session.running.stop")} placement="left" class="mt-1 shrink-0">
          <IconButton
            icon={<Icon name="stop" size="small" />}
            variant="ghost-muted"
            size="small"
            disabled={props.stopping}
            aria-label={language.t("session.running.stop.label", { label: label() })}
            onClick={() => props.onStop()}
          />
        </Tooltip>
      </Show>
    </li>
  )
}

/** The side panel's empty state: what a view shows and how things get into it. */
export function PanelEmpty(props: { title: string; description: string }) {
  return (
    <div class="h-full flex flex-col items-center justify-center gap-1 px-6 pb-24 text-center">
      <div class="text-[13px] font-[530] leading-text-compact tracking-[-0.04px] text-v2-text-text-base">
        {props.title}
      </div>
      <div class="max-w-64 text-[12px] leading-text-compact text-v2-text-text-muted">{props.description}</div>
    </div>
  )
}
