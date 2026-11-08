# Development

This is a personal DSH plugin repository. `dsh-plugins/` is not part of the
official DSH source tree; it is only the author's local layout.

## Layout

- `src/` — host-half TypeScript: pause gate, park registry, resume path,
  triage, and host services.
- `src/client/` — Web client TypeScript/React: the session control, global
  control, state mapping, and locale dictionaries.
- `lib/` — committed build output. Run `pnpm run build` to refresh it before a
  release commit.
- `.scratch/pause-session/` — local-only design record (ignored by Git).
- `REHEARSAL.md` — the manual end-to-end acceptance run.

## DSH dependency links

The development dependencies in [package.json](package.json) point at a
DeepSeek Harness checkout through `link:../../deepseek-harness/...`. Local
typecheck, build, and tests expect that checkout to be present at the same
relative depth.

The published npm packages currently lag the APIs this plugin uses
(`0.2.2-alpha.2`), so replacing these links with registry versions would break
the build. A fresh clone can run `pnpm pack` (the release path does not install
dependencies), but cannot run the full verification suite without the harness
checkout.

## Native Remote transport

`src/remote.ts` is the generated Remote surface. Its `observe` stream carries
status snapshots and its `act` / `triage` / `decide` methods carry every button
action. The Client mounts the generated contribution (`dsh-pause-session/remote`)
and consumes the namespace through a child injection; the same Gateway path is
used on Web and Desktop. No slash command is registered anywhere.

The client build aliases the generated contribution's `zod` import to
`src/client/zod-lite.ts`: the Gateway validates browser-to-host arguments, and
host results are produced by this plugin, so the browser keeps only the codec
builder shape. The client bundle stays around 20 KB gzip instead of pulling the
full codec runtime.

`scripts/generate-typert.mjs` builds a temporary Typert workspace containing
this Remote service and the Harness protocol source, then commits the generated
`lib/typert.*` artifacts beside the other build output. The release workflow
never needs a Harness checkout. The tests drive the same native namespace via
`tests/native-driver.ts`; no command-shaped test compatibility surface remains.

## Build and test

```sh
pnpm install
pnpm run verify     # typecheck + build + tests
pnpm run build      # tsc for both faces, then tsdown
```

The host half builds to `lib/index.js`; the client half builds to
`lib/client.js`, the browser module bundle loaded under the `dsh-pause-session` id.
`tsdown.client.ts` is the vendored client-bundle preset shared by the plugins
in this directory.

## Design record

The specification and task breakdown live under `.scratch/pause-session/`, local-only
by this directory's convention. The load-bearing findings behind the design —
where a pause can land, what a pause costs the surrounding app, and what a
restart does to a paused session — are recorded in the spec's evidence section.
Read it before changing the pause or resume path.

## Manual acceptance

[REHEARSAL.md](REHEARSAL.md) is the end-to-end acceptance run: precedence for
what the automated suite already proves, how to install, the steps to walk, and
the rollback if a profile will not start.
