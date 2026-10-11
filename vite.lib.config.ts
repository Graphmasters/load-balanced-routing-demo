import { defineConfig } from 'vite'

// The importable engine: one ES module without dependencies. The omt-router adapter reads that library's graph by
// shape and does not import it, so this bundle does not contain omt-router.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist/lib',
    emptyOutDir: true,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'route-sim.js',
    },
  },
})
