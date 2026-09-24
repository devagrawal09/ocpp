import {
  type AstNode,
  type Binding,
  BrokenNotebookValue,
  brokenNotebookSuggestions,
  InterpreterRuntimeError,
} from "./model.js"

export class ScopeStack {
  private readonly scopes: Array<Map<string, Binding>>
  private readonly overrides: ReadonlyMap<Binding, Binding>

  constructor(scopes: Array<Map<string, Binding>>, overrides: ReadonlyMap<Binding, Binding> = new Map()) {
    this.scopes = scopes
    this.overrides = overrides
  }

  reserve(name: string, mutable: boolean, node: AstNode): void {
    const scope = this.current()
    if (scope.has(name)) {
      throw new InterpreterRuntimeError(`Identifier '${name}' has already been declared.`, node)
    }
    scope.set(name, { mutable, value: undefined, initialized: false })
  }

  initialize(name: string, value: unknown, node: AstNode): void {
    const binding = this.current().get(name)
    if (!binding || binding.initialized !== false) {
      throw new InterpreterRuntimeError(`Identifier '${name}' has not been reserved for initialization.`, node)
    }
    binding.value = value
    binding.initialized = true
  }

  declare(name: string, value: unknown, mutable: boolean, node: AstNode): void {
    const scope = this.current()
    if (scope.has(name)) {
      throw new InterpreterRuntimeError(`Identifier '${name}' has already been declared.`, node)
    }
    scope.set(name, { mutable, value, initialized: true })
  }

  get(name: string, node: AstNode): unknown {
    const binding = this.resolve(name)

    if (!binding) {
      throw new InterpreterRuntimeError(`Unknown identifier '${name}'.`, node).as("ReferenceError")
    }

    if (binding.initialized === false) {
      throw new InterpreterRuntimeError(`Cannot access '${name}' before initialization.`, node).as("ReferenceError")
    }

    // A stored value that failed to decode is quarantined until something actually reads it.
    if (binding.value instanceof BrokenNotebookValue) {
      throw new InterpreterRuntimeError(binding.value.message, node, "InvalidDurableValue", brokenNotebookSuggestions)
    }

    return binding.value
  }

  set(name: string, value: unknown, node: AstNode): unknown {
    const binding = this.resolve(name)

    if (!binding) {
      throw new InterpreterRuntimeError(`Unknown identifier '${name}'.`, node).as("ReferenceError")
    }

    if (binding.initialized === false) {
      throw new InterpreterRuntimeError(`Cannot access '${name}' before initialization.`, node).as("ReferenceError")
    }

    if (!binding.mutable) {
      throw new InterpreterRuntimeError(`Cannot assign to constant '${name}'.`, node).as("TypeError")
    }

    binding.value = value
    return value
  }

  resolve(name: string): Binding | undefined {
    for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
      const scope = this.scopes[index]
      const binding = scope?.get(name)

      if (binding) {
        return this.overrides.get(binding) ?? binding
      }
    }

    return undefined
  }

  current(): Map<string, Binding> {
    const scope = this.scopes[this.scopes.length - 1]

    if (!scope) {
      throw new InterpreterRuntimeError("Interpreter scope stack is empty.")
    }

    return scope
  }

  push(scope: Map<string, Binding> = new Map()): void {
    this.scopes.push(scope)
  }

  pop(): void {
    this.scopes.pop()
  }

  capture(): Array<Map<string, Binding>> {
    return [...this.scopes]
  }
}
