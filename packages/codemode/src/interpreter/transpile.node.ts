import { DiagnosticCategory, ModuleKind, ScriptTarget, flattenDiagnosticMessageText, transpileModule } from "typescript"

export interface TranspileResult {
  readonly outputText: string
  readonly error?: string
  /** One-based source position of the first error diagnostic, when the compiler reports one. */
  readonly location?: { readonly line: number; readonly column: number }
}

// Full TypeScript transpilation on node/bun runtimes.
export const transpile = (source: string): TranspileResult => {
  const transpiled = transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ScriptTarget.ESNext,
      module: ModuleKind.ESNext,
    },
  })
  const diagnostic = transpiled.diagnostics?.find((item) => item.category === DiagnosticCategory.Error)
  if (diagnostic) {
    const position =
      diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : undefined
    return {
      outputText: transpiled.outputText,
      error: flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      ...(position ? { location: { line: position.line + 1, column: position.character + 1 } } : {}),
    }
  }
  return { outputText: transpiled.outputText }
}
