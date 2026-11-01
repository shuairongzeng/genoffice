import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// @genoffice/i18n and @genoffice/electron-utils ship as TS source — must be bundled
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@genoffice/i18n', '@genoffice/electron-utils'] })],
    build: { minify: 'esbuild' },
  },
  preload: {
    // same bundling requirement as main (see comment above). Two entries, and
    // they deliberately share no module: a shared module would be code-split
    // into a common chunk, and the page view's sandboxed preload cannot
    // require('./chunks/…') — hence the page entry's own channel copy
    // (src/preload/annotate/channels.ts, pinned by test)
    plugins: [externalizeDepsPlugin({ exclude: ['@genoffice/i18n', '@genoffice/electron-utils'] })],
    build: {
      minify: 'esbuild',
      rollupOptions: {
        input: {
          // the chrome view's bridge
          index: resolve(__dirname, 'src/preload/index.ts'),
          // the page view's annotation layer (isolated-world overlay)
          'page-annotate': resolve(__dirname, 'src/preload/page-annotate.ts'),
        },
      },
    },
  },
  renderer: {
    build: { minify: 'esbuild' },
    server: {
      port: Number(process.env.BROWSER_DEV_PORT) || 5179,
      strictPort: Boolean(process.env.BROWSER_DEV_PORT),
    },
  },
})
