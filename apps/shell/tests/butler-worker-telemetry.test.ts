import { describe, expect, it } from 'vitest'
import {
  BUTLER_WORKER_ROLES,
  evaluateWorkerHealth,
  extractWorkerProgressNote,
  inferButlerWorkerRole,
  redactTelemetrySecrets,
  summarizeWorkerToolCall,
} from '../src/shared/butler-worker-telemetry'
import * as butlerApi from '../src/shared/butler-api'
import * as orchestratorApi from '../src/shared/butler-orchestrator-api'
import * as homeApi from '../src/shared/home-api'

describe('butler-worker-telemetry shared exports', () => {
  it('exposes BUTLER_WORKER_ROLES and helpers consistently across shared APIs', () => {
    expect(BUTLER_WORKER_ROLES).toEqual([
      'general',
      'files',
      'research',
      'docs',
      'sheets',
      'slides',
      'browser',
      'ops',
    ])
    expect(orchestratorApi.BUTLER_WORKER_ROLES).toBe(BUTLER_WORKER_ROLES)
    expect(butlerApi.BUTLER_WORKER_ROLES).toBe(BUTLER_WORKER_ROLES)
    expect(homeApi.BUTLER_WORKER_ROLES).toBe(BUTLER_WORKER_ROLES)

    expect(homeApi.inferButlerWorkerRole).toBe(inferButlerWorkerRole)
    expect(homeApi.redactTelemetrySecrets).toBe(redactTelemetrySecrets)
    expect(homeApi.summarizeWorkerToolCall).toBe(summarizeWorkerToolCall)
    expect(homeApi.extractWorkerProgressNote).toBe(extractWorkerProgressNote)
    expect(homeApi.evaluateWorkerHealth).toBe(evaluateWorkerHealth)
  })
})

describe('inferButlerWorkerRole', () => {
  it('preserves explicit non-general specialist roles as-is', () => {
    expect(
      inferButlerWorkerRole({
        role: 'docs',
        title: 'Scan disk for mp4 videos and run npm build',
      }),
    ).toBe('docs')
    expect(inferButlerWorkerRole({ role: 'files', title: 'General check' })).toBe('files')
    expect(inferButlerWorkerRole({ role: 'ops', title: 'Write summary' })).toBe('ops')
  })

  it('re-classifies explicit general or missing/invalid role from title and brief', () => {
    expect(
      inferButlerWorkerRole({
        role: 'general',
        title: '整理下载目录里的视频和电影文件',
        brief: '扫描本地磁盘查找 .mp4 与 .mkv',
      }),
    ).toBe('files')

    expect(
      inferButlerWorkerRole({
        role: 'unknown-role',
        title: 'Build and debug CLI script',
        brief: 'Run npm compile and inspect port process errors',
      }),
    ).toBe('ops')
  })

  it('classifies each specialist domain accurately', () => {
    expect(inferButlerWorkerRole({ title: 'Scan disk for local files and folders' })).toBe('files')
    expect(inferButlerWorkerRole({ title: '排查脚本编译报错并重启终端进程' })).toBe('ops')
    expect(inferButlerWorkerRole({ title: '打开官网查询最新新闻与天气', brief: 'https://example.com' })).toBe('browser')
    expect(inferButlerWorkerRole({ title: '核算财务 Excel 表格与 CSV 对账公式' })).toBe('sheets')
    expect(inferButlerWorkerRole({ title: '制作季度汇报 PPTX 演示文稿幻灯片' })).toBe('slides')
    expect(inferButlerWorkerRole({ title: '撰写产品 Word 文档并完成排版' })).toBe('docs')
    expect(inferButlerWorkerRole({ title: '开展竞品深度调研与知识库综述对比分析' })).toBe('research')
  })

  it('weights title domain cues over incidental secondary keywords', () => {
    expect(
      inferButlerWorkerRole({
        title: '整理下载目录的视频文件夹',
        brief: '顺便写个 python 脚本批量重命名 .mp4 文件',
      }),
    ).toBe('files')

    expect(
      inferButlerWorkerRole({
        title: '竞品深度调研与对比分析',
        brief: '查看官网公开资料并形成综述',
      }),
    ).toBe('research')
  })

  it('falls back to general when empty or uncategorized', () => {
    expect(inferButlerWorkerRole({})).toBe('general')
    expect(
      inferButlerWorkerRole({
        role: 'general',
        title: 'Coordinate afternoon reminder',
        brief: 'Send a brief status note to the team',
      }),
    ).toBe('general')
  })
})

