export * as File from "./file.js"

import { FileDiff } from "@ocpp/schema/file-diff"

export const Diff = FileDiff.Info
export type Diff = typeof Diff.Type
