import type React from 'react'

/** Minimum horizontal and vertical margin between a floating picker popover and viewport edges. */
export const PICKER_POPOVER_MARGIN = 8

/** Vertical gap between a picker trigger chip and its floating popover. */
export const PICKER_POPOVER_GAP = 6

/** Bounding rect metrics for the trigger element anchoring a picker popover. */
export interface PickerPopoverAnchor {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

/** Layout viewport dimensions used to clamp and flip a picker popover. */
export interface PickerPopoverViewport {
  readonly width: number
  readonly height: number
}

/** Configuration options for computing clamped popover CSS positioning. */
export interface PickerPopoverOptions {
  readonly preferredWidth: number
  readonly margin?: number
  readonly gap?: number
  readonly maxHeightCap?: number
}

/**
 * Compute inline viewport-clamped positioning for upward/downward composer pickers.
 * Ensures the popover never clips off the horizontal edges of narrow overlay views
 * and flips below the chip when space above is too constrained.
 */
export function computePickerPopoverStyle(
  anchor: PickerPopoverAnchor,
  viewport: PickerPopoverViewport,
  options: PickerPopoverOptions,
): React.CSSProperties {
  const margin = options.margin ?? PICKER_POPOVER_MARGIN
  const gap = options.gap ?? PICKER_POPOVER_GAP
  const maxHeightCap = options.maxHeightCap ?? 420

  let width: number
  let left: number
  let maxAllowedWidth: number | undefined

  if (viewport.width > 0) {
    maxAllowedWidth = Math.max(0, viewport.width - margin * 2)
    width = Math.min(options.preferredWidth, maxAllowedWidth)
    const maxLeft = Math.max(margin, viewport.width - margin - width)
    left = Math.round(Math.min(Math.max(margin, anchor.left), maxLeft))
  } else {
    width = options.preferredWidth
    left = Math.round(anchor.left)
    maxAllowedWidth = undefined
  }

  let top: number | undefined
  let bottom: number | undefined
  let maxHeight: number | undefined

  if (viewport.height > 0) {
    const availableAbove = Math.floor(anchor.top - gap - margin)
    const availableBelow = Math.floor(viewport.height - anchor.bottom - gap - margin)
    if (availableAbove < 160 && availableBelow > availableAbove) {
      top = Math.round(anchor.bottom + gap)
      maxHeight = Math.min(maxHeightCap, Math.max(120, availableBelow))
    } else {
      bottom = Math.round(Math.max(margin, viewport.height - anchor.top + gap))
      if (availableAbove > 0) {
        maxHeight = Math.min(maxHeightCap, Math.max(120, availableAbove))
      }
    }
  } else {
    bottom = Math.round(Math.max(margin, -anchor.top + gap))
  }

  return {
    left,
    width: Math.round(width),
    ...(maxAllowedWidth !== undefined ? { maxWidth: Math.round(maxAllowedWidth) } : {}),
    ...(top !== undefined ? { top } : {}),
    ...(bottom !== undefined ? { bottom } : {}),
    ...(maxHeight !== undefined ? { maxHeight } : {}),
  }
}
