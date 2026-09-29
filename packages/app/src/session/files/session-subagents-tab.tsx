import type { SessionInfo } from "@ocpp/client/promise"
import { SessionDriver } from "@ocpp/schema/session-driver"
import { getFilename } from "@ocpp/util/path"
import { useData } from "@ocpp/session-ui/context"
import { useQuery } from "@tanstack/solid-query"
import { For, Match, Show, Switch, createMemo } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useServer } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { listAllSessions } from "@/session/list"
import { sessionLabel } from "@/session/title"

export function SessionSubagentsTab(props: { sessionID: string }) {
  const language = useLanguage()
  const server = useServer()
  const sdk = useServerSDK()
  const data = useData()
  const knownChildren = createMemo(() =>
    server.ctx.data.session
      .list()
      .filter((session) => session.parentID === props.sessionID)
      .map((session) => session.id)
      .sort()
      .join("\0"),
  )
  const children = useQuery(() => ({
    queryKey: [sdk.scope, "session-subagents", props.sessionID, knownChildren()] as const,
    queryFn: () => listAllSessions(sdk.api.session, { parentID: props.sessionID, order: "desc" }),
    select: (sessions) => sessions.filter((session) => !session.fork),
    enabled: sdk.connection.status() === "connected" && !!props.sessionID,
    retry: false,
    refetchOnMount: "always" as const,
    refetchOnReconnect: true,
  }))

  const home = createMemo(
    () => server.ctx.data.session.list().find((session) => session.id === props.sessionID)?.location.directory,
  )
  const agent = (session: SessionInfo) => {
    const driver = SessionDriver.of(session.model)
    return [
      session.agent,
      driver === "ocpp" ? undefined : SessionDriver.names[driver],
      // A subagent placed in another directory, such as a separate worktree.
      home() === undefined || session.location.directory === home()
        ? undefined
        : language.t("session.running.directory", { directory: getFilename(session.location.directory) }),
    ]
      .filter(Boolean)
      .join(" · ")
  }

  return (
    <div class="h-full flex flex-col overflow-hidden" data-component="session-subagents-tab">
      <Switch>
        <Match when={children.isPending}>
          <div class="h-full flex items-center justify-center text-12-regular text-text-weak">
            {language.t("common.loading")}
            {language.t("common.loading.ellipsis")}
          </div>
        </Match>
        <Match when={children.isError}>
          <div class="h-full flex items-center justify-center text-12-regular text-text-weak">
            {language.t("common.requestFailed")}
          </div>
        </Match>
        <Match when={children.data?.length === 0}>
          <div class="h-full flex items-center justify-center text-12-regular text-text-weak">
            {language.t("session.subagents.empty")}
          </div>
        </Match>
        <Match when={children.data}>
          {(sessions) => (
            <div class="min-h-0 overflow-y-auto p-2">
              <For each={sessions()}>
                {(session) => (
                  <button
                    type="button"
                    class="flex min-h-12 w-full min-w-0 items-center gap-2 rounded-[6px] px-2 text-start transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
                    onClick={() => data.navigateToSession?.(session.id)}
                  >
                    <div class="min-w-0 flex-1">
                      <div dir="auto" class="truncate text-13-medium text-text-strong">
                        {sessionLabel(session)}
                      </div>
                      <Show when={agent(session)}>
                        {(value) => <div class="truncate text-12-regular text-text-weak">{value()}</div>}
                      </Show>
                    </div>
                    <Show when={server.ctx.data.session.status(session.id) === "running"}>
                      <span class="shrink-0 text-12-regular text-text-weak">
                        {language.t("session.subagents.running")}
                      </span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          )}
        </Match>
      </Switch>
    </div>
  )
}
