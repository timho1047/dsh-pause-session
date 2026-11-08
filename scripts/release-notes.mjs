/**
 * Extract one changelog section for a GitHub Release and remove manual line
 * wrapping. GitHub/CommonMark treats a single newline as a space inside a
 * paragraph/list item, but the rendered release should rely on the viewer's
 * width rather than the changelog's 80-column layout.
 *
 * Usage: node scripts/release-notes.mjs <vX.Y.Z> [CHANGELOG.md]
 */

import { readFile } from 'node:fs/promises'

const [versionArg, changelogPath = 'CHANGELOG.md'] = process.argv.slice(2)
if (versionArg === undefined) {
  console.error('usage: node scripts/release-notes.mjs <vX.Y.Z> [CHANGELOG.md]')
  process.exit(2)
}
const version = versionArg.replace(/^v/u, '')
const lines = (await readFile(changelogPath, 'utf8')).split('\n')
const start = lines.findIndex(line => line.startsWith(`## [${version}]`))
if (start < 0) {
  console.error(`release-notes: ${changelogPath} has no ## [${version}] section`)
  process.exit(1)
}
const end = lines.findIndex((line, at) => at > start && line.startsWith('## ['))
const section = lines.slice(start + 1, end < 0 ? undefined : end)

const output = []
let fenced = false
for (const line of section) {
  if (line.startsWith('```')) {
    fenced = !fenced
    output.push(line)
    continue
  }
  if (fenced) {
    output.push(line)
    continue
  }
  // A continuation line of a paragraph or list item. Keep nested list items
  // separate: they start with a list marker after their indentation.
  const nested = /^\s+(?:[-*+] |\d+\. )/u.test(line)
  if (!nested && /^\s+\S/u.test(line) && output.length > 0 && output.at(-1).trim() !== '') {
    output[output.length - 1] += ` ${line.trim()}`
    continue
  }
  output.push(line)
}
process.stdout.write(`${output.join('\n').trim()}\n`)
