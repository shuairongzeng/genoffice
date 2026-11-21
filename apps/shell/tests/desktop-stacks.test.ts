import { describe, expect, it, vi } from 'vitest'
import { desktopStrings } from '../src/renderer/src/desktop-strings'
import type { DesktopItem } from '../src/renderer/src/desktop-items'
import {
  STACK_CATEGORY_ID_PREFIX,
  STACK_RECENT_ID,
  applyDesktopStacks,
  classifyFileStackCategory,
  effectiveRecentsMode,
} from '../src/renderer/src/desktop-stacks'

const strings = desktopStrings('en')

function makeItem(over: Partial<DesktopItem> & Pick<DesktopItem, 'id' | 'kind'>): DesktopItem {
  return {
    title: over.id,
    tile: null,
    ext: '',
    path: null,
    alias: false,
    draggable: over.kind !== 'widget',
    open: () => {},
    ...over,
  }
}

describe('classifyFileStackCategory', () => {
  it('classifies office documents, spreadsheets, presentations, pdfs, media, and fallback files', () => {
    expect(classifyFileStackCategory('docx')).toBe('docs')
    expect(classifyFileStackCategory('.MD')).toBe('docs')
    expect(classifyFileStackCategory('', '/repo/notes.ts')).toBe('docs')
    expect(classifyFileStackCategory('xlsx')).toBe('sheets')
    expect(classifyFileStackCategory('csv')).toBe('sheets')
    expect(classifyFileStackCategory('pptx')).toBe('slides')
    expect(classifyFileStackCategory('pdf')).toBe('pdf')
    expect(classifyFileStackCategory('flac')).toBe('media')
    expect(classifyFileStackCategory('mp4')).toBe('media')
    expect(classifyFileStackCategory('png')).toBe('media')
    expect(classifyFileStackCategory('zip')).toBe('other')
    expect(classifyFileStackCategory('', '/repo/README')).toBe('other')
  })
})

describe('effectiveRecentsMode', () => {
  it('defaults omitted or unknown values to stack and preserves valid modes', () => {
    expect(effectiveRecentsMode(undefined)).toBe('stack')
    expect(effectiveRecentsMode(null)).toBe('stack')
    expect(effectiveRecentsMode({})).toBe('stack')
    expect(effectiveRecentsMode({ recentsMode: 'stack' })).toBe('stack')
    expect(effectiveRecentsMode({ recentsMode: 'spread' })).toBe('spread')
    expect(effectiveRecentsMode({ recentsMode: 'off' })).toBe('off')
  })
})

