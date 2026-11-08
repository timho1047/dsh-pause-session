/**
 * The tiny builder surface generated Remote client codecs use in the browser.
 *
 * The Gateway validates every browser-to-host argument before dispatch, and
 * host-result values are produced by this plugin itself. The client therefore
 * needs the codec builder shape, not a second validating copy of Zod; this
 * shim keeps the generated contribution small and bundle-time only.
 * @module dsh-pause-session/client/zod-lite
 */

/** One chainable codec node; parsing is identity on the trusted client side. */
interface CodecNode {
  parse(value: unknown): unknown
  safeParse(value: unknown): { readonly success: true; readonly data: unknown }
  readonly(): CodecNode
  optional(): CodecNode
  describe(): CodecNode
}

/** Build one identity codec node. */
function node(): CodecNode {
  return {
    parse: value => value,
    safeParse: value => ({ success: true, data: value }),
    readonly() { return this },
    optional() { return this },
    describe() { return this },
  }
}

/** The `z` namespace the generated client contribution expects. */
export const z = {
  string: node,
  number: node,
  boolean: node,
  undefined: node,
  literal: node,
  union: node,
  array: node,
  record: node,
  object: node,
  strictObject: node,
  enum: node,
}
