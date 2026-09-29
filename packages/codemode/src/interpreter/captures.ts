import { asNode, getArray, getNode, getString, isRecord, type AstNode } from "./model.js"

export const collectPatternNames = (pattern: AstNode, out: Array<string> = []): Array<string> => {
  switch (pattern.type) {
    case "Identifier":
      out.push(getString(pattern, "name"))
      break
    case "AssignmentPattern":
      collectPatternNames(getNode(pattern, "left"), out)
      break
    case "RestElement":
      collectPatternNames(getNode(pattern, "argument"), out)
      break
    case "ArrayPattern":
      for (const element of getArray(pattern, "elements")) {
        if (element !== null) collectPatternNames(asNode(element, "elements"), out)
      }
      break
    case "ObjectPattern":
      for (const property of getArray(pattern, "properties")) {
        const prop = asNode(property, "properties")
        collectPatternNames(prop.type === "RestElement" ? getNode(prop, "argument") : getNode(prop, "value"), out)
      }
      break
  }
  return out
}

const cache = new WeakMap<AstNode, ReadonlyArray<string>>()

/**
 * Names a function body reads from its enclosing scopes. Durable functions snapshot exactly these
 * bindings, so the analysis follows lexical scoping precisely: over-reporting would capture values
 * that do not exist, and under-reporting would leave a saved closure resolving names later.
 */
export const freeIdentifiers = (fn: AstNode): ReadonlyArray<string> => {
  const cached = cache.get(fn)
  if (cached) return cached
  const free = new Set<string>()
  const scopes: Array<Set<string>> = []

  const bindName = (name: string) => scopes[scopes.length - 1]?.add(name)
  const declarePattern = (pattern: AstNode) => {
    for (const name of collectPatternNames(pattern)) bindName(name)
  }
  const bound = (name: string) => scopes.some((scope) => scope.has(name))

  const hoist = (statements: ReadonlyArray<unknown>) => {
    for (const value of statements) {
      if (!isRecord(value) || typeof value.type !== "string") continue
      const statement = value as AstNode
      if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
        const id = statement.id
        if (isRecord(id) && typeof id.name === "string") bindName(id.name)
        continue
      }
      if (statement.type !== "VariableDeclaration") continue
      for (const item of getArray(statement, "declarations"))
        declarePattern(getNode(asNode(item, "declarations"), "id"))
    }
  }

  const scoped = (declarations: () => void, body: () => void) => {
    scopes.push(new Set())
    declarations()
    body()
    scopes.pop()
  }

  const walkFunction = (node: AstNode) => {
    scoped(
      () => {
        const id = node.id
        if (node.type === "FunctionExpression" && isRecord(id) && typeof id.name === "string") bindName(id.name)
        for (const parameter of getArray(node, "params")) declarePattern(asNode(parameter, "params"))
      },
      () => {
        for (const parameter of getArray(node, "params")) walk(asNode(parameter, "params"))
        walk(getNode(node, "body"))
      },
    )
  }

  const children = (node: AstNode) => {
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc") continue
      if (Array.isArray(value)) {
        for (const item of value) if (isRecord(item) && typeof item.type === "string") walk(item as AstNode)
        continue
      }
      if (isRecord(value) && typeof value.type === "string") walk(value as AstNode)
    }
  }

  const walk = (node: AstNode): void => {
    switch (node.type) {
      case "Identifier": {
        const name = getString(node, "name")
        if (!bound(name)) free.add(name)
        return
      }
      case "MemberExpression":
        walk(getNode(node, "object"))
        if (node.computed === true) walk(getNode(node, "property"))
        return
      case "Property":
        if (node.computed === true) walk(getNode(node, "key"))
        walk(getNode(node, "value"))
        return
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        walkFunction(node)
        return
      case "VariableDeclaration":
        for (const value of getArray(node, "declarations")) {
          const declaration = asNode(value, "declarations")
          const id = getNode(declaration, "id")
          declarePattern(id)
          // Destructuring defaults are expressions evaluated in the enclosing scope.
          if (id.type !== "Identifier") children(id)
          if (declaration.init !== undefined && declaration.init !== null) walk(asNode(declaration.init, "init"))
        }
        return
      case "BlockStatement":
      case "StaticBlock":
        scoped(
          () => hoist(getArray(node, "body")),
          () => children(node),
        )
        return
      case "ForStatement":
      case "ForOfStatement":
      case "ForInStatement":
        scoped(
          () => {
            const head = node.type === "ForStatement" ? node.init : node.left
            if (isRecord(head) && head.type === "VariableDeclaration") hoist([head])
          },
          () => children(node),
        )
        return
      case "CatchClause":
        scoped(
          () => {
            if (isRecord(node.param)) declarePattern(node.param as AstNode)
          },
          () => walk(getNode(node, "body")),
        )
        return
      case "LabeledStatement":
        walk(getNode(node, "body"))
        return
      case "BreakStatement":
      case "ContinueStatement":
        return
      default:
        children(node)
    }
  }

  walkFunction(fn)
  const names = [...free].sort()
  cache.set(fn, names)
  return names
}