describe('applyDesktopStacks', () => {
  const baseApp = makeItem({ id: 'app:docs', kind: 'app', tile: 'docs', draggable: true })
  const baseFolder = makeItem({ id: 'folder:/Work', kind: 'folder', path: '/Work' })
  const baseWidget = makeItem({ id: 'widget:1', kind: 'widget', path: '/pin.docx' })
  const recentA = makeItem({
    id: 'file:/music/track1.flac',
    kind: 'file',
    title: 'track1.flac',
    ext: 'flac',
    path: '/music/track1.flac',
    mtimeMs: 100,
    alias: false,
  })
  const recentB = makeItem({
    id: 'file:/music/track2.flac',
    kind: 'file',
    title: 'track2.flac',
    ext: 'flac',
    path: '/music/track2.flac',
    mtimeMs: 250,
    alias: false,
  })
  const aliasDoc1 = makeItem({
    id: 'alias:/docs/a.docx',
    kind: 'file',
    title: 'a.docx',
    ext: 'docx',
    path: '/docs/a.docx',
    alias: true,
  })
  const aliasDoc2 = makeItem({
    id: 'alias:/docs/b.docx',
    kind: 'file',
    title: 'b.docx',
    ext: 'docx',
    path: '/docs/b.docx',
    alias: true,
  })
  const aliasPdf = makeItem({
    id: 'alias:/docs/spec.pdf',
    kind: 'file',
    title: 'spec.pdf',
    ext: 'pdf',
    path: '/docs/spec.pdf',
    alias: true,
  })

  it('collapses non-alias recents into a single stack:recent tile when recentsMode is stack', () => {
    const onOpenStack = vi.fn()
    const out = applyDesktopStacks(
      [baseApp, baseFolder, aliasDoc1, recentA, recentB, baseWidget],
      {
        recentsMode: 'stack',
        useStacks: false,
        hiddenRecentPaths: new Set(),
        strings,
        onOpenStack,
      },
    )
    expect(out.map((item) => item.id)).toEqual([
      'app:docs',
      'folder:/Work',
      'alias:/docs/a.docx',
      STACK_RECENT_ID,
      'widget:1',
    ])
    const recentStack = out.find((item) => item.id === STACK_RECENT_ID)!
    expect(recentStack.kind).toBe('stack')
    expect(recentStack.stackCategory).toBe('recent')
    expect(recentStack.mtimeMs).toBe(250)
    expect(recentStack.stackItems?.map((i) => i.id)).toEqual([
      'file:/music/track1.flac',
      'file:/music/track2.flac',
    ])
    recentStack.open()
    expect(onOpenStack).toHaveBeenCalledWith(STACK_RECENT_ID)
  })

  it('filters hiddenRecentPaths only from non-alias recents and drops stack:recent if empty', () => {
    const partial = applyDesktopStacks([baseApp, aliasDoc1, recentA, recentB], {
      recentsMode: 'stack',
      useStacks: false,
      hiddenRecentPaths: new Set(['/music/track1.flac', '/docs/a.docx']),
      strings,
    })
    const stack = partial.find((item) => item.id === STACK_RECENT_ID)!
    expect(stack.stackItems?.map((i) => i.path)).toEqual(['/music/track2.flac'])
    expect(partial.some((item) => item.id === 'alias:/docs/a.docx')).toBe(true)

    const empty = applyDesktopStacks([baseApp, recentA], {
      recentsMode: 'stack',
      useStacks: false,
      hiddenRecentPaths: new Set(['/music/track1.flac']),
      strings,
    })
    expect(empty.map((item) => item.id)).toEqual(['app:docs'])
  })

  it('removes non-alias recents completely when recentsMode is off and keeps spread when spread', () => {
    const hidden = applyDesktopStacks([baseApp, aliasDoc1, recentA], {
      recentsMode: 'off',
      useStacks: false,
      hiddenRecentPaths: new Set(),
      strings,
    })
    expect(hidden.map((item) => item.id)).toEqual(['app:docs', 'alias:/docs/a.docx'])

    const spread = applyDesktopStacks([baseApp, aliasDoc1, recentA, recentB], {
      recentsMode: 'spread',
      useStacks: false,
      hiddenRecentPaths: new Set(['/music/track1.flac']),
      strings,
    })
    expect(spread.map((item) => item.id)).toEqual([
      'app:docs',
      'alias:/docs/a.docx',
      'file:/music/track2.flac',
    ])
  })

  it('groups categories with 2+ files when useStacks is enabled and leaves singletons unstacked', () => {
    const onOpenStack = vi.fn()
    const out = applyDesktopStacks(
      [baseApp, baseFolder, aliasDoc1, aliasPdf, aliasDoc2, recentA, recentB, baseWidget],
      {
        recentsMode: 'stack',
        useStacks: true,
        hiddenRecentPaths: new Set(),
        strings,
        onOpenStack,
      },
    )
    expect(out.map((item) => item.id)).toEqual([
      'app:docs',
      'folder:/Work',
      `${STACK_CATEGORY_ID_PREFIX}docs`,
      'alias:/docs/spec.pdf',
      STACK_RECENT_ID,
      'widget:1',
    ])
    const docsStack = out.find((item) => item.id === `${STACK_CATEGORY_ID_PREFIX}docs`)!
    expect(docsStack.kind).toBe('stack')
    expect(docsStack.stackCategory).toBe('docs')
    expect(docsStack.stackItems?.map((i) => i.id)).toEqual([
      'alias:/docs/a.docx',
      'alias:/docs/b.docx',
    ])
    docsStack.open()
    expect(onOpenStack).toHaveBeenCalledWith(`${STACK_CATEGORY_ID_PREFIX}docs`)
  })
})
