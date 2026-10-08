/**
 * Real Loader composition suite (community five-layer model, layer 4): an
 * independent process mounts the real Loader over a cordis.yml naming the
 * BUILT host entry, which is how the shipped artifact — not the sources — is
 * proven loadable in a real composition. The negative case guards the
 * positive one: if the Loader accepted an unloadable row, "it composed"
 * would stop meaning anything.
 * @module dsh-safe-stop/test/loader-composition
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runner = join(repositoryRoot, 'scripts', 'loader-runner.mjs')
const builtEntry = join(repositoryRoot, 'lib', 'index.js')

/** One cordis.yml naming a single plugin row. */
function configFor(pluginRow: string): string {
  return [`- name: ${JSON.stringify(pluginRow)}`, ''].join('\n')
}

function runRunner(configPath: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [runner, configPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 120_000,
  })
  if (result.error !== undefined) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-safe-stop-loader-'))

beforeAll(() => {
  // Build first so the composition exercises the shipped artifact: the
  // plain-Node built entry must load under the real Loader.
  const build = spawnSync('pnpm', ['run', 'build'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 120_000,
  })
  expect(build.status, `build failed:\n${build.stdout}\n${build.stderr}`).toBe(0)
}, 120_000)

describe('Loader composition', () => {
  it('mounts the built host entry through the real Loader', () => {
    const configPath = join(temporaryRoot, 'valid.yml')
    writeFileSync(configPath, configFor(pathToFileURL(builtEntry).href))
    const evidence = runRunner(configPath)
    expect(evidence.status, `stdout:\n${evidence.stdout}\nstderr:\n${evidence.stderr}`).toBe(0)
    const marker = evidence.stdout.match(/DSH_LOADER_RESULT (.+)$/mu)
    expect(marker).not.toBeNull()
    const summary = JSON.parse(marker![1]!) as { mounted: number }
    expect(summary.mounted).toBeGreaterThan(0)
  })

  it('fails loud when the configured row cannot be loaded', () => {
    const configPath = join(temporaryRoot, 'unloadable.yml')
    writeFileSync(configPath, configFor(pathToFileURL(join(temporaryRoot, 'absent-entry.js')).href))
    const evidence = runRunner(configPath)
    expect(evidence.status, `stdout:\n${evidence.stdout}\nstderr:\n${evidence.stderr}`).not.toBe(0)
  })
})

describe('shipped host artifact', () => {
  it('exposes a named function plugin and no default export', async () => {
    const module = await import(pathToFileURL(builtEntry).href) as Record<string, unknown>
    expect(module.name).toBe('dsh-safe-stop')
    expect(typeof module.apply).toBe('function')
    expect('default' in module).toBe(false)
  })
})

describe('teardown', () => {
  it('removes the temporary composition directory', () => {
    rmSync(temporaryRoot, { recursive: true, force: true })
  })
})
