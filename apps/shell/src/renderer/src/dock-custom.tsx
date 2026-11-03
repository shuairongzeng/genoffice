import type { ReactNode } from 'react'

import type { DockCustomItem } from '../../shared/dock-prefs'
import { desktopAppEntry, type AppTile } from './desktop-items'
import type { DesktopStrings } from './desktop-strings'
import { FileBadge } from './file-badge'
import {
  BrowserGlyph,
  DocsGlyph,
  FolderGlyph,
  GearGlyph,
  KbGlyph,
  MarkdownGlyph,
  PdfGlyph,
  PlugGlyph,
  SheetsGlyph,
  SlidesGlyph,
  SparkGlyph,
  TemplatesGlyph,
} from './app-glyphs'

/**
 * The dock's dragged-in launchers (dockPrefs.customItems), as both mounts
 * render them — Home's pill and the doc-mode overlay's dock share the one
 * composition, and this module is the single place that turns a stored
 * custom item into the label, the squircle tile key and the artwork a
 * DockItem wants. The verb stays the host's business: Home resolves it
 * locally, the overlay routes it over `home:dock-action`.
 */

/** the file or folder name of a path, the label a path custom carries */
const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** one custom launcher's label: the basename for paths, the app tile's word for apps */
export function dockCustomLabel(custom: DockCustomItem, strings: DesktopStrings): string {
  if (custom.kind === 'app') {
    const entry = desktopAppEntry(custom.target)
    return entry ? strings[entry.titleKey] : baseName(custom.target)
  }
  return baseName(custom.target)
}

/** the squircle tile key a custom carries: the app's own, or the path carriers */
export function dockCustomTile(custom: DockCustomItem): string {
  if (custom.kind === 'app') return desktopAppEntry(custom.target)?.tile ?? 'settings'
  return custom.kind
}

/** the artwork of one app tile: the registry's glyph, a spark for a stale id */
function appTileGlyph(tile: AppTile): ReactNode {
  switch (tile) {
    case 'docs':
      return <DocsGlyph />
    case 'sheets':
      return <SheetsGlyph />
    case 'slides':
      return <SlidesGlyph />
    case 'pdf':
      return <PdfGlyph />
    case 'markdown':
      return <MarkdownGlyph />
    case 'html':
    case 'browser':
      return <BrowserGlyph />
    case 'ask':
      return <SparkGlyph />
    case 'kb':
      return <KbGlyph />
    case 'templates':
      return <TemplatesGlyph />
    case 'plugins':
      return <PlugGlyph />
    case 'settings':
      return <GearGlyph />
  }
}

/** one custom launcher's artwork: the app glyph, the folder glyph, or the FileBadge */
export function dockCustomIcon(custom: DockCustomItem): ReactNode {
  if (custom.kind === 'app') {
    const entry = desktopAppEntry(custom.target)
    return entry ? appTileGlyph(entry.tile) : <SparkGlyph />
  }
  if (custom.kind === 'folder') return <FolderGlyph />
  const ext = custom.target.slice(custom.target.lastIndexOf('.') + 1).toLowerCase()
  return <FileBadge ext={ext} size={48} />
}
