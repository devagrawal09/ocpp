import { DiagnosticCategory, ModuleKind, ScriptTarget, flattenDiagnosticMessageText, transpileModule } from "typescript"

export interface TranspileResult {
  readonly outputText: string
  readonly error?: string
  /** One-based source position of the first error diagnostic, when the compiler reports one. */
  readonly location?: { readonly line: number; readonly column: number }
  /** Source map `mappings` from `outputText` back to the source, when the output was re-printed. */
  readonly mappings?: string
}

// Full TypeScript transpilation on node/bun runtimes. The printer re-lays out the program, so its
// source map is the only way back from an output position to the line the author wrote.
export const transpile = (source: string): TranspileResult => {
  const transpiled = transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ScriptTarget.ESNext,
      module: ModuleKind.ESNext,
      sourceMap: true,
    },
  })
  const diagnostic = transpiled.diagnostics?.find((item) => item.category === DiagnosticCategory.Error)
  // The map travels in the result, so the output drops the trailing comment that would name its file.
  const outputText = transpiled.outputText.replace(/\/\/# sourceMappingURL=\S*$/, "")
  if (diagnostic) {
    const position =
      diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : undefined
    return {
      outputText,
      error: flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      ...(position ? { location: { line: position.line + 1, column: position.character + 1 } } : {}),
    }
  }
  if (transpiled.sourceMapText === undefined) return { outputText }
  // The map is TypeScript's own output, so its shape is known.
  return { outputText, mappings: (JSON.parse(transpiled.sourceMapText) as { readonly mappings: string }).mappings }
}
