/**
 * Make sure the child processes can import the BUILT host entry.
 *
 * The children import `dsh-pause` from `lib/index.js` — the plugin's own
 * sources use `.js` specifiers for relative imports, which Node's type
 * stripping does not resolve — so a spec that runs before the artifact exists
 * has to build it. A fresh artifact is left alone on purpose: `verify` builds
 * before it tests, and several forked specs running tsc and tsdown over the
 * same output directory at once is a race with nothing to win.
 * @module dsh-pause/test/resume/build
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Modification time of the newest file under `directory`, or 0 when it is absent. */
function newestMtime(directory: string): number {
  let newest = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs)
  }
  return newest
}

/**
 * Build the host entry when it is missing or older than the sources it is built
 * from.
 */
export function ensureHostEntry(): void {
  const builtEntry = join(repositoryRoot, 'lib', 'index.js')
  let built = 0
  try {
    built = statSync(builtEntry).mtimeMs
  } catch {
    // Absent: build below.
  }
  if (built >= newestMtime(join(repositoryRoot, 'src'))) return
  const build = spawnSync('pnpm run build', {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: true,
    timeout: 120_000,
  })
  if (build.status !== 0) {
    throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`)
  }
}
