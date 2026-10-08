// scripts/loader-runner.mjs — real Loader composition runner (community
// five-layer model, layer 4). An independent process boots a real Context,
// mounts the vendored Loader with the Include builtin, reads the given
// cordis.yml (the built plugin row), and reports what mounted.
//
// Usage: node scripts/loader-runner.mjs <cordis.yml>
// Exit 0 prints DSH_LOADER_RESULT <json>; a load failure exits non-zero with
// the reason on stderr, which is what makes the "cannot be loaded" regression
// meaningful.

import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const configArgument = process.argv[2]
if (configArgument === undefined) {
  console.error('usage: loader-runner.mjs <cordis.yml>')
  process.exit(2)
}

const configPath = resolve(configArgument)
// Resolve bare package rows from this repository's dependency tree so the
// composition works with config files written anywhere (e.g. a temp dir).
const configRequire = createRequire(resolve(import.meta.dirname, '../package.json'))

const ctx = new Context()
try {
  ctx.baseUrl = `${pathToFileURL(dirname(configPath)).href}/`
  await ctx.plugin(Loader)
  ctx.loader.internal = /** @type {any} */ ({
    version: 'v2',
    async import(specifier) {
      if (specifier.startsWith('file:')) return import(specifier)
      if (specifier.startsWith('node:')) return import(specifier)
      const absolute = /^([a-zA-Z]:)?[\\/]/u.test(specifier)
      return import(pathToFileURL(absolute ? specifier : configRequire.resolve(specifier)).href)
    },
  })
  ctx.loader.builtins.include = Include
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()

  // Every mounted plugin, root and Loader rows alike, is a registry runtime
  // holding one fiber per `ctx.plugin()` call. The rows are reported with the
  // Loader entry id and each fiber's lifecycle state, so a caller can tell
  // "composed" from "composed nothing" AND "activated" from "still waiting for
  // the services it injects"; identity assertions belong to the spec that knows
  // the entry. FiberState is a const enum, so the names are listed here.
  const FIBER_STATE = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading']
  const rows = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers].map(fiber => ({
    id: fiber.entry?.id ?? fiber.entry?.options?.name ?? null,
    name: typeof runtime.name === 'string' ? runtime.name : null,
    state: FIBER_STATE[fiber.state] ?? String(fiber.state),
  })))
  process.stdout.write(`DSH_LOADER_RESULT ${JSON.stringify({ mounted: rows.length, rows })}\n`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
} finally {
  await ctx.fiber.dispose()
}
