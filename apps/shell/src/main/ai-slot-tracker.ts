import type { Rect } from '../shared/tab-drag-geometry'

/**
 * The AI-slot tracker (main side, pure): the docs app's reserved panel slot,
 * as its renderer measured it, converted into window pixels and gated for
 * use. The app embeds the global drawer's space into its own layout while
 * hosted — the drawer then fits EXACTLY the slot (nothing is covered, the
 * document reflows around it) instead of floating over the window's right
 * edge.
 *
 * The flow: the app's renderer measures the slot with getBoundingClientRect
 * (its viewport = the tab view, so the numbers are view-local) and reports
 * over `docs:ai-slot-rect`; the TabManager adds the view's bounds origin
 * (window px) and hands the result here. Freshness is the whole point:
 *
 * - a report is keyed to the webContents that measured it — a hibernated tab
 *   revives with a new webContents, so its old rect can never match again;
 * - a tab that stops being active is marked stale: its layout may drift
 *   while hidden (a window resize the hidden renderer never re-reported),
 *   and the overlay falls back to the window-edge geometry until the tab's
 *   own fresh report lands (main asks for one on activation);
 * - the interface scale at report time is recorded: a scale change can move
 *   every view and zoom some renderers, so a rect measured under another
 *   scale is refused.
 *
 * Injected nothing, Electron nothing — pure bookkeeping the tests pin and
 * the TabManager owns.
 */

/** one usable slot report, in window (content-area) pixels */
export interface AiSlotReport {
  /** the tab's live webContents id — the identity the report is keyed to */
  wcId: number
  /** the slot's window-pixel rect */
  rect: Rect
}

interface TrackedSlot {
  report: AiSlotReport
  /** the interface scale the renderer measured under */
  scale: number
  /** false once the owner tab was hidden — a fresh report clears it */
  fresh: boolean
}

/** the rect shape the renderer sends (view-local px, unvalidated numbers) */
export type SlotRectReport = Rect

export interface AiSlotTracker {
  /**
   * Record one renderer report: `viewBounds` is the reporting tab's view
   * bounds in window px (the report's viewport origin), `rect` the
   * view-local measurement. A degenerate report (a collapsed slot measuring
   * zero) is ignored — a slot that reserves no space is not a slot.
   */
  report(wcId: number, viewBounds: Rect, rect: SlotRectReport, scale: number): void
  /** mark the report of one webContents stale (its tab was hidden) */
  markStale(wcId: number): void
  /**
   * The usable slot for the active tab, or null: the report must be fresh,
   * keyed to the active tab's live webContents, measured under the current
   * interface scale, and non-degenerate.
   */
  slotFor(wc: { id: number } | null | undefined, scale: number): Rect | null
}

export function createAiSlotTracker(): AiSlotTracker {
  let tracked: TrackedSlot | null = null
  return {
    report(wcId, viewBounds, rect, scale) {
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)
      if (width <= 0 || height <= 0) {
        // a degenerate report (the slot collapsed to nothing mid-session) is
        // a layout event, not noise: whatever the same webContents measured
        // before no longer describes it — mark it stale, so the window-edge
        // fallback heals one round trip sooner than the next activation's
        // re-request would. A first-ever degenerate report arms nothing.
        if (tracked?.report.wcId === wcId) tracked.fresh = false
        return
      }
      tracked = {
        report: {
          wcId,
          rect: {
            x: Math.round(viewBounds.x + rect.x),
            y: Math.round(viewBounds.y + rect.y),
            width,
            height,
          },
        },
        scale,
        fresh: true,
      }
    },
    markStale(wcId) {
      if (tracked?.report.wcId === wcId) tracked.fresh = false
    },
    slotFor(wc, scale) {
      if (!wc || !tracked || !tracked.fresh) return null
      if (tracked.report.wcId !== wc.id) return null
      if (tracked.scale !== scale) return null
      return tracked.report.rect
    },
  }
}
