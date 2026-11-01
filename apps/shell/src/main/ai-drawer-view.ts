import { join } from 'node:path'
import { shell, WebContentsView } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'

import { rendererUrl, safeExternalUrl } from '@genoffice/electron-utils'
import { drawerOverlayBounds, type AiDockPrefs } from '../shared/desktop-geometry'
import type { AiPetDragReport } from '../shared/home-api'
import { applyUiScaleTo } from './ui-scale'

/**
 * The AI drawer's native overlay (W2). While a document tab is active, its
 * WebContentsView paints above the whole Home renderer — the HTML drawer and
 * the pet included — so this sibling view hosts the drawer's entire
 * document-mode presence, in two shapes driven by the same `aiDock` prefs:
 * expanded, a WebContentsView at the window's right edge, as wide as
 * `aiDockWidth()` and the full content height (drawerOverlayBounds), loading
 * the shell renderer's ask-panel mount (`?view=ask-panel`, the same
 * one-bundle-two-branches trick the manual plays with `?mode=help`); collapsed,
 * a pet-sized transparent view carrying the floating pet
 * (petOverlayBounds) — the drawer's whole presence then, and the only way
 * back into the panel, because Home's HTML pet is painted under the document
 * and would otherwise be unreachable. The entry renders the panel plus the
 * floating pet — the panel stays mounted in both states (hidden while
 * collapsed — the streaming-keeps-streaming contract below), so the pet is
 * the collapsed state's only *visible* affordance, never its only listener.
 * The entry also answers a ready handshake: the panel's subscriptions arm
 * only after the renderer's own boot (an await chain of language, theme and
 * dictionary before the first render), so a message flushed at the load
 * event alone would reach a renderer with no listener for it and vanish —
 * the panel signals `home:ask-panel-ready` once its listeners exist, and
 * nothing buffered here moves before that (markPanelReadyFor).
 *
 * Z-order: the view sits above every document/browser view of the window's
 * contentView — addChildView re-adds an existing child as the topmost
 * (documented Electron semantics), so every shown sync re-asserts it over
 * views added while the overlay is up (a tab opened mid-conversation, a
 * browser tab's page sibling — the annotate layer included: the pet stays
 * clickable above a page mid-annotation, which is exactly when the person
 * reaches for it). Pinned desktop widgets would outrank it — they
 * are child *windows* of the shell, and the OS stacks a child window above
 * its parent's content however the views are ordered — but that ordering is
 * unreachable in practice: widgets show only while Home is the active tab
 * (setPinsHostSurfaceActive), and the overlay exists only while a document
 * is. Had both ever shown, the intent is the overlay's — it is a temporary
 * floating layer over a presentation of work, the widget is furniture — so
 * this is recorded as a known, benign gap rather than fought with window
 * re-parenting.
 *
 * Mounting and hiding, never destroying on state changes: the view is created
 * lazily (the first time a document tab shows, drawer open or collapsed) and
 * then survives drawer opens and closes, tab switches and HTML fullscreen
 * hidden — the same "the panel stays mounted, closing only hides it"
 * contract the HTML drawer keeps (a streaming answer keeps streaming). It
 * dies with the shell window, like every tab view — an in-flight AgentLoop
 * in this copy is interrupted, the same tradeoff closing the window already
 * makes. The Home renderer's own panel copy is a second, independent
 * session: each mount claims its own chat id (P0-1 — the overlay's is
 * `kb-overlay-ask`, Home's is `kb-ask`), so a question asked over a
 * document is not in Home's thread list and vice versa. Ask-intent handoffs
 * that arrive while this view is the visible drawer are forwarded to it
 * through the main process (P0-2, see deliverToPanel), with Home's covered
 * copy kept out of the routing.
 *
 * The panel entry's URL rides the `help` scheme host — the shell renderer's
 * own root in the renderer protocol (`installRendererProtocol` maps `help` to
 * the shell's renderer directory); the `view=ask-panel` query routes the
 * bundle to the panel entry, exactly as `mode=help` routes it to the manual.
 * The view's surface itself is transparent (setBackgroundColor at creation):
 * the pet-only state must show the document straight through around the
 * bird, and the expanded state paints its own opaque panel over the same
 * transparent surface. Because a WebContentsView hit-tests and takes focus
 * over its whole rect however transparent it paints, transparency is only
 * safe behind the shape-known gate (applyVisibility): the view stays hidden
 * until the entry's ready ping — the boot's shape-unknown blank, a reloading
 * or never-loaded or crashed renderer would otherwise be an invisible
 * click-eating zone over the document.
 *
 * The pet drag runs on this same transparency: while the gesture lasts the
 * view is temporarily expanded to the whole window (applyPetDragReport) —
 * static and window-wide, so the pointer cannot leave it and its client
 * coordinates are its window position whatever the input device — and the
 * release shrinks it back (the prefs write, or the end report). See
 * applyPetDragReport for why the view must never *follow* the pointer.
 */
