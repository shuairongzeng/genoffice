import { clampAiDockWidth } from '../../shared/desktop-geometry'

export type PanelResizeEdge = 'left' | 'right'

/**
 * Picks which inner/outer edges expose drag-resize handles for the overlay panel
 * across floating cards, browser sidebar dock, and left/right document slots.
 */
export function resolveOverlayResizeEdges(input: {
  embedded: boolean
  side: 'left' | 'right'
  activeTabKind: string | null
}): readonly PanelResizeEdge[] {
  if (!input.embedded) return ['left', 'right']
  if (input.activeTabKind === 'browser') return ['left']
  return input.side === 'left' ? ['right'] : ['left']
}

/**
 * Computes live overlay capture bounds (window px) and persisted chrome width (CSS px)
 * while edge-resizing across window-wide capture surfaces.
 */
export function computeResizedPanelBox(input: {
  edge: PanelResizeEdge
  clientX: number
  originPanel: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  windowWidth: number
  scale: number
}): {
  box: { x: number; y: number; width: number; height: number }
  cssWidth: number
} {
  const safeScale = Number.isFinite(input.scale) && input.scale > 0 ? input.scale : 1
  if (input.edge === 'right') {
    const rawPx = input.clientX - input.originPanel.x
    const cssWidth = clampAiDockWidth(rawPx / safeScale, input.windowWidth, safeScale)
    const nextW = Math.round(cssWidth * safeScale)
    return {
      box: {
        x: input.originPanel.x,
        y: input.originPanel.y,
        width: nextW,
        height: input.originPanel.height,
      },
      cssWidth,
    }
  }
  const rightEdge = input.originPanel.x + input.originPanel.width
  const rawPx = rightEdge - input.clientX
  const cssWidth = clampAiDockWidth(rawPx / safeScale, input.windowWidth, safeScale)
  const nextW = Math.round(cssWidth * safeScale)
  return {
    box: {
      x: Math.max(0, rightEdge - nextW),
      y: input.originPanel.y,
      width: nextW,
      height: input.originPanel.height,
    },
    cssWidth,
  }
}
