import { describe, expect, it } from 'vitest'

import { collectLaunchPaths } from '../src/main/launch-paths'

describe('collectLaunchPaths', () => {
  it('collects supported argv files in order and removes duplicates', () => {
    expect(
      collectLaunchPaths(
        ['GenOffice.exe', 'first.docx', 'notes.rtf', 'second.xlsx', 'first.docx'],
        undefined,
        () => true,
      ),
    ).toEqual(['first.docx', 'second.xlsx'])
  })

  it('accepts a .tsv from argv or the second-instance payload', () => {
    expect(
      collectLaunchPaths(['GenOffice.app', '/data/variants.tsv'], undefined, () => true),
    ).toEqual(['/data/variants.tsv'])
  })

  it('accepts legacy Word .doc/.dot and Hancom .hwpx/.hwp documents in either case', () => {
    expect(
      collectLaunchPaths(
        [
          'GenOffice.app',
          '/tmp/legacy.doc',
          '/tmp/TEMPLATE.DOT',
          '/tmp/report.hwpx',
          '/tmp/LEGACY.HWP',
        ],
        undefined,
        () => true,
      ),
    ).toEqual(['/tmp/legacy.doc', '/tmp/TEMPLATE.DOT', '/tmp/report.hwpx', '/tmp/LEGACY.HWP'])
    expect(
      collectLaunchPaths(['GenOffice.exe'], { launchPaths: ['/tmp/letter.Doc'] }, () => true),
    ).toEqual(['/tmp/letter.Doc'])
  })

  /**
   * A `.txt` or `.json` is now a document the text app opens, so dropping one
   * from argv (or from a second-instance payload, or from a Finder open-file)
   * left the shell at Home with no explanation — the file had been accepted as
   * a path and then thrown away before it ever reached the open route.
   */
  it('accepts the text app extensions from argv', () => {
    expect(collectLaunchPaths(['GenOffice.app', '/notes.txt'], undefined, () => true)).toEqual([
      '/notes.txt',
    ])
    expect(collectLaunchPaths(['GenOffice.app', '/data.json'], undefined, () => true)).toEqual([
      '/data.json',
    ])
    expect(collectLaunchPaths(['GenOffice.app', '/NOTES.TXT'], undefined, () => true)).toEqual([
      '/NOTES.TXT',
    ])
    expect(collectLaunchPaths(['GenOffice.app', '/data.json.md'], undefined, () => true)).toEqual([
      '/data.json.md',
    ])
  })

  it('accepts the text app extensions from the second-instance payload', () => {
    expect(
      collectLaunchPaths(['GenOffice.exe'], { launchPaths: ['/notes.txt'] }, () => true),
    ).toEqual(['/notes.txt'])
  })

  it('accepts supported image, audio, video, and code extensions from argv', () => {
    expect(collectLaunchPaths(['GenOffice.app', '/photo.png'], undefined, () => true)).toEqual([
      '/photo.png',
    ])
    expect(collectLaunchPaths(['GenOffice.app', '/voice.mp3'], undefined, () => true)).toEqual([
      '/voice.mp3',
    ])
    expect(collectLaunchPaths(['GenOffice.app', '/clip.mkv'], undefined, () => true)).toEqual([
      '/clip.mkv',
    ])
    expect(collectLaunchPaths(['GenOffice.app', '/script.py'], undefined, () => true)).toEqual([
      '/script.py',
    ])
    expect(collectLaunchPaths(['GenOffice.app', '/app.ts'], undefined, () => true)).toEqual([
      '/app.ts',
    ])
    expect(collectLaunchPaths(['GenOffice.app', '/query.sql'], undefined, () => true)).toEqual([
      '/query.sql',
    ])
  })

  it('still drops a path nothing opens', () => {
    // a file that exists but is not a document the shell can route
    expect(collectLaunchPaths(['GenOffice.app', '/archive.zip'], undefined, () => true)).toEqual([])
    expect(collectLaunchPaths(['GenOffice.app', '/notes.txt'], undefined, () => false)).toEqual([])
  })

  it('collects argv and second-instance payload files without duplicates', () => {
    expect(
      collectLaunchPaths(
        ['GenOffice.exe', 'first.docx', 'second.pptx'],
        {
          launchPaths: ['first.docx', 'third.pdf', 42, ''],
          launchPath: 'legacy.md',
        },
        () => true,
      ),
    ).toEqual(['first.docx', 'second.pptx', 'third.pdf', 'legacy.md'])
  })

  it('accepts a legacy launchPath payload', () => {
    expect(
      collectLaunchPaths(['GenOffice.exe'], { launchPath: 'legacy.docx' }, () => true),
    ).toEqual(['legacy.docx'])
  })

  it('falls back to the first existing unsupported argv file', () => {
    expect(
      collectLaunchPaths(
        ['GenOffice.exe', 'missing.doc', 'legacy.rtf'],
        undefined,
        (path) => path === 'legacy.rtf',
      ),
    ).toEqual(['legacy.rtf'])
    // .doc/.hwpx/.hwp are no longer unsupported: existing ones are collected
    // through the docs route instead of the fallback
    expect(
      collectLaunchPaths(
        ['GenOffice.exe', 'legacy.doc', 'unsupported.rtf'],
        undefined,
        (path) => path === 'legacy.doc' || path === 'unsupported.rtf',
      ),
    ).toEqual(['legacy.doc'])
    expect(
      collectLaunchPaths(
        ['GenOffice.exe', 'hangul.hwp', 'unsupported.rtf'],
        undefined,
        (path) => path === 'hangul.hwp' || path === 'unsupported.rtf',
      ),
    ).toEqual(['hangul.hwp'])
    // .ppt converts through the slides route since the legacy importer landed
    expect(
      collectLaunchPaths(
        ['GenOffice.exe', 'legacy.ppt', 'unsupported.rtf'],
        undefined,
        (path) => path === 'legacy.ppt' || path === 'unsupported.rtf',
      ),
    ).toEqual(['legacy.ppt'])
  })
})
