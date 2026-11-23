import { describe, expect, it } from 'vitest'
import {
  buildSandboxedHtmlDoc,
  buildSandboxedSvgDoc,
  detectRichOutput,
  extractLocalPaths,
} from './terminal-rich-detect'

describe('detectRichOutput', () => {
  it('returns plain for empty, plain logs, or primitive JSON values', () => {
    expect(detectRichOutput('')).toEqual({ kind: 'plain' })
    expect(detectRichOutput('   \n  ')).toEqual({ kind: 'plain' })
    expect(detectRichOutput('Build succeeded in 1.2s\n0 warnings')).toEqual({ kind: 'plain' })
    expect(detectRichOutput('42')).toEqual({ kind: 'plain' })
    expect(detectRichOutput('"hello"')).toEqual({ kind: 'plain' })
  })

  it('detects standalone or dominant SVG and strips script tags', () => {
    const rawSvg =
      '\x1b[32m<?xml version="1.0"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<script>alert(1)</script><circle cx="50" cy="50" r="40" />' +
      '</svg>\x1b[0m'
    const res = detectRichOutput(rawSvg)
    expect(res.kind).toBe('svg')
    if (res.kind === 'svg') {
      expect(res.svg).toContain('<circle cx="50" cy="50" r="40" />')
      expect(res.svg).not.toContain('<script')
    }
  })

  it('preserves nested SVG elements inside outer SVG', () => {
    const nested =
      '<svg viewBox="0 0 20 20"><svg x="2" y="2"><rect width="4" height="4"/></svg></svg>'
    const res = detectRichOutput(nested)
    expect(res).toEqual({ kind: 'svg', svg: nested })

    const dominant =
      'Chart saved:\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100"/></svg>'
    expect(detectRichOutput(dominant)).toEqual({
      kind: 'svg',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100"/></svg>',
    })
  })

  it('does not misclassify an HTML document containing an inline SVG as SVG', () => {
    const htmlWithSvg =
      '<!doctype html><html><body><div class="icon"><svg viewBox="0 0 10 10"><circle r="4"/></svg></div></body></html>'
    const res = detectRichOutput(htmlWithSvg)
    expect(res.kind).toBe('html')
  })

  it('detects full HTML docs even when surrounded by a few plain lines', () => {
    const output = [
      'Rendering report...',
      '<!doctype html><html><body><h1>Report</h1><p>Done</p></body></html>',
      'Exit code: 0',
    ].join('\n')
    const res = detectRichOutput(output)
    expect(res).toEqual({
      kind: 'html',
      html: '<!doctype html><html><body><h1>Report</h1><p>Done</p></body></html>',
    })
  })

  it('detects structured HTML fragments across supported block and style tags', () => {
    const fragment = '<style>.box{color:red}</style><div class="box"><h2>Summary</h2></div>'
    expect(detectRichOutput(fragment)).toEqual({ kind: 'html', html: fragment })

    const tableFrag = '<table><tr><th>Name</th></tr><tr><td>Alice</td></tr></table>'
    expect(detectRichOutput(tableFrag)).toEqual({ kind: 'html', html: tableFrag })

    const prefixed = 'Preview:\n<ul><li>Alpha</li><li>Beta</li></ul>'
    expect(detectRichOutput(prefixed)).toEqual({
      kind: 'html',
      html: '<ul><li>Alpha</li><li>Beta</li></ul>',
    })

    const articleFrag =
      '<section><header><h1>Heading</h1></header><article><main>Body</main></article></section>'
    expect(detectRichOutput(articleFrag)).toEqual({ kind: 'html', html: articleFrag })

    const htmlOnlyDoc = '<html><body><ol><li>First</li></ol></body></html>'
    expect(detectRichOutput(htmlOnlyDoc)).toEqual({ kind: 'html', html: htmlOnlyDoc })
  })

  it('avoids HTML false positives on PowerShell <DIR>, TypeScript generics, and error logs', () => {
    const psDir = [
      '    Directory: D:\\GitHub\\genoffice',
      '',
      'Mode                 LastWriteTime         Length Name',
      '----                 -------------         ------ ----',
      'd-----        2026/11/23     12:00                <DIR>          apps',
      'd-----        2026/11/23     12:00                <DIR>          docs',
    ].join('\n')
    expect(detectRichOutput(psDir)).toEqual({ kind: 'plain' })

    const generics = [
      'const items: Array<string> = []',
      'const lookup = new Map<string, Array<number>>()',
      'type Entry<K, V> = [K, V]',
    ].join('\n')
    expect(detectRichOutput(generics)).toEqual({ kind: 'plain' })

    const stackTrace = [
      'Error: Expected <div>foo</div> to be closed',
      '    at parse (parser.ts:10:5)',
      '    at compile (compiler.ts:22:3)',
      '    at run (cli.ts:8:1)',
      '    at main (index.ts:4:1)',
      '    at processTicks (node:internal:1:1)',
    ].join('\n')
    expect(detectRichOutput(stackTrace)).toEqual({ kind: 'plain' })
  })

  it('detects valid JSON objects and arrays before HTML/SVG', () => {
    const jsonWithHtml = '{"html":"<div>hello</div>","svg":"<svg><circle/></svg>","count":2}'
    const res = detectRichOutput(`\x1b[33m${jsonWithHtml}\x1b[0m`)
    expect(res).toEqual({
      kind: 'json',
      parsed: { html: '<div>hello</div>', svg: '<svg><circle/></svg>', count: 2 },
      pretty: JSON.stringify(
        { html: '<div>hello</div>', svg: '<svg><circle/></svg>', count: 2 },
        null,
        2,
      ),
    })

    const arr = detectRichOutput('[1, {"ok": true}]')
    expect(arr.kind).toBe('json')
    expect(detectRichOutput('[INFO] Starting service [OK]')).toEqual({ kind: 'plain' })
  })

  it('detects quoted CSV and TSV tables while avoiding prose false positives', () => {
    const csv = ['id,name,notes', '1,"Doe, Jane","Said ""Hello"""', '2, "Smith, Bob",active'].join(
      '\n',
    )
    expect(detectRichOutput(csv)).toEqual({
      kind: 'table',
      table: {
        headers: ['id', 'name', 'notes'],
        rows: [
          ['1', 'Doe, Jane', 'Said "Hello"'],
          ['2', 'Smith, Bob', 'active'],
        ],
        delimiter: ',',
      },
    })

    const tsv = ['id\tname\tcity', '1\tAlice\t"New York, NY"', '2\tBob\tSeattle'].join('\n')
    expect(detectRichOutput(tsv)).toEqual({
      kind: 'table',
      table: {
        headers: ['id', 'name', 'city'],
        rows: [
          ['1', 'Alice', 'New York, NY'],
          ['2', 'Bob', 'Seattle'],
        ],
        delimiter: '\t',
      },
    })

    // Empty optional last column in data rows with named header is still valid CSV.
    expect(detectRichOutput('id,name,note\n1,Alice,\n2,Bob,')).toEqual({
      kind: 'table',
      table: {
        headers: ['id', 'name', 'note'],
        rows: [
          ['1', 'Alice', ''],
          ['2', 'Bob', ''],
        ],
        delimiter: ',',
      },
    })

    // Prose sentences with commas must not trigger CSV table detection.
    const prose = [
      'First, we need to verify the environment variables.',
      'Second, we should restart the background worker.',
    ].join('\n')
    expect(detectRichOutput(prose)).toEqual({ kind: 'plain' })

    // Prose separated by spaces must not trigger table detection.
    expect(detectRichOutput('alpha beta gamma\none two three')).toEqual({ kind: 'plain' })

    // Over 500 non-empty lines falls back to plain.
    const tooManyLines = Array.from({ length: 501 }, (_, i) => `r${i},v${i}`).join('\n')
    expect(detectRichOutput(tooManyLines)).toEqual({ kind: 'plain' })
  })

  it('detects markdown when at least two distinct structural signals appear', () => {
    const md = [
      '# Release Notes',
      '',
      '- Added **ANSI parser** support',
      '- See [docs](https://example.com/docs)',
    ].join('\n')
    expect(detectRichOutput(md)).toEqual({ kind: 'markdown', markdown: md })

    const mdTableAndQuote = [
      '> Summary table',
      '',
      '| Metric | Value |',
      '| --- | --- |',
      '| Pass | 100% |',
    ].join('\n')
    expect(detectRichOutput(mdTableAndQuote)).toEqual({
      kind: 'markdown',
      markdown: mdTableAndQuote,
    })

    // Fenced HTML code example inside Markdown stays Markdown rather than HTML.
    const mdWithHtmlFence = [
      '## Example Markup',
      '',
      '- Paste the snippet below:',
      '',
      '```html',
      '<div class="card">Hello</div>',
      '```',
    ].join('\n')
    expect(detectRichOutput(mdWithHtmlFence)).toEqual({
      kind: 'markdown',
      markdown: mdWithHtmlFence,
    })

    // Single structural signal stays plain.
    expect(detectRichOutput('# Just a shell comment\necho ok')).toEqual({ kind: 'plain' })
    expect(detectRichOutput('- one\n1. two')).toEqual({ kind: 'plain' })
    expect(detectRichOutput('items[0](arg)\nplain line')).toEqual({ kind: 'plain' })
  })
})

