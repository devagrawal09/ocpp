export function formatExecutionCode(code: string) {
  const output: string[] = []
  let mode: "code" | "single" | "double" | "template" | "line-comment" | "block-comment" = "code"
  let escaped = false
  let parentheses = 0

  for (let index = 0; index < code.length; index++) {
    const character = code[index]!
    const next = code[index + 1]
    output.push(character)

    if (mode === "line-comment") {
      if (character === "\n") mode = "code"
      continue
    }
    if (mode === "block-comment") {
      if (character === "*" && next === "/") {
        output.push(next)
        index++
        mode = "code"
      }
      continue
    }
    if (mode !== "code") {
      if (escaped) {
        escaped = false
        continue
      }
      if (character === "\\") {
        escaped = true
        continue
      }
      if (
        (mode === "single" && character === "'") ||
        (mode === "double" && character === '"') ||
        (mode === "template" && character === "`")
      )
        mode = "code"
      continue
    }

    if (character === "/" && next === "/") {
      output.push(next)
      index++
      mode = "line-comment"
      continue
    }
    if (character === "/" && next === "*") {
      output.push(next)
      index++
      mode = "block-comment"
      continue
    }
    if (character === "'") {
      mode = "single"
      continue
    }
    if (character === '"') {
      mode = "double"
      continue
    }
    if (character === "`") {
      mode = "template"
      continue
    }
    if (character === "(") {
      parentheses++
      continue
    }
    if (character === ")") {
      parentheses = Math.max(0, parentheses - 1)
      continue
    }
    if (character !== ";" || parentheses > 0) continue

    const remainder = code.slice(index + 1).match(/^[ \t]*/)?.[0].length ?? 0
    index += remainder
    const following = code[index + 1]
    if (following !== undefined && following !== "\n" && following !== "\r") output.push("\n")
  }

  return output.join("")
}
