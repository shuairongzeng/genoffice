import { join } from 'node:path'
import { shell, WebContentsView } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'

import { rendererUrl, safeExternalUrl } from '@genoffice/electron-utils'
import { dockOverlayBounds } from '../shared/desktop-geometry'
import type { DockHotEdgeReport } from '../shared/home-api'
import { applyUiScaleTo } from './ui-scale'

/**
 * The doc-mode dock's native overlay: while a document tab is active, Home's
 * renderer (and its HTML dock) is covered by the document's WebContentsView,
 * so this sibling view mirrors the drawer overlay's trick — a native
 * WebContentsView above the covering document, loading the shell renderer's
 * dock entry (`?view=dock`, the standalone wave-1 Dock component) — with a
 * two-shape state machine instead of the drawer's prefs-driven footprint:
 *
 * - REST: a 3px strip along the window's whole bottom edge (dockOverlayBounds
 *   `strip`). Invisible (the entry's surface is transparent) and inert in
 *   practice: the 3px it intercepts is the last 3px of the document, a
 *   tradeoff accepted for a summonable dock — a taller strip would eat real
 *   document clicks, a pointer-transparent strip cannot exist for a native
 *   view.
 * - REVEALED: the dock rect — the pill WITH its fisheye headroom, centered
 *   and bottom-anchored like Home's own dock, the rect reaching DOWN TO the
 *   window's bottom edge so the strip's footprint stays inside it (the
 *   summoning pointer must not be evicted by the reveal, or the leave would
 *   flicker the dock away the moment it appears). The margins above and
 *   beside the pill are transparent but hit-test (a native view eats clicks
 *   over its whole rect), so the entry reports leave from the pill's own
 *   painted box — see dock-entry.tsx — and the grace timer below absorbs
 *   the rect-margin travel.
 *
 * The transition driver is the entry's own reports over `home:dock-hot-edge`
 * (reportHotEdge, identity-checked): `enter` from the strip reveals; `leave`
 * from the revealed dock arms a ~250ms grace timer and hides back to the
 * strip when it fires; a re-`enter` cancels it — the grace exists because a
 * pointer summoned at the bottom edge but outside the pill's span leaves the
 * grown view instantly (horizontal growth from a full-width strip to a
 * centered pill) and diagonal travel toward an icon must cross that gap
 * without the dock flicker-hiding. Reduced motion changes nothing here: the
 * reveal and the hide are instant bounds swaps in every mode (the dock's only
 * motions are the renderer's fisheye and its 120ms collapse, both already
 * reduced-motion-aware); the grace timer is timing, not animation.
 *
 * Z-order, matching Home's HTML stacking (dock above drawer): the drawer
 * overlay's sync runs BEFORE this one's in every layout pass, so this view
 * ends each pass topmost — a revealed dock stays clickable over an open
 * drawer panel exactly as the HTML dock does over the drawer's scrim, and
 * the reveal itself re-asserts topmost for summons that land between layout
 * passes. The 3px strip riding above the drawer overlay costs the drawer
 * panel's and the pet's own bottom 3px — chrome nobody clicks. A HIDDEN
 * (stood-down) dock is below everything that matters, being invisible.
 *
 * Interface scale: the entry opts into `zoom: var(--ui-scale)` like the ask
 * panel, and applyScale writes that variable onto this renderer's root at
 * load and on every change — without it the pill renders at 100% while the
 * window-sized rect math scales, a third-size pill with dead margins and a
 * mis-scaled fisheye.
 *
 * Load and crash hardening, the drawer overlay's shape: a failed load
 * retries once then hides (an invisible dead strip still eats its 3px —
 * better fully stood down until a sync re-shows); a crashed renderer hides
 * and reloads once (never a loop); and a main-frame navigation disarms the
 * grace timer — resizing a view whose renderer is mid-reload serves nobody.
 * The window blurring or minimizing shrinks a revealed dock back to the
 * strip (a summon nobody can interact with is dead weight), re-armed when
 * the pointer returns.
 *
 * Like the drawer overlay: mounted lazily (the first doc-mode sync), never
 * destroyed on reveal/hide (the same view grows and shrinks — the pet
 * overlay's one-view trick), re-fitted on every sync (resize, scale,
 * suppression flips), and dead with the shell window.
 */
