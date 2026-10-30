import type { DeepLinkPayload } from '../shared/home-api'
import { HOME_CHANNELS } from '../shared/home-api'

/**
 * Deep-link delivery: routes one parsed genoffice:// payload to the surface
 * it names. Extracted from index.ts with everything window-shaped injected,
 * so the routing matrix — which channel each verb rides, and what a link
 * that beats app-ready does — is testable; index.ts wires the real windows.
 *
 * ask and desktop are Home view state and ride the home:deep-link channel to
 * the renderer; palette summons the command palette and open routes a
 * document through the same router a file drop takes, both main-side. A link
 * arriving before app ready (a cold macOS protocol launch) queues in arrival
 * order and delivers when the ready flush runs.
 */
export interface DeepLinkRouterDeps {
  /** app.isReady(): links that beat it queue until the flush */
  isReady: () => boolean
  /** focus the shell window — a background launch still surfaces its target */
  revealShellWindow: () => void
  /** bring the Home window to the front */
  summonHome: () => void
  /** Home with the command palette open */
  summonPalette: () => void
  /** open a document in its owning app */
  routeDocumentPath: (path: string) => void
  /** one message to the shell renderer */
  sendToShellRenderer: (channel: string, payload?: unknown) => void
}

export interface DeepLinkRouter {
  /** route one parsed link now, or queue it for the ready flush */
  deliver: (payload: DeepLinkPayload) => void
  /** deliver everything that queued before ready, in arrival order */
  flushPending: () => void
}

export function makeDeepLinkRouter(deps: DeepLinkRouterDeps): DeepLinkRouter {
  /** deep links that arrived before the app was ready, in arrival order */
  const pendingDeepLinks: DeepLinkPayload[] = []
  const deliver = (payload: DeepLinkPayload): void => {
    // open-url can beat ready on a cold macOS protocol launch; the window and
    // renderer do not exist yet — links queue in arrival order and deliver
    // once whenReady has built them (a single slot made the second link
    // silently overwrite the first)
    if (!deps.isReady()) {
      pendingDeepLinks.push(payload)
      return
    }
    if (payload.view === 'palette') {
      deps.summonPalette()
      return
    }
    if (payload.view === 'open') {
      // focus the shell first so a background launch still surfaces the document
      deps.revealShellWindow()
      if (payload.path) deps.routeDocumentPath(payload.path)
      return
    }
    deps.summonHome()
    deps.sendToShellRenderer(HOME_CHANNELS.deepLink, payload)
  }
  return {
    deliver,
    flushPending: () => {
      for (const payload of pendingDeepLinks.splice(0)) deliver(payload)
    },
  }
}
