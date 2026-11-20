// Collects runtime dependencies for @earendil-works/pi-coding-agent and
// @cortexkit/pi-magic-context into out/pi-runtime/node_modules so the packaged
// app keeps real on-disk files for dynamic ESM import(), jiti extension
// loading, worker threads, and ELECTRON_RUN_AS_NODE child processes.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const shellRoot = resolve(here, '..')
const repoRoot = resolve(shellRoot, '../..')
const rootModules = join(repoRoot, 'node_modules')
const outModules = join(shellRoot, 'out', 'pi-runtime', 'node_modules')

const SEEDS = ['@earendil-works/pi-coding-agent', '@cortexkit/pi-magic-context']
const SKIP_PACKAGES = new Set(['sharp', 'onnxruntime-node'])

function resolvePkg(name, from) {
  let dir = from
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const collected = new Map()

function walk(name, from) {
  if (SKIP_PACKAGES.has(name) || name.startsWith('@img/')) return
  const dir = resolvePkg(name, from)
  if (!dir) throw new Error(`pi-runtime deps: cannot resolve ${name} from ${from}`)
  if (collected.has(dir)) return
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  collected.set(dir, pkg.name || name)
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    walk(dep, dir)
  }
}

for (const seed of SEEDS) {
  walk(seed, shellRoot)
}

rmSync(outModules, { recursive: true, force: true })
mkdirSync(outModules, { recursive: true })

for (const [dir, pkgName] of collected.entries()) {
  const relFromRoot = relative(rootModules, dir)
  const relDest =
    !relFromRoot.startsWith('..') && !relFromRoot.includes(`..${sep}`)
      ? relFromRoot
      : pkgName
  cpSync(dir, join(outModules, relDest), {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const rel = relative(dir, src)
      if (!rel) return true
      const segments = rel.split(sep)
      if (segments.includes('node_modules')) return false
      if (rel.endsWith('.map')) return false
      return true
    },
  })
}

console.log(`pi-runtime deps: ${collected.size} packages -> ${relative(shellRoot, outModules)}`)