export interface AiDrawerOverlayState {
  /**
   * The drawer's persisted prefs. `collapsed` no longer hides anything: it
   * shrinks the view from the drawer's footprint to the pet-only one — the
   * pet is the drawer's whole reachable presence while a document shows, so
   * the overlay must stay up in both states.
   */
  dock: AiDockPrefs
  /** the interface scale, sizing the footprint like every chrome band */
  scale: number
  /** a document tab is the active tab (any kind but `home` covers the renderer) */
  docActive: boolean
  /**
   * The active tab's view covers the whole window (HTML fullscreen — a slides
   * slideshow — or the slides show's content bleed). The overlay hides for the
   * presentation's duration rather than intruding on it: the drawer state
   * stays recorded and the view returns on leave. Hiding, not destroying, so
   * the panel's session survives the round trip.
   */
  suppressed: boolean
  /** the window's live content area */
  window: { width: number; height: number }
}

/** the overlay's face the TabManager drives; no-op safe after teardown */
export interface AiDrawerOverlay {
  /** apply the state: mount/hide the view and fit its bounds */
  sync(state: AiDrawerOverlayState): void
  /** drop the view (tests, explicit teardown); the window's own close does it implicitly */
  destroy(): void
  /**
   * Push one message to the panel copy's renderer (P0-2 — the ask-intent
   * forward). Buffered until the view exists and its panel copy signaled
   * itself ready (markPanelReadyFor): a forwarded ask can beat the very prefs
   * write that mounts this view (Home's openAskDock hands off in the same
   * breath), and a flush keyed on the load alone would beat the panel's own
   * listeners — the entry boots behind an await chain (language, theme,
   * dictionary) before its first render — so the question would land in a
   * renderer nobody is listening in and be dropped.
   */
  deliverToPanel(channel: string, payload: unknown): void
  /**
   * The panel copy's ready signal arrived over `home:ask-panel-ready` with
   * `sender` as its webContents: flush the buffer, but only when the sender
   * is this view's own live webContents — the channel is fire-and-forget and
   * any renderer sharing the shell preload can send it, so identity, not the
   * arrival, vouches the claim (another renderer's ready ping must never arm
   * the overlay's flush). A reload (did-start-navigation) clears the armed
   * flag again: the renderer that replaces the old one has to re-signal.
   */
  markPanelReadyFor(sender: WebContents): void
  /**
   * One surface request from the pet drag (`home:ai-pet-drag`): `start`
   * expands the view to the whole window for the gesture's duration, `end`
   * re-fits the synced footprint. Window-wide and static is what makes the
   * drag correct: a pet-sized renderer cannot capture the pointer, and a
   * view that *follows* the pointer would make the drag's math depend on
   * whether the input source shifts its client coordinates with the moved
   * view — real pointers do, synthetic and assistive input does not. On a
   * static window-wide surface every event's client position is the
   * pointer's window position whatever the device, so the renderer's
   * pointer-minus-grab math is exact for all of them, and the pointer cannot
   * leave the view, so the release always arrives. `end` matters because the
   * release's own prefs write only re-fits the view when the position
   * actually changed (the watcher dedups an identical one). Identity-checked
   * like the ready ping; `start` is honored only in the pet-only state.
   */
  applyPetDragReport(sender: WebContents, report: AiPetDragReport): void
  /**
   * The overlay view's live webContents, or undefined while it is not
   * mounted (or already gone). The sender gates that must accept the panel
   * copy — browserskill:execute among them (browser-agent.ts) — read it.
   */
  panelWebContents(): WebContents | undefined
}

