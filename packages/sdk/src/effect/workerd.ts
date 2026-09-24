export * as OcppWorkerd from "./workerd"

import { Layer } from "effect"
import type { Config, Scope } from "effect"
import { WorkerdProfile } from "../internal/workerd"
import { Ocpp } from "./ocpp"

export type Configuration = WorkerdProfile.Configuration

export interface CreateOptions extends WorkerdProfile.Options {
  readonly log?: Ocpp.CreateOptions["log"]
  readonly workspaceProviders?: Ocpp.CreateOptions["workspaceProviders"]
}

export const create = ({ log, workspaceProviders, ...options }: CreateOptions) => {
  const profile = WorkerdProfile.make(options)
  return Ocpp.create({ ...profile.options, log, workspaceProviders }, { overrides: profile.replacements })
}

export const layer = (options: CreateOptions): Layer.Layer<Ocpp.Service, Config.ConfigError | Error> =>
  Layer.effect(Ocpp.Service, create(options))

export type Interface = Ocpp.Interface
export type Requirements = Scope.Scope
