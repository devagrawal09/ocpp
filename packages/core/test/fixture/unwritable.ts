import fs from "fs/promises"
import { $ } from "bun"

/**
 * Makes a directory unwritable for this process and returns what undoes it. Mode bits do not bind root, so
 * as root the directory is marked immutable too, where the filesystem supports it.
 */
export async function makeUnwritable(dir: string) {
  await fs.chmod(dir, 0o500)
  const immutable = process.getuid?.() === 0 && (await $`chattr +i ${dir}`.quiet().nothrow()).exitCode === 0
  return async () => {
    if (immutable) await $`chattr -i ${dir}`.quiet().nothrow()
    await fs.chmod(dir, 0o700)
  }
}
