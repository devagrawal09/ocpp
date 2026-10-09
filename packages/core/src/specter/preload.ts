// Bun preload for every process that loads OC++ core: the Specter runtime it embeds must share OC++'s
// Effect. See single-effect.ts.
import { installSingleEffect } from "./single-effect.js"

installSingleEffect()
