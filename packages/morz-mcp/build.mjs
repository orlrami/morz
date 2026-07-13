/*
 * Bundle the morz-mcp shim to ONE dependency-free CJS file so any CLI's node
 * can run it (`node dist/morz-mcp.cjs`). esbuild comes hoisted via the
 * electron-vite dep tree. Run from anywhere: `npm run build:mcp`.
 */
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [join(here, 'src/index.ts')],
  outfile: join(here, 'dist/morz-mcp.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info'
})
