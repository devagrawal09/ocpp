import { createEffect, createMemo, createResource, Match, Show, Switch, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useLocation, useNavigate } from "@solidjs/router"
import { IconButton } from "@ocpp/ui/icon-button"
import { Icon } from "@ocpp/ui/icon"
import { Keybind } from "@ocpp/ui/keybind"
import { Tooltip } from "@ocpp/ui/tooltip"

import { LayoutRoute, useLayout } from "@/shell/state/layout"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettings } from "@/settings/model"
import { applyPath, backPath, forwardPath } from "./history"
import { TitlebarTabStrip } from "@/shell/titlebar/tab-strip"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { readSessionTabsRemovedDetail, SESSION_TABS_REMOVED_EVENT } from "@/shell/titlebar/session-events"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { tabKey, useTabs } from "@/shell/tabs/tabs"
import type { ComposerState } from "@/composer/persistence"
import "./titlebar.css"
import { newTabTooltipKeybind } from "@/shell/commands/tooltip-keybind"
import { TitlebarRightMount } from "@/shell/titlebar/right-slot"

export function Titlebar(props: {
  debugTools?: { visible: boolean; toggle: () => void }
  verticalTabs?: { mount?: HTMLElement }
}) {
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()
  const navigate = useNavigate()
  const location = useLocation()
  const mobile = createMediaQuery("(max-width: 767px)")
  const bottom = createMemo(() => mobile() && settings.general.mobileTitlebarPosition() === "bottom")

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`

  createEffect(() => {
    const current = path()

    untrack(() => {
      const next = applyPath(history, current)
      if (next === history) return
      setHistory(next)
    })
  })

  const back = () => {
    const next = backPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  command.register(() => [
    {
      id: "common.goBack",
      title: language.t("common.goBack"),
      category: language.t("command.category.view"),
      keybind: "mod+[",
      onSelect: back,
    },
    {
      id: "common.goForward",
      title: language.t("common.goForward"),
      category: language.t("command.category.view"),
      keybind: "mod+]",
      onSelect: forward,
    },
  ])

  return (
    <header
      data-slot="titlebar-v2"
      classList={{
        "shrink-0 relative flex flex-row h-9 bg-v2-background-bg-deep overflow-visible": true,
        "order-last": bottom(),
      }}
    >
      <Switch>
        <Match when>
          {(_) => {
            const layout = useLayout()
            const global = useGlobal()

            const tabs = useTabs()
            const tabsStore = tabs.store
            const tabsStoreActions = tabs
            const [loadedSession] = createResource(
              () => {
                const route = layout.route()
                if (route.type !== "session") return undefined
                if (tabs.pendingSession(route.server, route.sessionId)) return undefined
                const conn = global.servers.list().find((item) => ServerConnection.key(item) === route.server)
                return conn ? { route, ctx: global.ensureServerCtx(conn) } : undefined
              },
              ({ route, ctx }) => ctx.sdk.api.session.get({ sessionID: route.sessionId }).catch(() => {}),
            )
            const session = createMemo(() => {
              const route = layout.route()
              if (route.type !== "session") return
              if (tabs.pendingSession(route.server, route.sessionId)) return
              const conn = global.servers.list().find((item) => ServerConnection.key(item) === route.server)
              const cached = conn ? global.ensureServerCtx(conn).data.session.get(route.sessionId) : undefined
              if (cached) return cached
              const loaded = loadedSession()
              return loaded?.id === route.sessionId ? loaded : undefined
            })

            const matchRoute = (route: LayoutRoute) => {
              if (route.type === "home") return
              if (route.type === "draft") {
                return tabsStore.find((item) => item.type === "draft" && item.draftID === route.draftID)
              }
              if (route.type === "session") {
                const main = tabsStore.find(
                  (item) =>
                    item.type === "session" &&
                    item.server === route.server &&
                    (item.sessionId === route.sessionId || item.routeSessionId === route.sessionId),
                )
                if (main) return main
                const s = session()
                if (s?.parentID) {
                  const parentID = s.parentID
                  const parent = tabsStore.find(
                    (item) => item.type === "session" && item.server === route.server && item.sessionId === parentID,
                  )
                  if (parent) return parent
                }
              }
            }

            const currentTab = () => matchRoute(layout.route())

            createEffect(() => {
              const route = layout.route()
              if (!tabs.ready()) return
              const tab = currentTab()
              if (tab) {
                const current = session()
                if (
                  route.type === "session" &&
                  tab.type === "session" &&
                  (route.sessionId === tab.sessionId || current?.id === route.sessionId)
                ) {
                  tabs.rememberSessionRoute(tab, route.sessionId, current?.parentID)
                }
                tabs.remember(tab)
                return
              }

              if (route.type === "session") {
                if (tabs.pendingSession(route.server, route.sessionId)) {
                  tabsStoreActions.addSessionTab({ server: route.server, sessionId: route.sessionId })
                  return
                }
                const s = session()
                if (!s) return
                const sessionId = s.parentID ?? s.id
                const next = { server: route.server, sessionId }
                tabsStoreActions.addSessionTab(next)
              }
            })

            makeEventListener(window, SESSION_TABS_REMOVED_EVENT, (event) => {
              const detail = readSessionTabsRemovedDetail(event)
              if (!detail) return
              tabsStoreActions.removeSessions(detail)
            })

            const openNewTab = () => {
              const route = layout.route()
              switch (route.type) {
                case "session": {
                  const pending = tabs.pendingSession(route.server, route.sessionId)
                  if (pending) {
                    const model = tabs.stateValue<ComposerState>(pending.draft, "prompt")?.model.current()
                    void tabs.newDraft({ server: route.server, directory: pending.draft.directory }, "", model)
                    return
                  }
                  const activeSession = session()
                  if (!activeSession) return

                  const sessionTab = {
                    type: "session" as const,
                    server: route.server,
                    sessionId: activeSession.id,
                  }
                  const model = tabs.stateValue<ComposerState>(sessionTab, "prompt")?.model.current()
                  void tabs.newDraft(
                    { server: sessionTab.server, directory: activeSession.location.directory },
                    "",
                    model,
                  )
                  return
                }
                case "draft": {
                  const activeTab = currentTab()
                  if (activeTab?.type !== "draft") return

                  const model = tabs.stateValue<ComposerState>(activeTab, "prompt")?.model.current()
                  void tabs.newDraft({ server: activeTab.server, directory: activeTab.directory }, "", model)
                  return
                }
                case "home": {
                  const selection = layout.home.selection()
                  const conn =
                    global.servers.list().find((item) => ServerConnection.key(item) === selection.server) ??
                    global.servers.list()[0]
                  const projects = conn ? global.ensureServerCtx(conn).projects : undefined
                  const project =
                    projects?.list().find((item) => item.worktree === selection.directory) ??
                    projects?.list().find((item) => item.worktree === projects.last()) ??
                    projects?.list()[0]
                  if (conn && project) {
                    void tabs.newDraft({ server: ServerConnection.key(conn), directory: project.worktree }, "")
                    return
                  }
                }
              }
            }
            const toggleHome = () => tabs.toggleHome({ home: layout.route().type === "home", current: currentTab() })

            command.register("titlebar-home", () => [
              {
                id: "home.toggle",
                title: language.t("home.title"),
                category: language.t("command.category.view"),
                keybind: "mod+b",
                hidden: true,
                onSelect: toggleHome,
              },
            ])

            command.register("tabs", () => {
              const current = currentTab()

              return [
                {
                  id: "tab.new",
                  category: "tab",
                  title: language.t("command.session.new"),
                  keybind: "mod+t,mod+n",
                  hidden: true,
                  onSelect: openNewTab,
                },
                current && {
                  id: "tab.close",
                  category: "tab",
                  title: language.t("command.tab.close"),
                  keybind: "mod+w",
                  hidden: true,
                  onSelect: () => {
                    tabsStoreActions.closeTab(tabsStore.findIndex((tab) => current === tab))
                  },
                },
                {
                  id: "tab.reopenClosed",
                  category: language.t("command.category.file"),
                  title: language.t("command.tab.reopenClosed"),
                  keybind: "mod+shift+t",
                  onSelect: () => tabsStoreActions.reopenClosedTab(),
                },
              ].filter((v) => v !== undefined)
            })

            return (
              <div
                class="h-full flex-1 overflow-hidden flex flex-row items-center gap-1.5 px-2 md:pl-4 md:pr-3"
                classList={{
                  "pt-2": !bottom(),
                  "pb-2": bottom(),
                }}
              >
                <ChannelIndicator debugTools={props.debugTools} />
                <Tooltip
                  placement="bottom"
                  value={
                    <>
                      {language.t("home.title")}
                      <Keybind keys={command.keybindParts("home.toggle")} variant="neutral" />
                    </>
                  }
                  class="shrink-0"
                >
                  <IconButton
                    type="button"
                    variant="ghost-muted"
                    size="large"
                    class="!w-9 shrink-0"
                    icon={<Icon name="grid-plus" />}
                    state={layout.route().type === "home" ? "pressed" : undefined}
                    onClick={toggleHome}
                    aria-label={language.t("home.title")}
                    aria-pressed={layout.route().type === "home"}
                  />
                </Tooltip>

                <Show
                  when={props.verticalTabs}
                  fallback={
                    <>
                      <TitlebarTabStrip
                        tabs={tabsStore}
                        currentTab={currentTab()}
                        onNavigate={(tab, el) => {
                          tabs.select(tab)
                          el?.scrollIntoView({ behavior: "instant" })
                        }}
                        onClose={(tab) => {
                          const index = tabsStore.findIndex((item) => tabKey(item) === tabKey(tab))
                          if (index !== -1) tabsStoreActions.closeTab(index)
                        }}
                        onReorder={(keys) => tabsStoreActions.reorder(keys)}
                      />
                      <Tooltip
                        placement="bottom"
                        value={
                          <>
                            {language.t("command.session.new")}
                            <Keybind keys={newTabTooltipKeybind(command)} variant="neutral" />
                          </>
                        }
                      >
                        <IconButton
                          type="button"
                          variant="ghost-muted"
                          size="large"
                          class="shrink-0"
                          icon={<Icon name="plus" />}
                          onClick={openNewTab}
                          aria-label={language.t("command.session.new")}
                        />
                      </Tooltip>
                    </>
                  }
                >
                  {(vertical) => (
                    <Show when={vertical().mount} keyed>
                      {(mount) => (
                        <Portal mount={mount}>
                          <TitlebarTabStrip
                            orientation="vertical"
                            tabs={tabsStore}
                            currentTab={currentTab()}
                            onNavigate={(tab, el) => {
                              tabs.select(tab)
                              el?.scrollIntoView({ behavior: "instant", block: "nearest" })
                            }}
                            onClose={(tab) => {
                              const index = tabsStore.findIndex((item) => tabKey(item) === tabKey(tab))
                              if (index !== -1) tabsStoreActions.closeTab(index)
                            }}
                            onReorder={(keys) => tabsStoreActions.reorder(keys)}
                          />
                          <button
                            type="button"
                            data-action="vertical-tabs-new-session"
                            class="mt-1 flex h-7 w-full shrink-0 items-center gap-1.5 rounded-[6px] px-1.5 text-[13px] leading-4 text-v2-text-text-faint hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base"
                            onClick={openNewTab}
                            aria-label={language.t("command.session.new")}
                          >
                            <Icon name="plus" />
                            {language.t("command.session.new")}
                          </button>
                        </Portal>
                      )}
                    </Show>
                  )}
                </Show>
                <div class="flex-1" />
                <div class="relative z-20 flex shrink-0 items-center justify-end gap-0 overflow-visible">
                  <TitlebarRightMount />
                </div>
              </div>
            )
          }}
        </Match>
      </Switch>
    </header>
  )
}

function ChannelIndicator(props: { debugTools?: { visible: boolean; toggle: () => void } }) {
  const channel = import.meta.env.VITE_OCPP_CHANNEL
  if (channel === "dev" && props.debugTools) {
    return (
      <button
        type="button"
        class="bg-icon-interactive-base text-[#FFF] font-medium px-2 rounded-sm uppercase font-mono cursor-pointer"
        onClick={props.debugTools.toggle}
        aria-label="Toggle debug tools"
        aria-pressed={props.debugTools.visible}
      >
        DEV
      </button>
    )
  }

  const label = channel && ["local", "beta", "dev"].includes(channel) ? channel.toUpperCase() : undefined
  return (
    <Show when={label}>
      {(value) => (
        <div class="bg-icon-interactive-base text-[#FFF] font-medium px-2 rounded-sm uppercase font-mono">
          {value()}
        </div>
      )}
    </Show>
  )
}
