import { useCallback, useEffect, useRef, useState } from 'react'

import { DOCK_BOUNCE_TIMEOUT_MS } from './dock-math'

/**
 * The launch bounce's lifecycle (the macOS dock's "this app is starting"
 * attention demand), shared by both dock mounts — Home's pill and the
 * doc-mode overlay. The component only renders the bouncing item's keyframes
 * (Dock's `bouncing` prop); this hook owns when they start and stop:
 *
 * - `launch(itemId)` — the item's target needs to open/load. A second launch
 *   for the SAME item is the cancel (macOS: clicking a bouncing icon stops
 *   the demand); launching another item switches targets.
 * - `settle(itemId)` — that item's target is ready (the gallery's list
 *   landed, the drawer opened): its bounce stops. Ready-detection belongs to
 *   the host — per app kind, see each mount.
 * - the hard cap — DOCK_BOUNCE_TIMEOUT_MS — stops a bounce whose ready
 *   signal never arrives, so a lost target cannot bounce forever.
 *
 * Reduced motion needs no branch here: the Dock refuses the bouncing class
 * while the OS setting is on, so an invisible lifecycle is a no-op the
 * moment it matters (the visual), and the cap still guarantees it ends.
 */
export interface DockBounce {
  /** the item id currently bouncing — the Dock's `bouncing` prop */
  bouncing: string | null
  /** begin the item's launch bounce; a repeat for the same item cancels it */
  launch: (itemId: string) => void
  /** the item's target became ready: stop its bounce (a no-op for others) */
  settle: (itemId: string) => void
  /** stop whatever is bouncing (the surface unmounted, the target vanished) */
  cancel: () => void
}

export function useDockBounce(): DockBounce {
  const [bouncing, setBouncing] = useState<string | null>(null)
  /** the bouncing id, mirrored for the callbacks (state is async) */
  const bouncingRef = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** the launch generation: a stale settle/timeout must not stop a newer one */
  const seq = useRef(0)

  const stop = useCallback((): void => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    seq.current += 1
    bouncingRef.current = null
    setBouncing(null)
  }, [])

  const launch = useCallback(
    (itemId: string): void => {
      if (bouncingRef.current === itemId) {
        // the second click on the bouncing item is the cancel
        stop()
        return
      }
      if (timer.current) clearTimeout(timer.current)
      const mine = ++seq.current
      bouncingRef.current = itemId
      setBouncing(itemId)
      // the hard cap: a ready signal that never arrives must not bounce
      // forever — the timeout is the host-agnostic backstop every launcher
      // shares (a specific "it failed" is just an early settle)
      timer.current = setTimeout(() => {
        if (seq.current === mine) stop()
      }, DOCK_BOUNCE_TIMEOUT_MS)
    },
    [stop],
  )

  const settle = useCallback(
    (itemId: string): void => {
      if (bouncingRef.current === itemId) stop()
    },
    [stop],
  )

  // a surface that unmounts mid-bounce leaves nothing to animate — and no
  // timer to leak
  useEffect(() => {
    const live = timer
    return () => {
      if (live.current) clearTimeout(live.current)
      live.current = null
    }
  }, [])

  return { bouncing, launch, settle, cancel: stop }
}
