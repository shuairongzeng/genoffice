#!/usr/bin/env node
/**
 * Startup benchmark & zero-white-frame gate for @genoffice/shell.
 * Spawns the app with an isolated temporary userData directory, records
 * main-process telemetry (`GENOFFICE_BOOT_TELEMETRY=1`) alongside live CDP
 * probes for the splash page and Home shell DOM, and verifies zero white-frame
 * exposure (`whiteFrameMs === 0`).
 *
 * Usage:
 *   node tools/bench-startup.mjs [--runs 3] [--exe <path-to-GenOffice.exe>] [--timeout 20000]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'

const ROOT = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)

let runs = 3
let exePath = null
let timeoutMs = 20_000
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--runs' && args[i + 1]) runs = Number(args[++i])
  else if (args[i] === '--exe' && args[i + 1]) exePath = resolve(args[++i])
  else if (args[i] === '--timeout' && args[i + 1]) timeoutMs = Number(args[++i])
}

if (!Number.isInteger(runs) || runs < 1) {
  console.error(`Invalid --runs value: ${runs}`)
  process.exit(2)
}

const electronExe = resolve(ROOT, 'node_modules/electron/dist/electron.exe')
const targetCmd = exePath ?? electronExe
const targetArgs = exePath ? [] : [resolve(ROOT, 'apps/shell')]

if (!existsSync(targetCmd)) {
  console.error(`Executable not found: ${targetCmd}`)
  process.exit(1)
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid]
}

async function runSample(index) {
  const ud = mkdtempSync(join(tmpdir(), `genoffice-bench-${index}-`))
  const t0 = Date.now()
  const spawnArgs = [...targetArgs, '--remote-debugging-port=0', `--user-data-dir=${ud}`]
  const child = spawn(targetCmd, spawnArgs, {
    env: {
      ...process.env,
      GENOFFICE_USER_DATA: ud,
      GENOFFICE_BOOT_TELEMETRY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let port = null
  let telemetry = null
  let cdpSplashAt = null
  let cdpShellPageAt = null
  let cdpHomeDomAt = null
  let ws = null
  let finished = false
  let stdoutBuf = ''

  return await new Promise((resolveRun, rejectRun) => {
    const cleanup = async () => {
      if (finished) return
      finished = true
      clearInterval(pollTimer)
      clearTimeout(timeoutTimer)
      try {
        ws?.close()
      } catch {}
      try {
        child.kill()
      } catch {}
      await new Promise((r) => setTimeout(r, 300))
      try {
        rmSync(ud, { recursive: true, force: true })
      } catch {}
    }

    const maybeFinish = async () => {
      if (finished) return
      if (telemetry && cdpHomeDomAt !== null) {
        await cleanup()
        resolveRun({
          run: index + 1,
          telemetry,
          cdpSplashAt,
          cdpShellPageAt,
          cdpHomeDomAt,
        })
      }
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString()
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop() ?? ''
      for (const line of lines) {
        const marker = '[GENOFFICE_BOOT_TELEMETRY] '
        const idx = line.indexOf(marker)
        if (idx !== -1) {
          try {
            telemetry = JSON.parse(line.slice(idx + marker.length).trim())
            void maybeFinish()
          } catch {}
        }
      }
    })

    child.stderr.on('data', (chunk) => {
      if (port) return
      const m = chunk.toString().match(/ws:\/\/127\.0\.0\.1:(\d+)\//)
      if (m) port = Number(m[1])
    })

    child.on('exit', (code) => {
      if (!finished) {
        void cleanup().then(() =>
          rejectRun(new Error(`run ${index + 1} exited early with code ${code}`)),
        )
      }
    })

    let probingMain = false
    const pollTimer = setInterval(async () => {
      if (!port || finished) return
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json`)
        const pages = await res.json()
        const splashTarget = pages.find(
          (p) => p.type === 'page' && typeof p.url === 'string' && p.url.startsWith('data:text/html'),
        )
        if (splashTarget && cdpSplashAt === null) {
          cdpSplashAt = Date.now() - t0
        }
        const shellTarget = pages.find(
          (p) =>
            p.type === 'page' &&
            typeof p.url === 'string' &&
            p.url.includes('index.html') &&
            !p.url.includes('view='),
        )
        if (shellTarget && cdpShellPageAt === null) {
          cdpShellPageAt = Date.now() - t0
        }
        if (shellTarget && !probingMain) {
          probingMain = true
          ws = new WebSocket(shellTarget.webSocketDebuggerUrl)
          let evalId = 1
          ws.on('open', () => {
            const evalTimer = setInterval(() => {
              if (finished || ws.readyState !== WebSocket.OPEN) {
                clearInterval(evalTimer)
                return
              }
              ws.send(
                JSON.stringify({
                  id: evalId++,
                  method: 'Runtime.evaluate',
                  params: {
                    expression:
                      'JSON.stringify({rootLen:(document.getElementById("root")||{}).innerHTML?.length||0,hasHome:!!document.querySelector(".home,.app-frame,.desktop-view,.onboarding")})',
                  },
                }),
              )
            }, 35)
          })
          ws.on('message', (raw) => {
            try {
              const msg = JSON.parse(raw.toString())
              const val = msg.result?.result?.value
              if (!val) return
              const parsed = JSON.parse(val)
              if (parsed.hasHome && parsed.rootLen > 200 && cdpHomeDomAt === null) {
                cdpHomeDomAt = Date.now() - t0
                void maybeFinish()
              }
            } catch {}
          })
        }
      } catch {}
    }, 30)

    const timeoutTimer = setTimeout(() => {
      void cleanup().then(() =>
        rejectRun(
          new Error(
            `run ${index + 1} timed out after ${timeoutMs}ms (telemetry=${Boolean(telemetry)}, homeDom=${cdpHomeDomAt})`,
          ),
        ),
      )
    }, timeoutMs)
  })
}

const results = []
for (let i = 0; i < runs; i++) {
  const sample = await runSample(i)
  results.push(sample)
  const t = sample.telemetry
  console.log(
    `Run ${sample.run}: T_splash=${t.tSplashShown ?? 'n/a'}ms | T_core=${t.tCoreLoaded ?? 'n/a'}ms | T_readyToShow=${t.tShellReadyToShow ?? 'n/a'}ms | T_firstPaint=${t.tFirstPaintReady ?? 'n/a'}ms | T_reveal=${t.tShellRevealed ?? 'n/a'}ms | cdpHome=${sample.cdpHomeDomAt}ms | whiteFrame=${t.whiteFrameMs}ms (${t.revealReason})`,
  )
}

const splashTimes = results.map((r) => r.telemetry.tSplashShown).filter((v) => typeof v === 'number')
const revealTimes = results.map((r) => r.telemetry.tShellRevealed).filter((v) => typeof v === 'number')
const homeDomTimes = results.map((r) => r.cdpHomeDomAt).filter((v) => typeof v === 'number')
const maxWhiteFrame = Math.max(
  ...results.map((r) =>
    typeof r.telemetry.whiteFrameMs === 'number' ? r.telemetry.whiteFrameMs : 9999,
  ),
)

const baselineHomeMs = exePath ? 1343 : 2318
const medHome = median(homeDomTimes)
const deltaPct = (((baselineHomeMs - medHome) / baselineHomeMs) * 100).toFixed(1)

console.log('\n=== Startup Benchmark Summary ===')
console.log(`Target: ${exePath ? 'Packaged GenOffice.exe' : 'Unpacked apps/shell'}`)
console.log(`Median T_splash_ms:     ${splashTimes.length ? median(splashTimes) + ' ms' : 'N/A'}`)
console.log(`Median T_reveal_ms:     ${revealTimes.length ? median(revealTimes) + ' ms' : 'N/A'}`)
console.log(`Median T_home_dom_ms:   ${medHome} ms (baseline: ${baselineHomeMs} ms, improvement: ${deltaPct}%)`)
console.log(`Max white_frame_ms:     ${maxWhiteFrame} ms`)

if (splashTimes.length === 0) {
  console.error('FAIL: tSplashShown telemetry was never recorded')
  process.exit(1)
}
const nonReady = results.filter((r) => r.telemetry.revealReason !== 'ready')
if (nonReady.length > 0) {
  console.error(
    `FAIL: expected revealReason === 'ready', got ${nonReady.map((r) => r.telemetry.revealReason).join(', ')}`,
  )
  process.exit(1)
}
if (maxWhiteFrame > 0) {
  console.error(`FAIL: white_frame_ms (${maxWhiteFrame}ms) > 0`)
  process.exit(1)
}
console.log('PASS: zero white-frame exposure verified')
