/**
 * Emit the Host Typert reflection and the Client Remote contribution.
 *
 * The generator expects a workspace whose `packages/` project references own
 * the analyzed sources, and it recognizes `@Remote` only when the protocol
 * package is one of those projects. This repository is a single package, so
 * the script builds that small workspace in a temporary directory, analyzes a
 * copy of `src/`, and copies only the generated artifacts back into `lib/`.
 *
 * The generated files are committed with the other build output. The release
 * workflow never needs a DeepSeek Harness checkout.
 */
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = resolve(repo, '../../deepseek-harness')
const generatorEntry = join(harness, 'packages/typert/generator/lib/index.js')
const protocolSource = join(harness, 'packages/typert/protocol')
const brandSource = join(harness, 'packages/util/brand')
const packageName = 'dsh-pause-session'
const temp = mkdtempSync(join(tmpdir(), 'dsh-pause-typert-'))

/** Link one top-level dependency tree without copying it. */
function linkNodeModules(target, source) {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      const fromScope = join(source, entry.name)
      const toScope = join(target, entry.name)
      mkdirSync(toScope, { recursive: true })
      for (const child of readdirSync(fromScope, { withFileTypes: true })) {
        symlinkSync(join(fromScope, child.name), join(toScope, child.name), child.isDirectory() ? 'dir' : 'file')
      }
      continue
    }
    symlinkSync(join(source, entry.name), join(target, entry.name), entry.isDirectory() ? 'dir' : 'file')
  }
  const scopedBrand = join(target, '@deepseek-ai', 'dsh-brand')
  if (!readdirSync(join(target, '@deepseek-ai')).includes('dsh-brand')) {
    symlinkSync(brandSource, scopedBrand, 'dir')
  }
}

try {
  const app = join(temp, 'packages', packageName)
  const protocol = join(temp, 'packages', 'typert-protocol')
  mkdirSync(app, { recursive: true })
  mkdirSync(protocol, { recursive: true })
  mkdirSync(join(app, 'src'), { recursive: true })
  cpSync(join(repo, 'src/remote.ts'), join(app, 'src/remote.ts'))
  const manifest = {
    name: packageName,
    version: '0.0.0-generation',
    type: 'module',
    exports: {
      '.': { types: './lib/types/remote.d.ts', default: './lib/index.js' },
      './types': { types: './lib/types/remote.d.ts', default: './lib/types/remote.js' },
      './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
      './remote': { types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' },
      './package.json': './package.json',
    },
    files: [
      'lib/index.js', 'lib/types/remote.d.ts', 'lib/types/remote.js',
      'lib/typert.host.js', 'lib/typert.host.d.ts',
      'lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts',
    ],
  }
  writeFileSync(join(app, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(app, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      skipLibCheck: true, composite: true, declaration: true, outDir: 'lib/types', rootDir: 'src', types: ['node'],
    },
    include: ['src/remote.ts'],
  }, null, 2)}\n`)
  cpSync(join(protocolSource, 'src'), join(protocol, 'src'), { recursive: true })
  cpSync(join(protocolSource, 'package.json'), join(protocol, 'package.json'))

  const protocolConfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      composite: true,
      declaration: true,
      emitDeclarationOnly: true,
      allowImportingTsExtensions: true,
      outDir: 'lib/types',
      rootDir: 'src',
      types: ['node'],
    },
    include: ['src'],
  }
  writeFileSync(join(protocol, 'tsconfig.json'), `${JSON.stringify(protocolConfig, null, 2)}\n`)

  linkNodeModules(join(temp, 'node_modules'), join(repo, 'node_modules'))

  const hostConfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      composite: true,
      declaration: true,
      types: ['node'],
      paths: {
        '@deepseek-ai/dsh-typert-protocol': ['./packages/typert-protocol/src/index.ts'],
        '@deepseek-ai/dsh-typert-protocol/*': ['./packages/typert-protocol/src/*'],
      },
    },
    references: [
      { path: `./packages/typert-protocol/tsconfig.json` },
      { path: `./packages/${packageName}/tsconfig.json` },
    ],
  }
  writeFileSync(join(temp, 'tsconfig.host.json'), `${JSON.stringify(hostConfig, null, 2)}\n`)

  const { WorkspaceTypertGenerator, writePackageArtifacts } = await import(pathToFileURL(generatorEntry).href)
  const generator = new WorkspaceTypertGenerator(temp, { checkDiagnostics: false })
  const artifacts = generator.generate([packageName], ['host'])
  const artifact = artifacts.find(candidate => candidate.package === packageName)
  if (artifact === undefined) throw new Error(`typert generation emitted no host artifact for ${packageName}`)
  writePackageArtifacts(app, [artifact])

  const generated = join(app, 'lib')
  const output = join(repo, 'lib')
  mkdirSync(output, { recursive: true })
  for (const file of readdirSync(generated)) {
    if (!file.startsWith('typert.')) continue
    copyFileSync(join(generated, file), join(output, file))
  }
  console.log(`generate-typert: wrote ${artifact.remote === undefined ? 'host reflection' : 'host reflection and remote contribution'}`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
