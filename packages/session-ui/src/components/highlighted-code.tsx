import { createResource, createUniqueId, For, onCleanup } from "solid-js"
import { disposeStreamingCode, highlightStreamingCode } from "./markdown-worker"
import type { MarkdownToken } from "./markdown-worker-protocol"

export function HighlightedCode(props: { code: string; language: string }) {
  const key = "highlighted-code:" + createUniqueId()
  const [highlighted] = createResource(
    () => ({ code: props.code, language: props.language }),
    async (source) => {
      try {
        return await highlightStreamingCode(key, source.code, source.language, true)
      } catch {
        return {
          id: 0,
          generation: 0,
          language: source.language,
          stable: [[source.code, ""] satisfies MarkdownToken],
          unstable: [],
        }
      }
    },
  )
  const tokens = () => {
    const current = highlighted()
    return current ? [...current.stable, ...current.unstable] : ([[props.code, ""]] satisfies MarkdownToken[])
  }

  onCleanup(() => disposeStreamingCode(key))

  return (
    <pre data-component="highlighted-code">
      <code class={`language-${highlighted()?.language ?? props.language}`}>
        <For each={tokens()}>{(token) => <span style={token[1]}>{token[0]}</span>}</For>
      </code>
    </pre>
  )
}