describe('redactTelemetrySecrets', () => {
  it('redacts Bearer tokens, sk- keys, and credential assignments', () => {
    const raw =
      'curl -H "Authorization: Bearer eyJhbGciOi.secret_jwt" "https://api.example.com?api_key=abc123&ok=1" OPENAI_API_KEY=sk-proj1234567890 password="hunter2" token: tok_xyz'
    const clean = redactTelemetrySecrets(raw)

    expect(clean).not.toContain('eyJhbGciOi')
    expect(clean).not.toContain('abc123')
    expect(clean).not.toContain('sk-proj1234567890')
    expect(clean).not.toContain('hunter2')
    expect(clean).not.toContain('tok_xyz')
    expect(clean).toContain('&ok=1')
    expect(clean).toContain('***')
  })

  it('does not corrupt ordinary dashed filenames containing sk-', () => {
    const safe = 'Checking D:/media/disk-20261125-archive/task-12345678.mp4'
    expect(redactTelemetrySecrets(safe)).toBe(safe)
  })
})

describe('summarizeWorkerToolCall', () => {
  it('extracts first meaningful command line from bash/powershell and strips heredocs', () => {
    const bashWithHeredoc = [
      '#!/usr/bin/env bash',
      '# prepare output',
      'set -euo pipefail',
      "cat > /tmp/report.md <<'EOF'",
      '# large body',
      'secret token=should_not_appear',
      'EOF',
      'ls -la /tmp/report.md',
    ].join('\n')

    expect(summarizeWorkerToolCall('bash', { command: bashWithHeredoc })).toBe(
      'cat > /tmp/report.md',
    )

    const psCommand = [
      '$script = @"',
      'Write-Host "hidden"',
      '"@',
      'Get-ChildItem -Path D:\\Videos -Filter *.mp4 -Token=secret_val',
    ].join('\n')

    expect(summarizeWorkerToolCall('powershell', { command: psCommand })).toBe(
      'Get-ChildItem -Path D:\\Videos -Filter *.mp4 -***',
    )

    const multilinePython = [
      'python -c "',
      'import json',
      'data = json.load(open("app-settings.json"))',
      '"',
    ].join('\n')
    expect(summarizeWorkerToolCall('bash', { command: multilinePython })).toBe(
      'python -c "import json; data = json.load(open("app-settings.json"))"',
    )

    const multilinePsInline = [
      'powershell -NoProfile -Command "',
      'Get-ChildItem -Path D:\\Videos -File',
      '"',
    ].join('\n')
    expect(summarizeWorkerToolCall('bash', { command: multilinePsInline })).toBe(
      'powershell -NoProfile -Command "Get-ChildItem -Path D:\\Videos -File"',
    )
  })

  it('inspects file, browser, search_files, kb, and fallback inputs cleanly', () => {
    expect(summarizeWorkerToolCall('read', { path: 'apps/shell/src/main/index.ts' })).toBe(
      'apps/shell/src/main/index.ts',
    )
    expect(summarizeWorkerToolCall('edit', { file_path: 'docs/notes.md' })).toBe('docs/notes.md')
    expect(summarizeWorkerToolCall('grep', { pattern: 'ButlerSubTask', path: 'apps/shell' })).toBe(
      'ButlerSubTask (apps/shell)',
    )
    expect(summarizeWorkerToolCall('find', { glob: '**/*.mp4' })).toBe('**/*.mp4')
    expect(
      summarizeWorkerToolCall('browser_navigate', {
        url: 'https://example.com/search?api_key=topsecret99&q=weather',
      }),
    ).toBe('https://example.com/search?***&q=weather')
    expect(summarizeWorkerToolCall('browser_click', { selector: '#submit-btn' })).toBe('#submit-btn')
    expect(summarizeWorkerToolCall('search_files', { q: 'invoice 2026', path: 'D:/Archive' })).toBe(
      'invoice 2026 (D:/Archive)',
    )
    expect(summarizeWorkerToolCall('kb_lookup', { query: 'quarterly margin' })).toBe(
      'quarterly margin',
    )
    expect(summarizeWorkerToolCall('custom_tool', { foo: 'bar', secret: 'hidden' })).toContain(
      '***',
    )
  })

  it('collapses whitespace, truncates cleanly to maxLen, and handles empty inputs', () => {
    expect(summarizeWorkerToolCall('read', null)).toBe('')
    expect(summarizeWorkerToolCall('read', {})).toBe('')
    expect(summarizeWorkerToolCall('read', { path: 'apps/shell/src/a.ts' }, 0)).toBe('')

    const longPath = `apps/shell/src/${'nested/'.repeat(20)}file.ts`
    const summary = summarizeWorkerToolCall('read', { path: longPath }, 40)
    expect(summary.length).toBeLessThanOrEqual(40)
    expect(summary.endsWith('…')).toBe(true)
  })
})

