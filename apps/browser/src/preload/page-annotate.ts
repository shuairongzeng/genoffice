import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

import { createI18n, isRtlLang, type Lang } from '@genoffice/i18n'
import { zh } from '../renderer/i18n/lang/zh'
import { en } from '../renderer/i18n/lang/en'
import { ja } from '../renderer/i18n/lang/ja'
import { ko } from '../renderer/i18n/lang/ko'
import { fr } from '../renderer/i18n/lang/fr'
import { de } from '../renderer/i18n/lang/de'
import { es } from '../renderer/i18n/lang/es'
import { th } from '../renderer/i18n/lang/th'
import { id } from '../renderer/i18n/lang/id'
import { ru } from '../renderer/i18n/lang/ru'
import { ar } from '../renderer/i18n/lang/ar'
import { pt } from '../renderer/i18n/lang/pt'
import { it } from '../renderer/i18n/lang/it'
import { pl } from '../renderer/i18n/lang/pl'
import { cs } from '../renderer/i18n/lang/cs'
import { nl } from '../renderer/i18n/lang/nl'
import { ms } from '../renderer/i18n/lang/ms'
import { he } from '../renderer/i18n/lang/he'
import { hi } from '../renderer/i18n/lang/hi'
import { vi } from '../renderer/i18n/lang/vi'
import { zhTW } from '../renderer/i18n/lang/zh-TW'
import type { PageAnnotateState } from '../shared/ipc'
import { PAGE_CHANNELS } from './annotate/channels'
import { createAnnotateOverlay } from './annotate/overlay'
import type { AnnotateOverlayStrings } from './annotate/overlay'

/**
 * The page view's preload: the annotation layer for untrusted web content.
 * It exposes **nothing** through the context bridge — the overlay, its DOM
 * and this IPC glue all stay in the isolated world, so the page's own scripts
 * cannot see the layer, cannot call any of these channels, and cannot tell
 * annotation mode from normal browsing. Everything the page may legitimately
 * observe is painted pixels.
 *
 * (The locale shards are imported statically rather than through the lazy
 * loader the chrome renderer uses: a sandboxed preload cannot fetch split
 * chunks, and this file is the preload bundle, not a renderer entry — the
 * lazy-load rule governs renderer entries. zh/en resolve synchronously, the
 * rest ride along for the state pushes that carry a non-fallback lang.)
 */
const translate = createI18n({
  zh,
  en,
  ja,
  ko,
  fr,
  de,
  es,
  th,
  id,
  ru,
  ar,
  pt,
  it,
  pl,
  cs,
  nl,
  ms,
  he,
  hi,
  vi,
  'zh-TW': zhTW,
})

let lang: Lang = 'zh'

const strings = (): AnnotateOverlayStrings => ({
  hint: translate(lang, 'annotatePickingHint'),
  notePlaceholder: translate(lang, 'annotateNotePlaceholder'),
  delete: translate(lang, 'annotateDelete'),
  askAi: translate(lang, 'annotateAskAi'),
  dir: isRtlLang(lang) ? 'rtl' : 'ltr',
})

const overlay = createAnnotateOverlay({
  doc: document,
  strings,
  onPin: (draft) => {
    void ipcRenderer
      .invoke(PAGE_CHANNELS.pin, draft)
      .then((id) => {
        // main re-pushes the state that draws the marker; the card waits for it
        if (typeof id === 'string' && id !== '') overlay.openCardFor(id)
      })
      .catch(() => {})
  },
  onNote: (id, note) => {
    ipcRenderer.send(PAGE_CHANNELS.note, { id, note })
  },
  onDelete: (id) => {
    ipcRenderer.send(PAGE_CHANNELS.delete, { id })
  },
  onAsk: (id) => {
    ipcRenderer.send(PAGE_CHANNELS.ask, { id })
  },
  onExit: () => {
    ipcRenderer.send(PAGE_CHANNELS.exit)
  },
})

/** one main → preload push (or sync reply), adopted by the overlay */
function applyAnnotateState(raw: unknown): void {
  const state = raw as PageAnnotateState | null
  if (state === null || typeof state !== 'object') return
  if (typeof state.lang === 'string') lang = state.lang
  overlay.setPageState({ mode: state.mode === true, annotations: state.annotations ?? [] })
}

ipcRenderer.on(PAGE_CHANNELS.state, (_event: IpcRendererEvent, raw: unknown) => {
  applyAnnotateState(raw)
})

// the initial sync: a did-navigate push can beat this preload's listener
// (commit ordering is not guaranteed), so the overlay asks once at startup
void ipcRenderer
  .invoke(PAGE_CHANNELS.sync)
  .then(applyAnnotateState)
  .catch(() => {})
