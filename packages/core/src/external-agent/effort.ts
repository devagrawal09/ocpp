export * as ExternalAgentEffort from "./effort.js"

import { Schema } from "effect"

/** Reasoning efforts each vendor SDK accepts, selected as model variants. */
export const claude = Schema.Literals(["low", "medium", "high", "xhigh", "max"])
export const codex = Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"])
export const pi = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