describe('buildSandboxedHtmlDoc', () => {
  it('wraps HTML fragments with light and dark base theme styles', () => {
    const light = buildSandboxedHtmlDoc('<p>Hello</p>', false)
    expect(light).toContain('<!doctype html>')
    expect(light).toContain('<meta charset="utf-8">')
    expect(light).toContain('color-scheme: light')
    expect(light).toContain('#ffffff')
    expect(light).toContain('<body><p>Hello</p></body>')

    const dark = buildSandboxedHtmlDoc('<p>Hello</p>', true)
    expect(dark).toContain('color-scheme: dark')
    expect(dark).toContain('#1e1e1e')
    expect(dark).toContain('#e4e4e4')
  })

  it('injects low-specificity defaults and meta charset into full HTML documents without overriding user styles', () => {
    const full =
      '<!DOCTYPE html><html><head><style>body{background:#fafafa}</style></head><body><h1>Hi</h1></body></html>'
    const out = buildSandboxedHtmlDoc(full, true)
    expect(out).toContain('<meta charset="utf-8">')
    expect(out).toContain(':where(html, body)')
    expect(out.indexOf(':where(html, body)')).toBeLessThan(out.indexOf('body{background:#fafafa}'))

    const withCharset =
      '<!doctype html><html><head><meta charset="UTF-8"></head><body>ok</body></html>'
    const outWithCharset = buildSandboxedHtmlDoc(withCharset, false)
    expect(outWithCharset.match(/charset/gi)?.length).toBe(1)

    const noHead = '<html><body><p>No head tag</p></body></html>'
    const outNoHead = buildSandboxedHtmlDoc(noHead, false)
    expect(outNoHead).toContain('<html><head><meta charset="utf-8"><style>')
    expect(outNoHead).toContain('<body><p>No head tag</p></body>')
  })

  it('strips scripts, inline on* handlers, and javascript: URIs without corrupting text nodes', () => {
    const dirty =
      '<div title="1 > 0" onclick="alert(1)" ONMOUSEOVER=\'evil()\' data-id="7">' +
      '<p>one=1 and only=true</p>' +
      '<img src=x onerror=alert(2)>' +
      '<a href="javascript:alert(3)">bad</a>' +
      '<script>alert(4)</script><script src="x.js"/>' +
      '</div>'
    const safe = buildSandboxedHtmlDoc(dirty, false)
    expect(safe).not.toContain('<script')
    expect(safe).not.toContain('onclick')
    expect(safe).not.toContain('ONMOUSEOVER')
    expect(safe).not.toContain('onerror')
    expect(safe).not.toContain('javascript:')
    expect(safe).toContain('title="1 > 0"')
    expect(safe).toContain('data-id="7"')
    expect(safe).toContain('<p>one=1 and only=true</p>')
  })
})

