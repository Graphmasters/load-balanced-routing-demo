import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Relative asset URLs, so the built demo also runs from a GitHub Pages sub-path.
  base: './',
  server: { port: 5174, strictPort: true },
  // Two pages: the static demo and the interactive mode. Both are built into dist/ for GitHub Pages.
  build: {
    rollupOptions: {
      input: { main: 'index.html', interactive: 'interactive.html' },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
