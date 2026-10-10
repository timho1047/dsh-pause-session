# dsh-safe-stop

Stop every running DSH session — and its subagents — at a safe point before you
leave, then resume them the next morning as if nothing was interrupted.

**Status: walking skeleton.** The bundle installs and mounts, and the session
header renders this plugin's control. The control is inert: the pause gate, the
park registry and the resume path are not implemented yet.

## Install

Install the bundle into the target profile through the Web sidebar's **Plugins**
page, or with the `plugin_manager` tool (`install_bundle`, `target` = the
absolute path of this directory) from a session running in that profile.
Installation adds the package, selects the bundle and activates it.

## Uninstall

Remove the bundle from the same Plugins page, or with `plugin_manager`
(`remove_bundle`, `target` = `dsh-safe-stop`). The session header loses the
control and no other part of the profile changes.

## Develop

```sh
pnpm install
pnpm run verify     # typecheck + build + tests
pnpm run build      # tsc (both faces) then tsdown bundles lib/index.js and lib/client.js
```

The host half builds to `lib/index.js` and is loaded by the Loader; the client
half builds to `lib/client.js`, the `window.__ModuleLoader__` bundle the browser
loads with the id `dsh-safe-stop`. `tsdown.client.ts` is the vendored
client-bundle preset shared by the plugins in this directory.

## Design record

The spec and the task breakdown live under `.scratch/safe-stop/`, which is
local-only by this directory's convention.

The load-bearing findings behind the design — where a safe point actually is,
what a pause costs the surrounding app, and what a restart does to a parked
session — are recorded in the spec's evidence section. Read it before changing
the pause or resume path.

[REHEARSAL.md](REHEARSAL.md) is the end-to-end acceptance run: precedence for
what the automated suite already proves, how to install, the steps to walk, and
the rollback if the profile will not start.
