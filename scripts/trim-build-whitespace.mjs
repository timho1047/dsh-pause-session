// Keep committed build artifacts clean and free of the author's local paths.
// tsc emits a trailing space before some union declarations; Git rejects it.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'lib'
let changed = 0

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
      continue
    }
    if (!entry.isFile() || !/\.(?:js|map|d\.ts)$/u.test(entry.name)) continue
    const before = readFileSync(full, 'utf8')
    if (before.includes('/Users/')) {
      throw new Error(`build artifact ${full} contains an absolute user path`)
    }
    const after = before.replace(/[ \t]+$/gmu, '')
    if (after !== before) {
      writeFileSync(full, after)
      changed += 1
    }
  }
}

walk(root)
console.log(`trim-build-whitespace: cleaned ${changed} file(s)`)
