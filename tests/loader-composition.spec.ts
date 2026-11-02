/**
 * Real Loader composition suite (community five-layer model, layer 4): an
 * independent process mounts the real Loader over a cordis.yml naming the
 * BUILT host entry, which is how the shipped artifact — not the sources — is
 * proven loadable in a real composition.
 *
 * The composition decides what the row proves, so the suite states both cases
 * plainly. A bare row registers the entry and stays PENDING: this plugin
 * injects six services, and a composition without them leaves its fiber
 * waiting rather than partly mounted. The second case mounts those services —
 * the same rows the shipped base bundle mounts — and asserts the entry's fiber
 * reaches ACTIVE, which is what "the plugin mounted" actually means. The
 * negative case guards both: if the Loader accepted an unloadable row, "it
 * composed" would stop meaning anything.
 * @module dsh-pause/test/loader-composition
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

/** One loaded row, as the runner reports it. */
interface LoadedRow {
  readonly id: string | null
  readonly name: string | null
  readonly state: string
}

/** The Loader entry id both compositions give the plugin row. */
const PLUGIN_ROW_ID = 'dsh-pause'

/** One cordis.yml naming a single plugin row. */
function configFor(pluginRow: string): string {
  return [`- id: ${PLUGIN_ROW_ID}`, `  name: ${JSON.stringify(pluginRow)}`, ''].join('\n')
}

/**
 * The services this plugin injects, mounted from the same packages the shipped
 * base bundle uses, plus the agent loop whose `turnBoundary` projection the
 * park predicate reads. Enough for the row to activate; nothing else.
 */
function servicesConfigFor(pluginRow: string, storageRoot: string, pluginConfig?: readonly string[]): string {
  return [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(storageRoot)}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    `- id: ${PLUGIN_ROW_ID}`,
    `  name: ${JSON.stringify(pluginRow)}`,
    ...pluginConfig ?? [],
    '',
  ].join('\n')
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

/** Run one composition and read the rows it mounted. */
function compose(configPath: string): LoadedRow[] {
  const evidence = runRunner(configPath)
  expect(evidence.status, `stdout:\n${evidence.stdout}\nstderr:\n${evidence.stderr}`).toBe(0)
  const marker = evidence.stdout.match(/DSH_LOADER_RESULT (.+)$/mu)
  expect(marker).not.toBeNull()
  return (JSON.parse(marker![1]!) as { rows: LoadedRow[] }).rows
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-pause-loader-'))

beforeAll(() => {
  // Build first so the composition exercises the shipped artifact: the
  // plain-Node built entry must load under the real Loader.
  const build = spawnSync('pnpm run build', {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: true,
    timeout: 120_000,
  })
  expect(build.status, `build failed:\n${build.stdout}\n${build.stderr}`).toBe(0)
}, 120_000)

describe('Loader composition', () => {
  it('registers the built host entry as a row, and leaves it pending without the services it injects', () => {
    const configPath = join(temporaryRoot, 'bare.yml')
    writeFileSync(configPath, configFor(pathToFileURL(builtEntry).href))
    const rows = compose(configPath)
    const pluginRow = rows.find(row => row.name === 'dsh-pause')
    expect(pluginRow, `the plugin row is missing from ${JSON.stringify(rows)}`).toBeDefined()
    expect(pluginRow?.id).toContain(PLUGIN_ROW_ID)
    // The honest reading of a bare composition: the entry resolved, its row
    // exists, and its fiber is waiting for the six services nobody provided.
    expect(pluginRow?.state).toBe('pending')
  })

  it('activates the same entry once the composition provides what it injects', () => {
    const configPath = join(temporaryRoot, 'services.yml')
    writeFileSync(configPath, servicesConfigFor(pathToFileURL(builtEntry).href, join(temporaryRoot, 'storages')))
    const rows = compose(configPath)
    const pluginRow = rows.find(row => row.name === 'dsh-pause')
    expect(pluginRow, `the plugin row is missing from ${JSON.stringify(rows)}`).toBeDefined()
    // Activated, not merely registered: the fiber's own state is the assertion
    // the bare case cannot make.
    expect(pluginRow?.state).toBe('active')
    expect(rows.filter(row => row.state === 'failed')).toEqual([])
  })

  it("fails the composition loudly when a row's config is not what the plugin accepts", () => {
    const configPath = join(temporaryRoot, 'bad-config.yml')
    writeFileSync(configPath, servicesConfigFor(
      pathToFileURL(builtEntry).href,
      join(temporaryRoot, 'storages'),
      ['  config:', '    silentWakeRoutes: not-an-array'],
    ))
    const evidence = runRunner(configPath)
    // The plugin's own schema is what the Loader applies, so a config it cannot
    // read fails the mount with the offending path instead of being ignored.
    expect(evidence.status, `stdout:\n${evidence.stdout}\nstderr:\n${evidence.stderr}`).not.toBe(0)
    expect(evidence.stderr).toContain('silentWakeRoutes')
  })

  it('fails loud when the configured row cannot be loaded', () => {
    const configPath = join(temporaryRoot, 'unloadable.yml')
    writeFileSync(configPath, configFor(pathToFileURL(join(temporaryRoot, 'absent-entry.js')).href))
    const evidence = runRunner(configPath)
    expect(evidence.status, `stdout:\n${evidence.stdout}\nstderr:\n${evidence.stderr}`).not.toBe(0)
  })
})

describe('shipped host artifact', () => {
  it('exposes a named function plugin, its config, and no default export', async () => {
    const module = await import(pathToFileURL(builtEntry).href) as Record<string, unknown>
    expect(module.name).toBe('dsh-pause')
    expect(typeof module.apply).toBe('function')
    expect(module.Config).toBeDefined()
    expect('default' in module).toBe(false)
  })
})

describe('teardown', () => {
  it('removes the temporary composition directory', () => {
    rmSync(temporaryRoot, { recursive: true, force: true })
  })
})
