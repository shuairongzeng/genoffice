#!/usr/bin/env node
/**
 * Verifies the compiled @genoffice/shell main bundle and optional packaged ASAR:
 * 1. Main entrypoint `apps/shell/out/main/index.js` exists and stays a thin loader (< 80 KB).
 * 2. Every external non-builtin `require()` across `apps/shell/out/main` resolves cleanly.
 * 3. When an ASAR path is given (or auto-discovered), parses its header, ensures all external
 *    packages resolve inside the ASAR, rejects stray `.map` files, and asserts size < 35 MB.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SHELL_DIR = join(ROOT, 'apps', 'shell')
const MAIN_OUT_DIR = join(SHELL_DIR, 'out', 'main')
const MAIN_ENTRY = join(MAIN_OUT_DIR, 'index.js')
const THIN_ENTRY_LIMIT_BYTES = 80 * 1024
const ASAR_SIZE_LIMIT_BYTES = 35 * 1024 * 1024
const ASAR_FILE_LIMIT = 1000

const args = process.argv.slice(2)
let asarArg = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--asar' && args[i + 1]) {
    asarArg = resolve(args[++i])
  }
}

function fail(message) {
  console.error(`[verify-shell-bundle] FAIL: ${message}`)
  process.exit(1)
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))
BUILTINS.add('electron')

function packageNameOf(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

// 1. Thin entrypoint check
if (!existsSync(MAIN_ENTRY)) {
  fail(`missing build artifact: ${MAIN_ENTRY} (run npm run build -w @genoffice/shell first)`)
}
const entryBytes = statSync(MAIN_ENTRY).size
console.log(
  `[verify-shell-bundle] main entry: ${(entryBytes / 1024).toFixed(1)} KB (limit ${THIN_ENTRY_LIMIT_BYTES / 1024} KB)`,
)
if (entryBytes > THIN_ENTRY_LIMIT_BYTES) {
  fail(
    `main entry grew to ${(entryBytes / 1024).toFixed(1)} KB; heavy modules were pulled back into the eager entry`,
  )
}

// 2. Scan external require() specifiers in out/main
const mainFiles = walkFiles(MAIN_OUT_DIR)
const externalSpecifiers = new Set()
const REQ_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
for (const file of mainFiles) {
  const src = readFileSync(file, 'utf8')
  for (const match of src.matchAll(REQ_RE)) {
    const spec = match[1]
    if (!spec || spec.startsWith('.') || spec.startsWith('/') || BUILTINS.has(spec)) continue
    externalSpecifiers.add(spec)
  }
}

const requireFromMain = createRequire(MAIN_ENTRY)
const missingWorkspace = []
for (const spec of externalSpecifiers) {
  try {
    requireFromMain.resolve(spec)
  } catch {
    missingWorkspace.push(spec)
  }
}
if (missingWorkspace.length > 0) {
  fail(`unresolvable external requires in workspace: ${missingWorkspace.join(', ')}`)
}
console.log(
  `[verify-shell-bundle] external requires (${externalSpecifiers.size}): ${[...externalSpecifiers].sort().join(', ')}`,
)

// 3. Optional ASAR audit
function parseAsar(asarPath) {
  const buf = readFileSync(asarPath)
  const headerSize = buf.readUInt32LE(12)
  const header = JSON.parse(buf.slice(16, 16 + headerSize).toString('utf8'))
  const files = []
  function walk(node, prefix) {
    if (node.files) {
      for (const [k, v] of Object.entries(node.files)) {
        walk(v, prefix ? `${prefix}/${k}` : k)
      }
    } else if (typeof node.size === 'number') {
      files.push({ path: prefix, size: node.size })
    }
  }
  walk(header, '')
  return { rawBytes: buf.length, files }
}

if (asarArg) {
  if (!existsSync(asarArg)) fail(`specified ASAR not found: ${asarArg}`)
  const { rawBytes, files } = parseAsar(asarArg)
  const fileSet = new Set(files.map((f) => f.path))
  const maps = files.filter((f) => f.path.endsWith('.map'))
  const topFiles = [...files].sort((a, b) => b.size - a.size).slice(0, 10)
  const asarMB = (rawBytes / 1048576).toFixed(2)

  console.log(`[verify-shell-bundle] ASAR: ${asarArg}`)
  console.log(`  size: ${asarMB} MB, files: ${files.length}`)
  console.log(
    '  largest files:\n' +
      topFiles.map((f) => `    ${(f.size / 1048576).toFixed(2)} MB  ${f.path}`).join('\n'),
  )

  if (maps.length > 0) {
    fail(`found ${maps.length} sourcemap files inside ASAR (first: ${maps[0].path})`)
  }
  if (rawBytes > ASAR_SIZE_LIMIT_BYTES) {
    fail(`ASAR size ${asarMB} MB exceeds ${(ASAR_SIZE_LIMIT_BYTES / 1048576).toFixed(0)} MB limit`)
  }
  if (files.length > ASAR_FILE_LIMIT) {
    fail(`ASAR file count ${files.length} exceeds ${ASAR_FILE_LIMIT} limit`)
  }

  // Verify every external package required by out/main exists inside the ASAR
  const missingInAsar = []
  for (const spec of externalSpecifiers) {
    const exactJs = `node_modules/${spec}.js`
    const pkgJson = `node_modules/${packageNameOf(spec)}/package.json`
    if (!fileSet.has(exactJs) && !fileSet.has(`node_modules/${spec}`) && !fileSet.has(pkgJson)) {
      missingInAsar.push(spec)
    }
  }
  if (missingInAsar.length > 0) {
    fail(`external require(s) missing inside ASAR node_modules: ${missingInAsar.join(', ')}`)
  }
}

console.log('[verify-shell-bundle] OK')
