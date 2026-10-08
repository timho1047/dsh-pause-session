import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.{spec,e2e}.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
