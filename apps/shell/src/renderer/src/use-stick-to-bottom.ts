import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Chat-standard stick-to-bottom for a scrolling transcript.
 *
 * The thread follows its own growth (a streaming answer, an image loading, a
 * chip appearing) while the reader sits at the bottom, and stops the moment
 * they deliberately scroll up — reading is never interrupted mid-stream.
 * Scrolling back to the bottom resumes the follow.
 *
 * Why the previous panel logic misfired: it recomputed "at bottom" from the
 * absolute position on EVERY scroll event, with no direction. The effect's
 * own programmatic scrollTo fires a scroll event; when content had grown in
 * the same breath, that event read a distance past the threshold and silently
 * turned the follow OFF — the list then grew with the view parked, exactly
 * the reported bug. The rule here is directional: only an UPWARD scroll (a
 * negative scrollTop delta, which pure growth never produces) can unfollow,
 * and the follow/unfollow distances differ (hysteresis) so the boundary
 * cannot flicker.
 *
 * Growth is watched with a ResizeObserver on the CONTENT element (not the
 * scroller — the scroller's own box does not change when the transcript
 * grows), and the follow scroll is rAF-coalesced reading the fresh
 * scrollHeight at flush time, so a growth burst lands one scroll per frame.
 */

/** close enough to the bottom to (re)start following (px) */
export const STICK_REFOLLOW_PX = 8
/** far enough from the bottom for an upward scroll to stop following (px) */
export const STICK_UNFOLLOW_PX = 24

export interface StickToBottom {
  /** set on the scroll container */
  scrollerRef: (node: HTMLDivElement | null) => void
  /** set on the content wrapper inside the scroller (its growth is watched) */
  contentRef: (node: HTMLDivElement | null) => void
  /** whether the view is following the bottom right now */
  following: boolean
  /** content arrived while unfollowed — the "scroll to latest" affordance's dot */
  hasNew: boolean
  /** jump to the latest and resume following */
  scrollToLatest: () => void
  /**
   * The transcript model grew (a message or token landed in React state).
   * The ResizeObserver already catches DOM growth in the browser; this is
   * the React-shaped twin — same funnel, so environments without the
   * observer (and state growth the DOM has not laid out yet) follow too.
   */
  notifyGrowth(): void
}

export function useStickToBottom(): StickToBottom {
  const [following, setFollowing] = useState(true)
  const [hasNew, setHasNew] = useState(false)
  const followingRef = useRef(true)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  const lastScrollTopRef = useRef<number | null>(null)
  const scrollScheduledRef = useRef(false)
  const rafRef = useRef<number | null>(null)

  const applyFollowing = (next: boolean): void => {
    followingRef.current = next
    setFollowing((prev) => (prev === next ? prev : next))
    if (next) setHasNew(false)
  }

  /** one follow scroll per animation frame, reading the fresh scrollHeight */
  const scheduleFollowScroll = useCallback((): void => {
    const el = scroller
    if (!el || scrollScheduledRef.current) return
    scrollScheduledRef.current = true
    rafRef.current = requestAnimationFrame(() => {
      scrollScheduledRef.current = false
      rafRef.current = null
      const live = scroller
      if (live && followingRef.current) live.scrollTo({ top: live.scrollHeight })
    })
  }, [scroller])

  /** scroll to the bottom now — the React-shaped growth signal's path: the
   *  commit already landed, so the geometry is current and the scroll is
   *  immediate (the observer's bursts keep the rAF coalescing instead) */
  const scrollNow = useCallback((): void => {
    const el = scroller
    if (el && followingRef.current) el.scrollTo({ top: el.scrollHeight })
  }, [scroller])

  const scrollToLatest = useCallback((): void => {
    applyFollowing(true)
    const el = scroller
    if (el) {
      // immediate, not rAF-coalesced: this is the person's explicit ask. The
      // scroll's own event updates the delta baseline; nothing is written
      // here — a guessed baseline (scrollHeight before layout) would make
      // the next real event's delta wrong
      el.scrollTo({ top: el.scrollHeight })
    }
  }, [scroller])

  // the reader's scroll: direction decides. An upward delta (which pure
  // content growth never produces — scrollTop only moves on a real scroll or
  // the browser's anchoring, both non-negative here) and enough distance
  // unfollow; landing back within the tight band refollows. The FIRST event
  // has no delta to read: the reader was landed at the bottom, so being past
  // the unfollow band can only mean they scrolled up — unfollow there too
  useEffect(() => {
    if (!scroller) return
    const onScroll = (): void => {
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      const previous = lastScrollTopRef.current
      const delta = previous === null ? null : scroller.scrollTop - previous
      lastScrollTopRef.current = scroller.scrollTop
      if (distance <= STICK_REFOLLOW_PX) {
        applyFollowing(true)
        return
      }
      if ((delta === null || delta < 0) && distance >= STICK_UNFOLLOW_PX) {
        applyFollowing(false)
      }
      // a downward scroll short of the band, or the anchoring/programmatic
      // events growth produces: the state stands
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [scroller])

  /** the React-shaped growth twin: the commit already landed, scroll now */
  const notifyGrowth = useCallback((): void => {
    if (followingRef.current) {
      scrollNow()
      return
    }
    setHasNew(true)
  }, [scrollNow])

  /** one shared growth funnel for the observer's bursts: coalesced per frame */
  const onObserverGrowth = useCallback((): void => {
    if (followingRef.current) {
      scheduleFollowScroll()
      return
    }
    setHasNew(true)
  }, [scheduleFollowScroll])

  // the content's growth (the ResizeObserver's initial fire also lands an
  // opened panel on the latest content)
  useEffect(() => {
    if (!content || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(onObserverGrowth)
    observer.observe(content)
    return () => observer.disconnect()
  }, [content, onObserverGrowth])

  // a scheduled follow scroll must not outlive the scroller
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  return {
    scrollerRef: setScroller,
    contentRef: setContent,
    following,
    hasNew,
    scrollToLatest,
    notifyGrowth,
  }
}
