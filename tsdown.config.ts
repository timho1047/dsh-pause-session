import { clientBundle, nodeBundle } from './tsdown.client.ts'

/**
 * Two build faces over the tsc-emitted `lib/types` tree (the official split:
 * tsc emits JavaScript plus declarations, tsdown bundles runtime):
 *
 * - node face:   `lib/types/index.js`        → `lib/index.js`  (host Loader entry)
 * - client face: `lib/types/client/index.js` → `lib/client.js` (ModuleLoader bundle,
 *   externals resolved through the browser module table)
 */
export default [
  ...nodeBundle('dsh-pause', ['lib/types/index.js']),
  clientBundle('dsh-pause', { entry: 'lib/types/client/index.js' }),
]
