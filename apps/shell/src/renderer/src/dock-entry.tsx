import { useEffect, useRef } from 'react'

import type { HomeApi } from '../../shared/home-api'
import type { DockNavIntent } from '../../shared/home-api'
import {
  DockAskIcon,
  DockDesktopIcon,
  DockRecentIcon,
  DockStarredIcon,
  GearGlyph,
  PlugGlyph,
  TemplatesGlyph,
} from './app-glyphs'
import { Dock, type DockItem } from './Dock'
import { useI18n } from './locale'
import { DESKTOP_STRINGS } from './desktop-strings'

/**
 * The dock's standalone mount: the shell renderer loaded with `?view=dock`
 * renders ONLY the fisheye dock — no panel, no pet, no prefs subscription,
 * no ready ping (the buffered-message handshake belongs to the ask panel's
 * entry; this surface answers a different, main-driven handshake: the hot
 * strip). Same one-bundle-two-branches trick the manual and the ask panel
 * play. The native doc-mode overlay (main/dock-overlay-view.ts) loads this
 * URL into a WebContentsView above the covering document.
 *
 * The view's surface is transparent and it exists in two shapes main cuts:
 * the 3px hot strip along the window's bottom edge (its rest state — the
 * dock is clipped above the strip's top, so the surface paints nothing) and
 * the dock rect (the pill, positioned by the same fixed left-50%/bottom-9
 * geometry Home's dock uses, which lands exactly inside the view main
 * sized). The ROOT fills the viewport in both shapes (fixed, inset-and-vw/vh
 * sized — hit-testing needs geometry, not pixels; a root that does not
 * cover the strip's 3px catches no pointerenter and the dock never
 * reveals). This entry's only jobs are reporting the pointer's transitions
 * so main can grow/shrink the surface, and routing the dock's clicks: the
 * nav and launcher items over `home:dock-action` (main activates the Home
 * tab and delivers the intent — the raiseHomeTab semantics the Home-side
 * dock performs locally), the ask item through the ordinary
 * `home:ai-dock-set` write (the drawer overlay already handles doc mode).
 */
/**
 * True while the shell renderer was loaded as the dock's standalone view.
 * The search string is a parameter so the routing decision is testable
 * without touching jsdom's location; production reads this window's own.
 */
export function isDockView(search: string = location.search): boolean {
  return new URLSearchParams(search).get('view') === 'dock'
}

export function DockEntry(): React.JSX.Element {
  const { t, lang } = useI18n()
  const rootRef = useRef<HTMLDivElement>(null)

  // the hot-edge reports, on TWO elements: the ROOT (the view's whole
  // surface — the strip in rest state, the dock rect when revealed) carries
  // the summon and the rect-exit fallback; the PILL (.dock — the painted
  // box) carries the leave that matters. The rect is deliberately larger
  // than the pill (fisheye headroom + tooltip room, see dockOverlayBounds),
  // and a native view eats clicks over its whole rect — so a pointer idling
  // in the transparent margin must read as "off the dock", not hold it
  // open: the pill's pointerleave reports that. Diagonal travel from the
  // margin back onto the pill re-enters and cancels the grace (main's
  // timer), and the root's own leave remains the fallback for a pointer
  // that exits the whole rect without ever touching the pill — without it
  // a summon outside the pill's span could strand the dock revealed.
  // Native listeners (enter/leave do not bubble); guarded for a stale
  // preload without the channel — the surface then stays the strip forever,
  // never a dead boot
  useEffect(() => {
    const root = rootRef.current
    const report = (window.aiOffice as Partial<HomeApi> | undefined)?.dockHotEdge
    if (!root || typeof report !== 'function') return
    const pill = root.querySelector('.dock')
    const onEnter = (): void => report({ enter: true })
    const onLeave = (): void => report({ leave: true })
    root.addEventListener('pointerenter', onEnter)
    root.addEventListener('pointerleave', onLeave)
    pill?.addEventListener('pointerenter', onEnter)
    pill?.addEventListener('pointerleave', onLeave)
    return () => {
      root.removeEventListener('pointerenter', onEnter)
      root.removeEventListener('pointerleave', onLeave)
      pill?.removeEventListener('pointerenter', onEnter)
      pill?.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  // the entry keeps the html/body transparent for its whole lifetime (the
  // surface must show the document straight through in both shapes)
  useEffect(() => {
    document.documentElement.classList.add('dock-view')
    return () => document.documentElement.classList.remove('dock-view')
  }, [])

  /** the routed clicks — main activates Home and delivers the intent there */
  const route = (intent: DockNavIntent): void => {
    const action = (window.aiOffice as Partial<HomeApi> | undefined)?.dockAction
    if (typeof action === 'function') void action(intent).catch(() => undefined)
  }

  /** the ask tail: the drawer overlay's own open write, no tab routing */
  const openDrawer = (): void => {
    const api = window.aiOffice as Partial<HomeApi>
    if (typeof api.setAiDock === 'function') {
      void api.setAiDock({ collapsed: false }).catch(() => undefined)
    }
  }

  // the same groups the Home-side dock carries (the shared nav artwork above
  // and the desktop tiles' launcher glyphs), minus the active dots: the
  // current view is Home's state, which this surface has no channel for —
  // the dot is the Home dock's affordance
  const groups: readonly (readonly DockItem[])[] = [
    [
      {
        id: 'dock:desktop',
        label: DESKTOP_STRINGS[lang].navDesktop,
        icon: <DockDesktopIcon />,
        onSelect: () => route({ kind: 'nav', view: 'desktop' }),
      },
      {
        id: 'dock:recent',
        label: t('navRecent'),
        icon: <DockRecentIcon />,
        onSelect: () => route({ kind: 'nav', view: 'recent' }),
      },
      {
        id: 'dock:starred',
        label: t('navStarred'),
        icon: <DockStarredIcon />,
        onSelect: () => route({ kind: 'nav', view: 'starred' }),
      },
    ],
    [
      {
        id: 'dock:settings',
        label: DESKTOP_STRINGS[lang].appSettings,
        icon: <GearGlyph />,
        onSelect: () => route({ kind: 'settings', section: 'general' }),
      },
      {
        id: 'dock:templates',
        label: DESKTOP_STRINGS[lang].appTemplates,
        icon: <TemplatesGlyph />,
        onSelect: () => route({ kind: 'templates' }),
      },
      {
        id: 'dock:plugins',
        label: DESKTOP_STRINGS[lang].appPlugins,
        icon: <PlugGlyph />,
        onSelect: () => route({ kind: 'settings', section: 'plugins' }),
      },
    ],
    [
      {
        id: 'dock:ask',
        label: t('navAsk'),
        icon: <DockAskIcon />,
        onSelect: openDrawer,
      },
    ],
  ]

  return (
    <div className="dock-entry" ref={rootRef}>
      <Dock groups={groups} ariaLabel={t('dockLabel')} />
    </div>
  )
}
