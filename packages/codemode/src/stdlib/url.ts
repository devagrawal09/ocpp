import { type AstNode, InterpreterRuntimeError, UriFunction } from "../interpreter/model.js"
import type { SafeObject } from "../tool-runtime.js"
import { boundedData, coerceToString } from "./value.js"

/** URLs are plain data: parsing returns records and arrays, formatting returns strings. */
export const urlMethods = new Set(["parse", "format", "parseQuery", "formatQuery", "encode", "decode"])

const fail = (message: string, node: AstNode) =>
  new InterpreterRuntimeError(message, node, "InvalidDataValue").as("TypeError")

const record = (entries: ReadonlyArray<readonly [string, unknown]>): SafeObject =>
  Object.assign(Object.create(null) as SafeObject, Object.fromEntries(entries))

export const uriArgument = (value: unknown, label: string): string => coerceToString(boundedData(value, label))

export const invokeUriFunction = (ref: UriFunction, args: Array<unknown>, node: AstNode): string => {
  const value = uriArgument(args[0], `${ref.name} input`)
  try {
    switch (ref.name) {
      case "encodeURI":
        return encodeURI(value)
      case "encodeURIComponent":
        return encodeURIComponent(value)
      case "decodeURI":
        return decodeURI(value)
      case "decodeURIComponent":
        return decodeURIComponent(value)
    }
  } catch (error) {
    throw new InterpreterRuntimeError(
      `${ref.name} received malformed URI data: ${error instanceof Error ? error.message : String(error)}`,
      node,
    ).as("URIError")
  }
}

const text = (name: string, value: unknown, node: AstNode): string => {
  if (typeof value !== "string") throw fail(`url.${name} expects a string.`, node)
  return value
}

const queryEntries = (search: URLSearchParams) =>
  Array.from(search, ([name, value]) => record([["name", name] as const, ["value", value] as const]))

const entryList = (name: string, value: unknown, node: AstNode): Array<{ name: string; value: string }> => {
  const data = boundedData(value, `url.${name} query`)
  if (!Array.isArray(data)) throw fail(`url.${name} expects an array of { name, value } records.`, node)
  return data.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      throw fail(`url.${name} expects an array of { name, value } records.`, node)
    const entry = item as Record<string, unknown>
    if (typeof entry.name !== "string") throw fail(`url.${name} expects every query entry to have a string name.`, node)
    return { name: entry.name, value: entry.value === undefined ? "" : coerceToString(entry.value) }
  })
}

const formatQuery = (entries: ReadonlyArray<{ name: string; value: string }>) => {
  const search = new URLSearchParams()
  for (const entry of entries) search.append(entry.name, entry.value)
  return search.toString()
}

export const invokeUrlMethod = (name: string, args: Array<unknown>, node: AstNode): unknown => {
  switch (name) {
    case "parse": {
      const input = text("parse", args[0], node)
      const base = args[1] === undefined ? undefined : text("parse", args[1], node)
      const parsed = URL.parse(input, base)
      if (parsed === null) return null
      return record([
        ["href", parsed.href],
        ["scheme", parsed.protocol.replace(/:$/, "")],
        ["username", parsed.username],
        ["password", parsed.password],
        ["host", parsed.host],
        ["hostname", parsed.hostname],
        ["port", parsed.port],
        ["path", parsed.pathname],
        ["query", queryEntries(parsed.searchParams)],
        ["queryText", parsed.search.replace(/^\?/, "")],
        ["hash", parsed.hash.replace(/^#/, "")],
      ])
    }
    case "format": {
      const data = boundedData(args[0], "url.format input")
      if (data === null || typeof data !== "object" || Array.isArray(data))
        throw fail("url.format expects a record.", node)
      const parts = data as Record<string, unknown>
      const scheme = parts.scheme === undefined ? "https" : text("format", parts.scheme, node)
      const host =
        parts.host === undefined ? text("format", parts.hostname ?? "", node) : text("format", parts.host, node)
      if (host === "") throw fail("url.format expects a host or hostname.", node)
      const query =
        parts.query !== undefined
          ? formatQuery(entryList("format", parts.query, node))
          : parts.queryText === undefined
            ? ""
            : text("format", parts.queryText, node)
      const url = URL.parse(
        scheme +
          "://" +
          (parts.username === undefined || parts.username === ""
            ? ""
            : encodeURIComponent(text("format", parts.username, node)) +
              (parts.password === undefined || parts.password === ""
                ? ""
                : ":" + encodeURIComponent(text("format", parts.password, node))) +
              "@") +
          host +
          (parts.port === undefined || parts.port === "" ? "" : ":" + coerceToString(parts.port)) +
          (parts.path === undefined ? "" : text("format", parts.path, node)) +
          (query === "" ? "" : "?" + query) +
          (parts.hash === undefined || parts.hash === "" ? "" : "#" + text("format", parts.hash, node)),
      )
      if (url === null) throw fail("url.format could not build a URL from that record.", node)
      return url.href
    }
    case "parseQuery":
      return queryEntries(new URLSearchParams(text("parseQuery", args[0], node).replace(/^\?/, "")))
    case "formatQuery":
      return formatQuery(entryList("formatQuery", args[0], node))
    case "encode":
      return encodeURIComponent(text("encode", args[0], node))
    case "decode":
      try {
        return decodeURIComponent(text("decode", args[0], node))
      } catch {
        return null
      }
    default:
      throw new InterpreterRuntimeError(`url.${name} is not available.`, node)
  }
}
