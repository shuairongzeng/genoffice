import { useCallback, useEffect, useRef, useState } from 'react'
import { useAiPanelPrefs } from './ai-panel-prefs-store'

/** Persisted global AI drawer state (`app-settings.json` `aiDock`). */
export interface HostedAiDockState {
  width: number
  collapsed: boolean
  petPos: { x: number; y: number } | null
}

/** Preload bridge subset required to host the shell's global AI drawer slot. */
export interface HostedAiSlotBridge {
  getAiDockState?: () => Promise<HostedAiDockState | null>
  onAiDockChanged?: (handler: (state: HostedAiDockState) => void) => () => void
  reportAiSlotRect?: (rect: { x: number; y: number; width: number; height: number }) => void
  onAiSlotRectRequest?: (handler: () => void) => () => void
}

/**
 * Read `--ui-scale` written onto `:root` by shell main; defaults to 1 if
 * missing or invalid.
 */
function readUiScale(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')
  const scale = Number.parseFloat(raw)
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

function readViewportWidth(): number {
  return typeof window !== 'undefined' && Number.isFinite(window.innerWidth) && window.innerWidth > 0
    ? window.innerWidth
    : 0
}

/** Clamps hosted slot width so narrow windows retain at least 360 CSS px of editor room. */
function clampSlotWidthPx(rawCssWidth: number, scale: number, viewportWidth: number): number {
  if (!Number.isFinite(rawCssWidth) || rawCssWidth <= 0) return 0
  const rawPx = Math.round(rawCssWidth * scale)
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return rawPx
  const minPx = Math.round(320 * scale)
  const absMaxPx = Math.round(760 * scale)
  const ratioMaxPx = Math.round(viewportWidth * 0.6)
  const contentMaxPx = Math.max(0, viewportWidth - 360)
  const capPx = Math.max(minPx, Math.min(absMaxPx, ratioMaxPx, contentMaxPx))
  return Math.min(rawPx, capPx)
}

/**
 * Reserve and track a hosted AI drawer slot inside an embedded editor app.
 *
 * When `enabled` is true, marks `<html data-hosted-in-shell="true">` so
 * hosted editors suppress standalone frameless window drag strips on their
 * ribbon tab bar, and keeps the shell main informed of the slot's viewport rect
 * across resizes, `--ui-scale` updates, and left/right dock flips.
 */
export function useHostedAiSlot(
  enabled: boolean,
  bridge: HostedAiSlotBridge | undefined,
): {
  dock: HostedAiDockState | null
  width: number
  slotRef: (node: HTMLDivElement | null) => void
} {
  const [dock, setDock] = useState<HostedAiDockState | null>(null)
  const [scale, setScale] = useState(readUiScale)
  const [viewportWidth, setViewportWidth] = useState(readViewportWidth)
  const { side } = useAiPanelPrefs()
  const scaleRef = useRef(scale)
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const shellAnsweredRef = useRef(false)
  shellAnsweredRef.current = dock !== null

  useEffect(() => {
    const html = document.documentElement
    if (!enabled) {
      delete html.dataset.hostedInShell
      return
    }
    html.dataset.hostedInShell = 'true'
    return () => {
      delete html.dataset.hostedInShell
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    if (typeof bridge?.getAiDockState !== 'function') return
    let alive = true
    void bridge
      .getAiDockState()
      .then((state) => {
        if (alive) setDock(state)
      })
      .catch(() => {
        if (alive) setDock(null)
      })
    const offChanged = bridge.onAiDockChanged?.((state) => setDock(state))
    return () => {
      alive = false
      offChanged?.()
    }
  }, [enabled, bridge])

  const refreshScale = useCallback((): boolean => {
    const next = readUiScale()
    if (next === scaleRef.current) return false
    scaleRef.current = next
    setScale(next)
    return true
  }, [])

  const report = useCallback((): void => {
    if (refreshScale()) return
    const node = nodeRef.current
    if (!node || typeof bridge?.reportAiSlotRect !== 'function') return
    const rect = node.getBoundingClientRect()
    bridge.reportAiSlotRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
  }, [bridge, refreshScale])

  useEffect(() => {
    if (!enabled || typeof MutationObserver !== 'function') return
    let rafId = 0
    const observer = new MutationObserver((records) => {
      const styleMoved = refreshScale()
      if (!styleMoved && records.some((r) => r.attributeName === 'data-ai-panel-side')) {
        if (typeof requestAnimationFrame === 'function') {
          cancelAnimationFrame(rafId)
          rafId = requestAnimationFrame(() => report())
        } else {
          report()
        }
      }
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'data-ai-panel-side'],
    })
    return () => {
      observer.disconnect()
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId)
    }
  }, [enabled, refreshScale, report])

  useEffect(() => {
    if (!enabled || dock === null) return
    if (typeof bridge?.onAiSlotRectRequest !== 'function') return
    return bridge.onAiSlotRectRequest(report)
  }, [enabled, dock, bridge, report])

  useEffect(() => {
    if (!enabled || dock === null) return
    report()
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => report()) : null
    const node = nodeRef.current
    if (observer && node) {
      observer.observe(node)
      if (node.parentElement) observer.observe(node.parentElement)
    }
    const onWindowResize = (): void => {
      setViewportWidth(readViewportWidth())
      report()
    }
    window.addEventListener('resize', onWindowResize)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', onWindowResize)
    }
  }, [enabled, dock, report, scale, side])

  const slotRef = useCallback(
    (node: HTMLDivElement | null) => {
      nodeRef.current = node
      if (node && shellAnsweredRef.current) report()
    },
    [report],
  )

  return {
    dock,
    width: clampSlotWidthPx(dock?.width ?? 0, scale, viewportWidth),
    slotRef,
  }
}
