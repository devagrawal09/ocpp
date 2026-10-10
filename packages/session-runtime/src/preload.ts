// Bun preload for every process that loads this package: the Specter packages it links must share
// OC++'s Effect. See single-effect.ts.
import { installSingleEffect } from "./single-effect.ts"

installSingleEffect()
