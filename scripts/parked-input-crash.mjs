// scripts/parked-input-crash.mjs — hard-kill probe for the "flush is the
// durability promise" premise. Append one pending user message through the
// chosen path, then SIGKILL this process without unwinding anything, so the
// parent can re-read the stored log and see what actually survived.
//
// Usage: node scripts/parked-input-crash.mjs <root> <mode> <sessionId>
//   handle-append                 explicit SessionHandle.append, no flush
//   handle-append-flush           explicit SessionHandle.append + handle.flush()
//   live-append                   session.append (routed live), no flush
//   live-append-handle-flush      live append + handle.flush()
//   live-append-session-flush     live append + sessions.flush(session)
//
// Exit is always SIGKILL; stdout carries one CRASH_READY line written
// synchronously so the parent can tell a completed append from a failure.

import { writeSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const [root, mode, rawId] = process.argv.slice(2)
if (root === undefined || mode === undefined || rawId === undefined) {
  console.error('usage: parked-input-crash.mjs <root> <mode> <sessionId>')
  process.exit(2)
}
const id = SessionId(rawId)

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
const session = ctx.sessions.create(id)
const handle = await ctx.sessionPersistence.create(session.header)
const message = createUserMessage({
  content: [{ type: 'text', text: 'pending while parked' }],
  source: { kind: 'user' },
})

if (mode === 'handle-append' || mode === 'handle-append-flush') {
  await handle.append([{ type: 'user/message', seq: 0, time: Date.now(), data: message, surfaceOp: 'append' }])
  if (mode === 'handle-append-flush') await handle.flush()
} else {
  session.append('user/message', message, { surfaceOp: 'append' })
  if (mode === 'live-append-handle-flush') await handle.flush()
  if (mode === 'live-append-session-flush') await ctx.sessions.flush(session)
}

writeSync(1, `CRASH_READY ${mode}\n`)
process.kill(process.pid, 'SIGKILL')
