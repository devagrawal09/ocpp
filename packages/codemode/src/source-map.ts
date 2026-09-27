export * as SourceMap from "./source-map.js"

import type { SourcePosition } from "./ir.js"

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/**
 * Maps a position in transpiled output back to the source it was transpiled from, given the
 * `mappings` of a version 3 source map. Positions are acorn's: a one-based line and a zero-based
 * column. A position on an output line that nothing in the source produced has no original.
 */
export function originalPosition(mappings: string): (position: SourcePosition) => SourcePosition | undefined {
  const lines = decode(mappings)
  return (position) => {
    const segments = lines[position.line - 1] ?? []
    // The transpiler maps each token it prints, and a token's text is copied from the source, so a
    // position inside a token keeps its offset from the token's start. A position before a line's
    // first token, such as indentation, belongs to that token.
    const segment = segments.findLast((item) => item.generated <= position.column) ?? segments[0]
    if (segment === undefined) return undefined
    return { line: segment.line + 1, column: segment.column + Math.max(0, position.column - segment.generated) }
  }
}

// `;` separates output lines and `,` separates segments. A segment is base64 VLQ numbers, each
// relative to the previous segment: the output column, then the source index, original line, and
// original column, and optionally a name index. Only the output column restarts on each line.
function decode(mappings: string) {
  let line = 0
  let column = 0
  return mappings.split(";").map((group) => {
    let generated = 0
    return group.split(",").flatMap((segment) => {
      if (segment === "") return []
      const fields = vlq(segment)
      generated += fields[0] ?? 0
      if (fields.length < 4) return []
      line += fields[2] ?? 0
      column += fields[3] ?? 0
      return [{ generated, line, column }]
    })
  })
}

function vlq(segment: string) {
  const values: number[] = []
  let value = 0
  let shift = 0
  for (const char of segment) {
    const digit = BASE64.indexOf(char)
    value += (digit & 31) << shift
    shift += 5
    if (digit & 32) continue
    values.push(value & 1 ? -(value >>> 1) : value >>> 1)
    value = 0
    shift = 0
  }
  return values
}
