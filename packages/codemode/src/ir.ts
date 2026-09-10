/** Version of the compiled representation. Persisted programs and durable functions record it. */
export const IR_VERSION = 1 as const

export type SourcePosition = {
  line: number
  column: number
}

export type SourceLocation = {
  start: SourcePosition
  end: SourcePosition
}

export type AstNode = {
  type: string
  loc?: SourceLocation
  [key: string]: unknown
}

export type ProgramNode = AstNode & {
  type: "Program"
  body: Array<AstNode>
}

/**
 * One compiled program. It is plain data: the compiler produces it, the runtime evaluates it, and a
 * host may persist it without either side reaching into the other.
 */
export type Program = {
  readonly version: typeof IR_VERSION
  /**
   * Canonical source of the compiled program. Node positions refer to it, and it is retained beside
   * the IR so a later compiler can recompile a persisted program instead of rejecting it.
   */
  readonly source: string
  readonly body: ProgramNode
  /** Names published to the durable notebook when the program succeeds, in declaration order. */
  readonly declarations: ReadonlyArray<string>
  /** Static compatibility notices discovered while compiling the source. */
  readonly warnings?: ReadonlyArray<{ readonly kind: "Compatibility"; readonly message: string }>
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export const isPromiseAllCall = (node: AstNode): boolean => {
  if (node.type !== "CallExpression" || !isRecord(node.callee) || node.callee.type !== "MemberExpression")
    return false
  if (!isRecord(node.callee.object) || node.callee.object.type !== "Identifier" || node.callee.object.name !== "Promise")
    return false
  return (
    node.callee.computed !== true &&
    isRecord(node.callee.property) &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "all"
  )
}

export type DecodedProgram =
  | { readonly ok: true; readonly program: Program }
  | { readonly ok: false; readonly message: string }

/**
 * The one boundary persisted IR crosses before execution. A host decodes a stored value here, and
 * the runtime evaluates only what this function accepted. Failure is data so an unsupported version
 * or a damaged row becomes a diagnostic rather than an interpreter defect.
 */
export const decodeProgram = (value: unknown): DecodedProgram => {
  if (!isRecord(value) || Array.isArray(value)) return { ok: false, message: "Compiled program is not a record." }
  if (value.version !== IR_VERSION)
    return {
      ok: false,
      message: `Compiled program version ${String(value.version)} is unsupported; expected ${IR_VERSION}.`,
    }
  if (typeof value.source !== "string") return { ok: false, message: "Compiled program is missing its source." }
  if (!Array.isArray(value.declarations) || value.declarations.some((name) => typeof name !== "string"))
    return { ok: false, message: "Compiled program has invalid declaration names." }
  if (
    value.warnings !== undefined &&
    (!Array.isArray(value.warnings) ||
      value.warnings.some(
        (warning) =>
          !isRecord(warning) || warning.kind !== "Compatibility" || typeof warning.message !== "string",
      ))
  )
    return { ok: false, message: "Compiled program has invalid warnings." }
  if (!isRecord(value.body) || value.body.type !== "Program" || !Array.isArray(value.body.body))
    return { ok: false, message: "Compiled program has an invalid body." }
  return { ok: true, program: value as unknown as Program }
}
