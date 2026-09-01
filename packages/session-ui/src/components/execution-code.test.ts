import { expect, test } from "bun:test"
import { formatExecutionCode } from "./execution-code"

test("places top-level statements on separate lines", () => {
  expect(formatExecutionCode("const first = 1; const second = 2; return first + second")).toBe(
    "const first = 1;\nconst second = 2;\nreturn first + second",
  )
})

test("preserves semicolons in strings, comments, and loop headers", () => {
  expect(
    formatExecutionCode(
      'const text = "a; b"; for (let index = 0; index < 2; index++) console.log(index); // keep; here\nreturn text',
    ),
  ).toBe(
    'const text = "a; b";\nfor (let index = 0; index < 2; index++) console.log(index);\n// keep; here\nreturn text',
  )
})