/**
 * The window-shaped effects the overlay cannot reach on its own. Injected by
 * the shell window's wiring (window-lifecycle.ts) so this module stays
 * testable with plain fakes.
 */
export interface AiDrawerOverlayDeps {
  /**
   * Hand the keyboard back to the active tab's view when the overlay hides
   * or shrinks to the pet (P1-3): the composer inside the overlay held the
   * focus, and a hidden — or pet-sized — WebContentsView keeps it; without
   * this, keystrokes strand in a surface the person cannot see. The
   * TabManager's focusActiveView is the verb.
   */
  focusActiveView: () => void
}

/** how many messages may wait for the panel's renderer; oldest dropped past it */
const MAX_PENDING_PANEL_MESSAGES = 25

export function createAiDrawerOverlay(
  shellWindow: BrowserWindow,
  deps: AiDrawerOverlayDeps = { focusActiveView: () => undefined },
): AiDrawerOverlay {
  let view: WebContentsView | null = null
  /** the interface scale the overlay's renderer last carried (`--ui-scale`) */
  let appliedScale = 1
  /** whether the last sync left the view showing — the hide path's guard */
  let shown = false
  /**
   * Whether the last synced prefs left the view pet-only. The pet drag's
   * `start` is honored only in this state: a drawer-shaped view must never
   * become a window-wide drag surface on a stray report.
   */
  let petMode = false
  /**
   * The layout the last sync carried (scale + prefs): the pet drag's `end`
   * and a crashed renderer re-fit the view from it — the release's own prefs
   * write re-fits it too, but only when the position changed, and a drag's
   * window-wide surface must never outlive its gesture.
   */
  let lastLayout: { scale: number; dock: AiDockPrefs } | null = null
  /** messages waiting for the panel's renderer to be ready (deliverToPanel) */
  const pendingPanelMessages: Array<{ channel: string; payload: unknown }> = []
  /**
   * Whether the view's renderer finished a load — the load-failure report's
   * baseline (a failure after a good load is not a dead surface), and no
   * longer the delivery trigger: the panel's listeners arm later than the
   * load, so the ready flag below owns the flush.
   */
  let panelLoaded = false
  /** whether the panel copy signaled itself ready (markPanelReadyFor) */
  let panelReady = false

  const applyScale = (wc: WebContents, scale: number): void => {
    appliedScale = scale
    applyUiScaleTo(wc, scale)
  }

  const createView = (scale: number): WebContentsView => {
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // background throttling stays at its default: the view is hidden
        // while Home is the active tab, during a presentation, and until the
        // entry's first ready ping (the shape-known gate in applyVisibility)
        // — those are the moments its renderer sleeps, like any hidden view
        // (issue #27). While it shows — the drawer or the pet — it is a live
        // surface like any visible one. The hibernation sweeper does not
        // count it: it is not a tab, it never sleeps by idleness, and its
        // lifetime is the window's own.
      },
    })
    view.webContents.setWindowOpenHandler(({ url }) => {
      const target = safeExternalUrl(url)
      if (target) void shell.openExternal(target)
      return { action: 'deny' }
    })
    // transparent surface (the View's own background — the documented
    // companion of a transparent-hosting window): the pet-only state is a
    // pet-sized view floating over the document, and everything that is not
    // the bird must show the page straight through (the expanded state
    // paints its own opaque panel over the same surface, so transparency
    // costs it nothing)
    view.setBackgroundColor('#00000000')
    // the view's URL is main-authored and constant — the panel entry is a
    // mounted React tree, not a page of links — so nothing legitimate
    // navigates it. Denying will-navigate keeps a renderer that turned
    // hostile from walking itself somewhere else, which is what lets the
    // widened browserskill gate trust this webContents by identity; the
    // window-open deny above covers the other direction.
    view.webContents.on('will-navigate', (event) => {
      event.preventDefault()
    })
    // The shared ui-scale boot (installUiScale) does reach this view's
    // webContents — `web-contents-created` fires for WebContentsView
    // renderers too — but the sync path here cannot rely on its timing: the
    // scale this overlay was handed is the authoritative one for the view,
    // and the load-time application must not race the first paint. The
    // load-time application below is therefore unconditional (an
    // executeJavaScript racing the load can fail silently); the sync-time one
    // only on change; both write the same inline `--ui-scale`, so the double
    // application with the shared boot is harmless.
    view.webContents.once('did-finish-load', () => {
      applyScale(view.webContents, scale)
      // the load only proves the bundle painted, not that the panel's
      // listeners exist (the entry boots behind an await chain before its
      // first render), so the buffered messages keep waiting for the ready
      // handshake; this flag stays what the failure report below keys on
      panelLoaded = true
    })
    // a navigation (a reload, a retry) means a renderer that must re-signal
    // before anything buffered here flushes into it — but only a main-frame
    // document swap does that: an in-place hop (a fragment, a pushState)
    // keeps the very React app that already signaled, and resetting there
    // would strand the buffer with no second ping ever coming. The reset
    // also re-hides: a reloading renderer paints a transparent blank, and a
    // blank must never eat clicks (the replacement's ping re-shows it)
    view.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isInPlace || !isMainFrame) return
      panelReady = false
      applyVisibility()
    })
    // a crashed renderer leaves the armed handshake and the buffered messages
    // pointing at a process that no longer exists: reset the flag and retry
    // the panel load once — the did-fail-load shape, never a loop — so the
    // replacement renderer gets its own boot and must re-signal before
    // anything moves. The reset also hides the view (applyVisibility: a dead
    // surface must not eat clicks) until that replacement signals; a second
    // crash after the retry stands down the same way. A clean exit is our
    // own teardown (destroy, the window's close): there is nothing to
    // recover and the view is on its way out.
    let crashRetried = false
    view.webContents.on('render-process-gone', (_event, details) => {
      if (details?.reason === 'clean-exit') return
      panelReady = false
      // a pet drag's window-wide surface must not outlive its renderer: the
      // gesture's listeners (and its end report) died with the process, so a
      // full-window transparent view would sit over the document eating
      // every click — re-fit the synced footprint here, whatever it is
      refitAfterGesture()
      applyVisibility()
      if (crashRetried || view.webContents.isDestroyed()) return
      crashRetried = true
      loadPanelUrl(view.webContents)
    })
    // a failed load leaves a dead surface floating over the document — and
    // the pet that could dismiss it lives inside the very renderer that did
    // not load. Retry once (the common failure is a dev server still
    // booting), then report and hide: a transparent dead view would eat
    // every click over the document with nothing to show for it, so it stays
    // hidden until a load succeeds (the ready ping re-shows it) — better
    // than a blank pane nobody can close or click through. Subframe
    // failures (an image inside an answer) are not the panel's load.
    let retried = false
    view.webContents.on(
      'did-fail-load',
      (_event, code: number, description: string, failedUrl: string, isMainFrame: boolean) => {
        if (!isMainFrame) return
        // ERR_ABORTED (-3) is a navigation superseding itself (the retry, a
        // redirect): retrying it would loop
        if (code === -3 || retried) {
          if (code !== -3 && !panelLoaded) {
            console.warn(`[shell] ai drawer overlay failed to load (${description}): ${failedUrl}`)
            // the stand-down: the never-loaded surface hides, and only a
            // successful reload (or the view's recreation) brings it back
            view.setVisible(false)
          }
          return
        }
        retried = true
        loadPanelUrl(view.webContents)
      },
    )
    loadPanelUrl(view.webContents)
    return view
  }

  const loadPanelUrl = (wc: WebContents): void => {
    wc.loadURL(rendererUrl(process.env.ELECTRON_RENDERER_URL, 'help', { view: 'ask-panel' })).catch(
      () => {
        // the did-fail-load handler above owns the failure; the rejection is
        // only kept from becoming an unhandled one
      },
    )
  }

  const deliverPending = (): void => {
    const wc = view?.webContents
    if (!wc || wc.isDestroyed() || !panelReady) return
    for (const message of pendingPanelMessages.splice(0)) wc.send(message.channel, message.payload)
  }

  /**
   * The view paints only when the last sync wants it showing AND the panel
   * copy signaled its shape (the ready ping — which is also the flush gate):
   * every state that is not a live, shaped surface paints either nothing or
   * a transparent blank, and a WebContentsView hit-tests and takes focus
   * over its whole rect however transparent it paints — an invisible
   * click-eating zone. The boot's shape-unknown blank, a reloading renderer,
   * and a never-loaded or crashed one all stay hidden here; the entry's ping
   * is what shows the view (and re-shows it after a reload).
   */
  const applyVisibility = (): void => {
    view?.setVisible(shown && panelReady)
  }

  /**
   * Re-fit the view to the last synced layout against the live window: the
   * pet drag's `end` report and a crashed renderer both call this — the
   * release's own prefs write re-fits the view too, but only when the
   * position actually changed (the watcher dedups an identical one), and a
   * window-wide drag surface must never outlive its gesture.
   */
  const refitAfterGesture = (): void => {
    const live = view
    if (!live || live.webContents.isDestroyed() || !lastLayout) return
    if (shellWindow.isDestroyed()) return
    const { width, height } = shellWindow.getContentBounds()
    if (width <= 0 || height <= 0) return
    live.setBounds(drawerOverlayBounds({ width, height }, lastLayout))
  }

  // the window's teardown destroys its contentView's children with it — the
  // overlay's renderer dies like every tab's. Only the reference must go, or
  // a late sync would act on a dead view.
  shellWindow.once('closed', () => {
    view = null
    panelReady = false
    pendingPanelMessages.length = 0
  })

  return {
    sync(state: AiDrawerOverlayState): void {
      if (shellWindow.isDestroyed()) return
      // the mode this sync leaves the view in: the pet-only state is what
      // gates the drag surface below, and the transition into it is what
      // returns the keyboard (a drawer that collapsed under the person)
      const nextPetMode = state.dock.collapsed
      const wasPetMode = petMode
      const wasShown = shown
      // the overlay is the drawer's whole document-mode presence: it shows
      // whenever a document tab is active, whatever the prefs say — the
      // prefs only pick which footprint (the drawer's or the pet's own)
      const show = state.docActive && !state.suppressed
      if (!show) {
        // hidden, never destroyed: the active tab and a presentation decide
        // visibility, and the panel's thread outlives both flipping back.
        // The hide is an applied change, so the mode state lands here too.
        shown = false
        petMode = nextPetMode
        lastLayout = { scale: state.scale, dock: state.dock }
        applyVisibility()
        // the composer inside the overlay held the keyboard, and a hidden
        // view keeps it: hand focus back to whatever owns the window now (the
        // TabManager's own focus verb — the active tab's view, or the shell
        // renderer when Home is the tab). Only on a real hide: a sync that
        // never showed this overlay must not move anyone's focus.
        if (wasShown) deps.focusActiveView()
        return
      }
      // a minimized or mid-restore window reports a degenerate rect: apply
      // nothing — not the bounds, not the mode, not the visibility — and keep
      // the last good everything. Swallowing the mode here would eat the
      // collapse transition's focus hand-back on the next good sync (it
      // would see the mode as already flipped), so the guard must come
      // before any state lands.
      const { width, height } = state.window
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return
      const live = view ?? (view = createView(state.scale))
      // the mode and layout land only with the bounds they describe: the
      // drag surface's gate and the gesture re-fit read what was actually
      // applied, never a state the window refused
      petMode = nextPetMode
      lastLayout = { scale: state.scale, dock: state.dock }
      live.setBounds(drawerOverlayBounds(state.window, { scale: state.scale, dock: state.dock }))
      // the entry opts into `zoom: var(--ui-scale)` like the app frame, so
      // the drawer's content reads at the same size whichever layer hosts it
      if (state.scale !== appliedScale) applyScale(live.webContents, state.scale)
      // re-adding an existing child re-orders it topmost: the overlay must
      // lead every view added since it last showed (a new tab's view, a
      // browser page sibling) without anyone tracking those additions
      shellWindow.contentView.addChildView(live)
      shown = true
      // shape-known gate: hidden until the entry's ready ping, whatever the
      // sync wants — applied after `shown` so the gate reads this sync's
      // intent, not the previous one's
      applyVisibility()
      // the drawer collapsed under the person: the panel behind the pet is
      // hidden but this still-visible view would keep the composer's
      // keyboard — P1-3's reasoning, the pet-only shrink's edition. Only on
      // the real transition: a sync that already was pet-only (a petPos
      // write) must not move anyone's focus.
      if (wasShown && !wasPetMode && nextPetMode) deps.focusActiveView()
    },
    deliverToPanel(channel: string, payload: unknown): void {
      pendingPanelMessages.push({ channel, payload })
      if (pendingPanelMessages.length > MAX_PENDING_PANEL_MESSAGES) {
        pendingPanelMessages.splice(0, pendingPanelMessages.length - MAX_PENDING_PANEL_MESSAGES)
      }
      deliverPending()
    },
    markPanelReadyFor(sender: WebContents): void {
      // identity, not the arrival, vouches the sender: the ready channel is
      // fire-and-forget and any renderer sharing the shell preload can send
      // it, so only this view's live webContents may arm the flush
      const wc = view?.webContents
      if (!wc || wc.isDestroyed() || sender !== wc) return
      panelReady = true
      deliverPending()
      // the ping is also the shape-known signal: the entry knows which of
      // its two shapes it is painting (a transparent blank never shows), so
      // the view paints from here — including after a reload, whose
      // navigation reset had re-hidden it
      applyVisibility()
    },
    applyPetDragReport(sender: WebContents, report: AiPetDragReport): void {
      // identity, not the arrival, vouches the sender (the channel is open
      // to any renderer sharing the preload); the drag surface itself is
      // renderer-territory — this only hosts it
      const live = view
      if (!live || live.webContents.isDestroyed() || sender !== live.webContents) return
      if (shellWindow.isDestroyed()) return
      if (report.start) {
        // only the pet-only state may grow a drag surface: a drawer-shaped
        // view must never become window-wide on a stray report
        if (!petMode) return
        const { width, height } = shellWindow.getContentBounds()
        // a minimized or mid-restore window reports a degenerate rect: the
        // report is dropped, and the renderer's own gate keeps its gesture
        // waiting for the surface that never came
        if (width <= 0 || height <= 0) return
        // the drag's surface: the whole window, transparent, for the
        // gesture's duration. The pointer cannot leave it, so the release
        // always arrives, and its client coordinates are window-true for
        // every input model — real or synthetic — because the surface never
        // moves. The release's prefs write (or the end report below) is what
        // shrinks it back.
        live.setBounds({ x: 0, y: 0, width, height })
      }
      if (report.end) refitAfterGesture()
    },
    panelWebContents(): WebContents | undefined {
      const wc = view?.webContents
      return wc && !wc.isDestroyed() ? wc : undefined
    },
    destroy(): void {
      const live = view
      view = null
      panelReady = false
      pendingPanelMessages.length = 0
      if (!live) return
      if (!shellWindow.isDestroyed()) shellWindow.contentView.removeChildView(live)
      if (!live.webContents.isDestroyed()) live.webContents.close()
    },
  }
}