describe('buildSandboxedSvgDoc', () => {
  it('wraps SVG centered inside a theme-aware sandbox document and strips dangerous attrs', () => {
    const svg =
      '<svg onload="alert(1)" viewBox="0 0 24 24"><script>alert(1)</script><path onclick=evil() d="M0 0h24v24H0z"/></svg>'
    const doc = buildSandboxedSvgDoc(svg, true)
    expect(doc).toContain('<!doctype html>')
    expect(doc).toContain('#1e1e1e')
    expect(doc).toContain('align-items: center')
    expect(doc).not.toContain('<script')
    expect(doc).not.toContain('onload')
    expect(doc).not.toContain('onclick')
    expect(doc).toContain('<path d="M0 0h24v24H0z"/>')
  })
})

describe('extractLocalPaths', () => {
  it('extracts Windows and POSIX paths, strips ANSI, punctuation, and line:col suffixes', () => {
    const output = [
      '\x1b[32mSaved\x1b[0m "C:\\Users\\Alice\\report.docx", and (D:\\work\\chart.svg).',
      'Error at D:\\GitHub\\genoffice\\src\\index.ts:42:10;',
      'Inspect /Users/alice/notes.md or out=/tmp/summary.pdf]',
      'Audio /Volumes/Media/clip.mp3 and image /home/dev/banner.webp',
    ].join('\n')

    expect(extractLocalPaths(output)).toEqual([
      { path: 'C:\\Users\\Alice\\report.docx', name: 'report.docx' },
      { path: 'D:\\work\\chart.svg', name: 'chart.svg' },
      { path: 'D:\\GitHub\\genoffice\\src\\index.ts', name: 'index.ts' },
      { path: '/Users/alice/notes.md', name: 'notes.md' },
      { path: '/tmp/summary.pdf', name: 'summary.pdf' },
      { path: '/Volumes/Media/clip.mp3', name: 'clip.mp3' },
      { path: '/home/dev/banner.webp', name: 'banner.webp' },
    ])
  })

  it('filters unsupported extensions, ignores URLs, dedupes normalized paths, and caps at 8', () => {
    const output = [
      'Ignore https://example.com/assets/logo.png and //cdn/share/app.js',
      'Ignore C:\\bin\\tool.exe and /usr/bin/node and /tmp/.hidden',
      'C:\\Docs\\Report.PDF',
      'c:\\docs\\report.pdf',
      '/tmp//a.json',
      '/tmp/a.json',
      '/tmp/1.txt /tmp/2.csv /tmp/3.tsv /tmp/4.py /tmp/5.css /tmp/6.html /tmp/7.jpg /tmp/8.mp4',
    ].join('\n')

    const paths = extractLocalPaths(output)
    expect(paths).toHaveLength(8)
    expect(paths.map((p) => p.name)).toEqual([
      'Report.PDF',
      'a.json',
      '1.txt',
      '2.csv',
      '3.tsv',
      '4.py',
      '5.css',
      '6.html',
    ])
  })
})