export interface DockOverlayState {
  /** a document tab is the active tab (over Home, the HTML dock is the dock) */
  docActive: boolean
  /** the active tab's view covers the whole window (a presentation): stand down */
  suppressed: boolean
  /** the interface scale, sizing the pill like every chrome band */
  scale: number
  /** the window's live content area */
  window: { width: number; height: number }
  /** the dock's composition — the pill math's inputs (mirrors the renderer's groups) */
  itemCount: number
  separatorCount: number
}

/** the overlay's face the TabManager drives; no-op safe after teardown */
export interface DockOverlay {
  /** apply the state: mount/hide the strip and re-fit whichever shape shows */
  sync(state: DockOverlayState): void
  /** one hot-edge report from the entry's renderer (identity-checked) */
  reportHotEdge(sender: WebContents, report: DockHotEdgeReport): void
  /** drop the view (tests, explicit teardown); the window's own close does it implicitly */
  destroy(): void
}

/** how long the pointer may be off the dock before it hides back to the strip */
const DOCK_REVEAL_GRACE_MS = 250

export function createDockOverlay(shellWindow: BrowserWindow): DockOverlay {
  let view: WebContentsView | null = null
  /** whether the view currently carries the dock rect (true) or the strip */
  let revealed = false
  /** the armed grace timer; 0 = none */
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  /** the live geometry the shapes are cut from, refreshed by every sync */
  let bounds: {
    strip: { x: number; y: number; width: number; height: number }
    dock: { x: number; y: number; width: number; height: number }
  } | null = null
  /** the interface scale the view's renderer last carried (`--ui-scale`) */
  let appliedScale = 1

  const applyScale = (wc: WebContents, scale: number): void => {
    appliedScale = scale
    applyUiScaleTo(wc, scale)
  }

  const applyShape = (): void => {
    const live = view
    if (!live || !bounds) return
    live.setBounds(revealed ? bounds.dock : bounds.strip)
  }

  const cancelHide = (): void => {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  /** shrink to the strip and drop any pending hide: the rest state */
  const shrinkToStrip = (): void => {
    revealed = false
    cancelHide()
    applyShape()
  }

  const createView = (scale: number): WebContentsView => {
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // the view is visible whenever a doc tab is active — the strip
        // paints nothing but still hit-tests its 3px, and the revealed dock
        // is fully live; background throttling only applies while stood down
        // (the Home tab, a presentation), like every hidden view (issue #27)
      },
    })
    view.webContents.setWindowOpenHandler(({ url }) => {
      const target = safeExternalUrl(url)
      if (target) void shell.openExternal(target)
      return { action: 'deny' }
    })
    // transparent surface (the View's own background — the documented
    // companion of a transparent-hosting window): the strip must be
    // invisible and the dock's margins see the document straight through
    view.setBackgroundColor('#00000000')
    // the entry's URL is main-authored and constant — the dock is a mounted
    // React tree, not a page of links. Denying will-navigate keeps a hostile
    // renderer from walking itself somewhere else.
    view.webContents.on('will-navigate', (event) => {
      event.preventDefault()
    })
    // The shared ui-scale boot (installUiScale) reaches this renderer, but
    // the scale THIS overlay was handed is the authoritative one and must
    // not race the pill's first paint — the ask-panel pattern: apply
    // unconditionally at load, then only on change; both write the same
    // inline `--ui-scale`, so the double application is harmless
    view.webContents.once('did-finish-load', () => {
      applyScale(view.webContents, scale)
    })
    // a navigation (the crash retry) means a renderer whose reports and
    // listeners die with the old one: disarm the grace timer so it does not
    // resize a view mid-reload
    view.webContents.on(
      'did-start-navigation',
      (_event, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
        if (isInPlace || !isMainFrame) return
        cancelHide()
      },
    )
    // a crashed renderer leaves a dead surface over the document: hide it
    // (the strip's 3px would still eat clicks) and retry the load once —
    // the did-fail-load shape, never a loop. A clean exit is our own
    // teardown (destroy, the window's close): there is nothing to recover
    let crashRetried = false
    view.webContents.on('render-process-gone', (_event, details) => {
      if (details?.reason === 'clean-exit') return
      shrinkToStrip()
      if (!shellWindow.isDestroyed()) view.setVisible(false)
      if (crashRetried || view.webContents.isDestroyed()) return
      crashRetried = true
      loadDockUrl(view.webContents)
    })
    // a failed load leaves an invisible strip that still intercepts its 3px:
    // retry once (the common failure is a dev server still booting), then
    // hide — stood down until the next sync re-shows, better than a dead
    // band nobody can dismiss
    let retried = false
    view.webContents.on(
      'did-fail-load',
      (_event, code: number, description: string, failedUrl: string, isMainFrame: boolean) => {
        if (!isMainFrame) return
        // ERR_ABORTED (-3) is a navigation superseding itself (the retry, a
        // redirect): retrying it would loop
        if (code === -3 || retried) {
          if (code !== -3) {
            console.warn(`[shell] dock overlay failed to load (${description}): ${failedUrl}`)
            if (!shellWindow.isDestroyed()) view.setVisible(false)
          }
          return
        }
        retried = true
        loadDockUrl(view.webContents)
      },
    )
    loadDockUrl(view.webContents)
    return view
  }

  const loadDockUrl = (wc: WebContents): void => {
    wc.loadURL(rendererUrl(process.env.ELECTRON_RENDERER_URL, 'help', { view: 'dock' })).catch(
      () => {
        // the did-fail-load handler above owns the failure; the rejection is
        // only kept from becoming an unhandled one
      },
    )
  }

  /** a revealed dock the person can no longer reach (blur, minimize): rest */
  const onWindowHidden = (): void => {
    if (!revealed) return
    shrinkToStrip()
  }

  shellWindow.on('blur', onWindowHidden)
  shellWindow.on('minimize', onWindowHidden)

  // the window's teardown destroys its contentView's children with it — only
  // the reference must go, or a late sync would act on a dead view. The
  // blur/minimize hooks die with the window's own listeners
  shellWindow.once('closed', () => {
    view = null
    cancelHide()
  })

  return {
    sync(state: DockOverlayState): void {
      if (shellWindow.isDestroyed()) return
      const show = state.docActive && !state.suppressed
      // a minimized or mid-restore window reports a degenerate rect: keep
      // the last good bounds, the same guard layout() gives every view
      const { width, height } = state.window
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return
      bounds = dockOverlayBounds(
        { width, height },
        { scale: state.scale, itemCount: state.itemCount, separatorCount: state.separatorCount },
      )
      if (!show) {
        // over Home the HTML dock is the dock, and a presentation owns the
        // whole window: the strip stands down entirely (and any pending hide
        // is moot)
        shrinkToStrip()
        view?.setVisible(false)
        return
      }
      const live = view ?? (view = createView(state.scale))
      applyShape()
      // the pill's CSS px are chrome px: the zoom follows the scale like
      // every chrome band, applied on change only (the load-time
      // application is unconditional, above)
      if (state.scale !== appliedScale) applyScale(live.webContents, state.scale)
      // re-adding re-orders topmost among the current children: this view
      // ends the pass above the drawer overlay (the TabManager syncs the
      // drawer's overlay BEFORE this one — see the module docblock), so a
      // revealed dock stays clickable over an open drawer panel, matching
      // the HTML dock's stacking over the drawer's scrim
      shellWindow.contentView.addChildView(live)
      live.setVisible(true)
    },
    reportHotEdge(sender: WebContents, report: DockHotEdgeReport): void {
      // identity, not the arrival, vouches the sender: the channel is
      // fire-and-forget and any renderer sharing the shell preload could
      // send it, so only this view's own live webContents may drive the
      // state machine
      const live = view
      if (!live || live.webContents.isDestroyed() || sender !== live.webContents) return
      if (report.enter) {
        // the summon (from the strip) or the re-enter (mid-grace): either
        // way the dock shows and no hide is pending
        cancelHide()
        if (!revealed) {
          revealed = true
          applyShape()
          // the reveal is a user summons: re-assert topmost so a dock
          // summoned between layout passes immediately sits above the
          // drawer overlay, like the HTML dock over the drawer's scrim
          shellWindow.contentView.addChildView(live)
        }
      }
      if (report.leave) {
        // leaving the strip itself is nothing; leaving the revealed dock
        // arms the grace — a flicker would eat diagonal travel toward an icon
        if (!revealed || hideTimer) return
        hideTimer = setTimeout(() => {
          hideTimer = null
          revealed = false
          applyShape()
        }, DOCK_REVEAL_GRACE_MS)
      }
    },
    destroy(): void {
      const live = view
      view = null
      revealed = false
      cancelHide()
      shellWindow.removeListener('blur', onWindowHidden)
      shellWindow.removeListener('minimize', onWindowHidden)
      if (shellWindow.isDestroyed() || !live) return
      shellWindow.contentView.removeChildView(live)
      if (!live.webContents.isDestroyed()) live.webContents.close()
    },
  }
}
