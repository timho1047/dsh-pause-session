import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.{spec,e2e}.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The child-process crash/restart suites can outlive Vitest's worker RPC
    // heartbeat when files run in parallel; one fork keeps their process trees
    // isolated from the reporter link.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