describe('extractWorkerProgressNote', () => {
  it('returns latest meaningful natural-language line while ignoring code blocks and markdown chrome', () => {
    const text = [
      '# Step 1',
      'Scanning source folder.',
      '```ts',
      'const secret = "Bearer hidden_jwt_123"',
      'console.log("ignore inside fence")',
      '```',
      '---',
      '- [x] Parsed **24 files** from [index](https://example.com)',
      '## 正在校验输出文件 token=supersecret123',
      '```',
      'unclosed trailing code block should be ignored',
    ].join('\n')

    const note = extractWorkerProgressNote(text)
    expect(note).toBe('正在校验输出文件 ***')
  })

  it('truncates long notes to maxLen and returns empty for empty or code-only text', () => {
    expect(extractWorkerProgressNote('   \n```\ncode only\n```\n---')).toBe('')

    const longLine = 'Analyzing directory contents across multiple workspace partitions '.repeat(4)
    const note = extractWorkerProgressNote(longLine, 50)
    expect(note.length).toBeLessThanOrEqual(50)
    expect(note.endsWith('…')).toBe(true)
  })
})

describe('evaluateWorkerHealth', () => {
  it('returns normal whenever task status is not running', () => {
    expect(
      evaluateWorkerHealth({
        status: 'done',
        stepStartedAt: 0,
        consecutiveErrors: 5,
        now: 300_000,
      }),
    ).toBe('normal')
    expect(
      evaluateWorkerHealth({
        status: 'blocked',
        stepStartedAt: 0,
        consecutiveErrors: 3,
        now: 120_000,
      }),
    ).toBe('normal')
  })

  it('classifies normal, slow, and stalled states using exact thresholds', () => {
    expect(
      evaluateWorkerHealth({
        status: 'running',
        startedAt: 0,
        stepStartedAt: 1000,
        consecutiveErrors: 1,
        now: 1000 + 44_999,
      }),
    ).toBe('normal')

    expect(
      evaluateWorkerHealth({
        status: 'running',
        startedAt: 0,
        now: 200_000,
      }),
    ).toBe('normal')

    expect(
      evaluateWorkerHealth({
        status: 'running',
        stepStartedAt: 1000,
        consecutiveErrors: 0,
        now: 1000 + 45_000,
      }),
    ).toBe('slow')

    expect(
      evaluateWorkerHealth({
        status: 'running',
        stepStartedAt: 1000,
        consecutiveErrors: 0,
        now: 1000 + 89_999,
      }),
    ).toBe('slow')

    expect(
      evaluateWorkerHealth({
        status: 'running',
        stepStartedAt: 10_000,
        consecutiveErrors: 2,
        now: 11_000,
      }),
    ).toBe('slow')

    expect(
      evaluateWorkerHealth({
        status: 'running',
        stepStartedAt: 1000,
        consecutiveErrors: 0,
        now: 1000 + 90_000,
      }),
    ).toBe('stalled')

    expect(
      evaluateWorkerHealth({
        status: 'running',
        stepStartedAt: 10_000,
        consecutiveErrors: 3,
        now: 10_500,
      }),
    ).toBe('stalled')
  })
})
