import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Relative asset URLs, so the built demo also runs from a GitHub Pages sub-path.
  base: './',
  server: { port: 5174, strictPort: true },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
