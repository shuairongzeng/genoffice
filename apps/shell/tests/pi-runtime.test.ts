import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import {
  SessionMapStore,
  advanceReasoningDelta,
  buildExcludeBuiltinTools,
  createOrdinalPrefixStripper,
  messageUsageDelta,
  stripOrdinalPrefix,
} from '../src/main/pi-agent/pi-runtime'
import { DEFAULT_PI_AGENT_PREFS } from '../src/shared/pi-agent-prefs'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('pi-runtime helpers', () => {
  it('strips §N§ ordinal tags across split streaming chunks without dropping literal § text', () => {
    const stripper = createOrdinalPrefixStripper()
    const chunks = ['§', '12', '§ ', 'Hello ', 'world!\n', '§3§', ' Next', ' line\n§not-tag']
    let out = ''
    for (const c of chunks) {
      out += stripper.push(c)
    }
    out += stripper.flush()

    expect(out).toBe('Hello world!\nNext line\n§not-tag')
    expect(out).not.toMatch(/§\d+§/)
    expect(stripOrdinalPrefix('§1§ First\n§42§ Second\nNormal §100§ inline')).toBe(
      'First\nSecond\nNormal §100§ inline',
    )
  })

  it('handles trailing chunk boundary §N§ followed by space or newline cleanly', () => {
    const stripper = createOrdinalPrefixStripper()
    let out = ''
    out += stripper.push('§7§')
    out += stripper.push(' Line A')
    out += stripper.push('\n§9§\nLine B')
    out += stripper.flush()
    expect(out).toBe('Line A\n\nLine B')

    const literalOnly = createOrdinalPrefixStripper()
    expect(literalOnly.push('§') + literalOnly.flush()).toBe('§')
  })

  it('builds excludeTools cleanly without ever using a tools allowlist', () => {
    expect(buildExcludeBuiltinTools(DEFAULT_PI_AGENT_PREFS)).toEqual([])
    expect(
      buildExcludeBuiltinTools({ enablePiReadTools: false, enablePiWriteTools: true }),
    ).toEqual(['read', 'grep', 'find', 'ls'])
    expect(
      buildExcludeBuiltinTools({ enablePiReadTools: true, enablePiWriteTools: false }),
    ).toEqual(['bash', 'powershell', 'edit', 'write'])
    expect(
      buildExcludeBuiltinTools({ enablePiReadTools: false, enablePiWriteTools: false }),
    ).toEqual(['read', 'grep', 'find', 'ls', 'bash', 'powershell', 'edit', 'write'])
  })

  it('persists, reloads, rebinds, and deletes entries in SessionMapStore', () => {
    const dir = makeTempDir('genoffice-smap-')
    const mapPath = join(dir, 'session-map.json')
    const sessionFileA = join(dir, 'sess-a.jsonl')
    writeFileSync(sessionFileA, '{"type":"session"}\n', 'utf8')

    const store = new SessionMapStore(mapPath)
    store.set('proj-1:temp-1', sessionFileA)
    expect(store.get('proj-1:temp-1')).toBe(sessionFileA)

    store.rebind('proj-1:temp-1', 'proj-1:file-hash-9')
    expect(store.get('proj-1:temp-1')).toBeUndefined()
    expect(store.get('proj-1:file-hash-9')).toBe(sessionFileA)

    // Reload from disk verifies persistence.
    const reloaded = new SessionMapStore(mapPath)
    expect(reloaded.get('proj-1:file-hash-9')).toBe(sessionFileA)

    reloaded.delete('proj-1:file-hash-9')
    expect(reloaded.get('proj-1:file-hash-9')).toBeUndefined()
    const raw = JSON.parse(readFileSync(mapPath, 'utf8'))
    expect(raw.entries).toEqual({})

    // Prunes orphaned mapping if session jsonl was removed externally.
    const orphanFile = join(dir, 'orphan.jsonl')
    writeFileSync(orphanFile, '', 'utf8')
    reloaded.set('proj-1:orphan', orphanFile)
    rmSync(orphanFile)
    expect(reloaded.get('proj-1:orphan')).toBeUndefined()
  })

  it('emits incremental reasoning deltas and per-message usage deltas without double accumulation', () => {
    const state = { accumulatedReasoning: '', reasoningNeedsBreak: false }
    const d1 = advanceReasoningDelta(state, 'Step 1')
    const d2 = advanceReasoningDelta(state, ' detail')
    expect(d1).toBe('Step 1')
    expect(d2).toBe(' detail')
    expect(state.accumulatedReasoning).toBe('Step 1 detail')

    state.reasoningNeedsBreak = true
    const d3 = advanceReasoningDelta(state, 'Step 2')
    expect(d3).toBe('\n\nStep 2')
    expect(state.reasoningNeedsBreak).toBe(false)
    expect(state.accumulatedReasoning).toBe('Step 1 detail\n\nStep 2')

    const u1 = messageUsageDelta({ input: 120, output: 30 })
    const u2 = messageUsageDelta({ input: 80, output: 20 })
    expect(u1).toEqual({ inputTokens: 120, outputTokens: 30 })
    expect(u2).toEqual({ inputTokens: 80, outputTokens: 20 })
  })
})
