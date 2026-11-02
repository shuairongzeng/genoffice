import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostedAiDockState } from '../shared/ipc'

/**
 * The hosted AI slot: the app's own panel slot, re-purposed for the GLOBAL
 * drawer while the shell hosts this app. The slot is an empty placeholder —
 * no panel of ours renders into it; the shell's native drawer overlay docks
 * exactly there. Its visibility follows the global drawer state (pulled once
 * and pushed on every change), and its live rect is reported to the shell
 * main on mount, on every resize (a ResizeObserver on the slot element plus
 * the window's), on the drawer's own flips (the element resizes with them —
 * the observer sees it), and whenever main asks (a re-measure request: the
 * tab was just activated, the interface scale changed).
 *
 * The reserved width is the drawer's stored CSS width MULTIPLIED by the
 * interface scale: the overlay renders the drawer inside a
 * `zoom: var(--ui-scale)` frame, so one CSS px of drawer is scale window px
 * on screen, while this app's own layout is unzoomed — a raw width would
 * reserve less than the drawer paints and the panel would cover the
 * document's edge. The scale is read live (`--ui-scale`, the inline style
 * the shell main keeps on :root) — including inside every report, so a
 * scale change re-renders the width BEFORE the slot is measured, and the
 * re-measure request main sends on a scale change lands on the new shape.
 *
 * The rect is measured with getBoundingClientRect — viewport px, which in
 * this app is window px (the app does not zoom its root; the editor's own
 * zoom lives inside the editor area, not around the slot) — so the shell
 * main only adds the tab view's bounds origin.
 */

/**
 * The interface scale as this renderer sees it: `--ui-scale`, the inline
 * style the shell main writes onto :root (the app frame's zoom reads the
 * same property). Anything unreadable reads as 1.
 */
function readUiScale(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')
  const scale = Number.parseFloat(raw)
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

export function useHostedAiSlot(enabled: boolean): {
  /** the global drawer's state (null until the shell answers, or standalone) */
  dock: HostedAiDockState | null
  /**
   * The width the slot reserves while the drawer is open: the drawer's stored
   * CSS width × the interface scale, rounded to whole px — the overlay's
   * zoomed paint covers exactly this much of the app's unzoomed layout.
   */
  width: number
  /** set on the slot element — the measurement and reports hang off it */
  slotRef: (node: HTMLDivElement | null) => void
} {
  const [dock, setDock] = useState<HostedAiDockState | null>(null)
  const [scale, setScale] = useState(readUiScale)
  const scaleRef = useRef(scale)
  const nodeRef = useRef<HTMLDivElement | null>(null)
  /** set once the shell answered the drawer state — reports are armed only then */
  const shellAnsweredRef = useRef(false)
  shellAnsweredRef.current = dock !== null

  useEffect(() => {
    if (!enabled) return
    const desktop = window.desktop
    if (typeof desktop?.getAiDockState !== 'function') return
    void desktop
      .getAiDockState()
      .then((state) => setDock(state))
      .catch(() => setDock(null))
    return desktop.onAiDockChanged((state) => setDock(state))
  }, [enabled])

  /**
   * Refresh the interface scale; true when it moved. The slot's width style
   * follows the scale, so a measurement taken before the re-render lands
   * would describe the OLD reservation — the caller that sees true returns
   * without reporting, and the report effect's scale dependency re-fires
   * with the element already wearing its new width.
   */
  const refreshScale = useCallback((): boolean => {
    const next = readUiScale()
    if (next === scaleRef.current) return false
    scaleRef.current = next
    setScale(next)
    return true
  }, [])

  // the scale can move under this renderer at any moment (the View menu's
  // write lands as a new inline --ui-scale on :root, from the main process),
  // and neither of the two signals that follow it is ordered against the
  // write itself: the re-measure request may arrive before the style it
  // answers, and the very first write can postdate this tree's mount. The
  // root's style attribute is the one change the renderer can observe
  // directly, so the observer is the ordering-proof half — refreshScale
  // either moves the reservation (the report effect re-fires after the
  // re-render) or reads the same value and does nothing.
  useEffect(() => {
    if (!enabled || typeof MutationObserver !== 'function') return
    const observer = new MutationObserver(() => void refreshScale())
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    return () => observer.disconnect()
  }, [enabled, refreshScale])

  /** measure the slot as it sits right now and hand the rect to the shell */
  const report = useCallback((): void => {
    if (refreshScale()) return
    const node = nodeRef.current
    const desktop = window.desktop
    if (!node || typeof desktop?.reportAiSlotRect !== 'function') return
    const rect = node.getBoundingClientRect()
    desktop.reportAiSlotRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
  }, [refreshScale])

  // main's re-measure request (activation, interface-scale change): the
  // stored rect is stale by construction then, and this answers it fresh.
  // Armed only once the shell has answered the drawer state — no shell, no
  // slot, nothing to report
  useEffect(() => {
    if (!enabled || dock === null) return
    const desktop = window.desktop
    if (typeof desktop?.onAiSlotRectRequest !== 'function') return
    return desktop.onAiSlotRectRequest(report)
  }, [enabled, dock, report])

  // the element's own lifecycle: mount reports, and a ResizeObserver keeps
  // every later change (the drawer flipping the slot open or closed, the
  // app reflowing, split view, the scale re-rendering the width) live. The
  // window resize is redundant with the observer in practice, but costs
  // nothing and matches the Home stage report's belt-and-braces. Armed only
  // once the shell answered, so the very first armed run reports the slot
  // as the drawer opened it.
  useEffect(() => {
    if (!enabled || dock === null) return
    report()
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => report()) : null
    const node = nodeRef.current
    if (observer && node) observer.observe(node)
    window.addEventListener('resize', report)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [enabled, dock, report, scale])

  // a callback ref: the node arrives after the effects above ran once (the
  // slot mounts with the drawer state), so attach the observer when it lands.
  // Reports only once the shell answered — a node landing before that (the
  // App renders the slot only for a known-open drawer, but the hook stays
  // honest for any wiring) has nobody to report to
  const slotRef = useCallback(
    (node: HTMLDivElement | null) => {
      nodeRef.current = node
      if (node && shellAnsweredRef.current) report()
    },
    [report],
  )

  return {
    dock,
    width: Math.round((dock?.width ?? 0) * scale),
    slotRef,
  }
}
