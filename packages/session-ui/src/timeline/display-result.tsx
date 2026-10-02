import type { SessionMessageDisplay, SessionMessageDisplayCell } from "@ocpp/client/promise"
import { useI18n } from "@ocpp/ui/context/i18n"
import { For, Match, Show, Switch } from "solid-js"
import { Markdown } from "../components/markdown"

/** A result that code published with `display_result`, shown in the timeline outside any execution trace. */
export function SessionDisplayResult(props: { message: SessionMessageDisplay; openFile?: (path: string) => void }) {
  const i18n = useI18n()
  return (
    <section
      data-component="session-display-result"
      aria-label={props.message.title ?? i18n.t("ui.sessionTimeline.display.label")}
      class="flex min-w-0 flex-col gap-2"
    >
      <Show when={props.message.title}>
        {(title) => (
          <bdi dir="auto" data-slot="session-display-result-title" class="text-14-medium text-text-strong">
            {title()}
          </bdi>
        )}
      </Show>
      <For each={props.message.blocks}>
        {(block, index) => (
          <Switch>
            <Match when={block.type === "markdown" && block}>
              {(block) => <Markdown text={block().text} cacheKey={`${props.message.id}:${index()}`} />}
            </Match>
            <Match when={block.type === "code" && block}>
              {(block) => <Markdown text={fenced(block().text, block().language)} cacheKey={`${props.message.id}:${index()}`} />}
            </Match>
            <Match when={block.type === "table" && block}>
              {(block) => (
                <div data-component="markdown" data-slot="session-display-result-table">
                  <table>
                    <thead>
                      <tr>
                        <For each={block().columns}>
                          {(column) => (
                            <th>
                              <bdi dir="auto">{column.label}</bdi>
                            </th>
                          )}
                        </For>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={block().rows}>
                        {(row) => (
                          <tr>
                            <For each={block().columns}>
                              {(column) => (
                                <td>
                                  <DisplayCell
                                    cell={row[column.key]}
                                    openFile={props.openFile}
                                    openLabel={i18n.t("ui.sessionTimeline.display.openFile")}
                                  />
                                </td>
                              )}
                            </For>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              )}
            </Match>
          </Switch>
        )}
      </For>
    </section>
  )
}

function DisplayCell(props: {
  cell: SessionMessageDisplayCell | undefined
  openFile?: (path: string) => void
  openLabel: string
}) {
  const file = () => (typeof props.cell === "object" && props.cell !== null ? props.cell : undefined)
  return (
    <Show
      when={file()}
      fallback={
        <bdi dir="auto">{props.cell === null || props.cell === undefined ? "" : String(props.cell)}</bdi>
      }
    >
      {(file) => (
        <Show when={props.openFile} fallback={<code data-inline-code-kind="path">{file().path}</code>}>
          {(open) => (
            <button
              type="button"
              data-slot="session-display-result-file"
              title={props.openLabel}
              class="cursor-pointer text-start"
              onClick={() => open()(file().path)}
            >
              <code data-inline-code-kind="path" dir="ltr">
                {file().path}
              </code>
            </button>
          )}
        </Show>
      )}
    </Show>
  )
}

/** Renders code through Markdown's code blocks, with a fence longer than any backtick run in the text. */
function fenced(text: string, language: string | undefined) {
  const longest = text.split(/[^`]+/).reduce((max, run) => Math.max(max, run.length), 0)
  const fence = "`".repeat(Math.max(3, longest + 1))
  return fence + (language?.replace(/[^\w+#.-]/g, "") ?? "") + "\n" + text + "\n" + fence
}
