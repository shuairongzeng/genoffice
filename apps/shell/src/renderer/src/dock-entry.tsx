import { useCallback, useEffect, useRef, useState } from 'react'

import type { DockNavIntent, HomeApi } from '../../shared/home-api'
import type { DockOpenState } from '../../shared/home-api'
import {
  CloudGlyph,
  DockAskIcon,
  DockDesktopIcon,
  DockRecentIcon,
  DockStarredIcon,
  GearGlyph,
  PlugGlyph,
  TemplatesGlyph,
} from './app-glyphs'
import { Dock, type DockItem, type DockMenuEntry } from './Dock'
import { useDockBounce } from './dock-bounce'
import { normalizeDockPrefs, type DockPrefs } from '../../shared/dock-prefs'
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
 * so main can grow/shrink the surface, routing the dock's clicks: the
 * nav and launcher items over `home:dock-action` (main activates the Home
 * tab and delivers the intent — the raiseHomeTab semantics the Home-side
 * dock performs locally), the ask item through the ordinary
 * `home:ai-dock-set` write (the drawer overlay already handles doc mode) —
 * and, since the dock became a first-class surface, the macOS operability
 * layer: the settings-fed physics (设置 ▸ 程序坞, pushed by the store's
 * watcher), the running dots and the ask item's launch bounce (fed by
 * Home's open-target report, cached in main and pulled at mount), the
 * right-click menus (rendered inside this view, their verbs routed like
 * clicks), and the drag-to-reorder (persisted through the same prefs
 * channel — the pin below holds the dock revealed while it runs).
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

  // ── the dock's prefs (设置 ▸ 程序坞), pushed by the store's watcher
  // through this view: the physics and the shape follow whatever the
  // settings pane (or a drag on Home's pill) last committed
  const [dockPrefs, setDockPrefs] = useState<DockPrefs>(() => normalizeDockPrefs(undefined))
  useEffect(() => {
    const api = window.aiOffice as Partial<HomeApi>
    if (typeof api.getDockPrefs !== 'function') return
    let alive = true
    void api
      .getDockPrefs()
      .then((prefs) => {
        if (alive) setDockPrefs(normalizeDockPrefs(prefs))
      })
      .catch(() => undefined)
    const off = api.onDockPrefsChanged?.((prefs) => setDockPrefs(normalizeDockPrefs(prefs)))
    return () => {
      alive = false
      off?.()
    }
  }, [])
  const commitDockPrefs = useCallback((patch: Partial<DockPrefs>) => {
    setDockPrefs((prev) => normalizeDockPrefs({ ...prev, ...patch }))
    const api = window.aiOffice as Partial<HomeApi>
    if (typeof api.setDockPrefs === 'function') {
      void api.setDockPrefs(patch).catch(() => undefined)
    }
  }, [])

  // ── the open-target report: Home's truth about which dock targets are
  // open, cached in main. Subscribe FIRST, then pull — the same order the
  // dock-nav pull uses (a push landing in the gap is heard, the pull merely
  // re-states it; the report is a state, not an event, so the pair can
  // never double-anything)
  const [dockOpen, setDockOpen] = useState<DockOpenState>({
    view: null,
    settings: false,
    plugins: false,
    templates: false,
    ask: false,
    loggedIn: false,
  })
  useEffect(() => {
    const api = window.aiOffice as Partial<HomeApi>
    const off = api.onDockOpen?.((state) => setDockOpen(state))
    void api
      ?.takeDockOpen?.()
      .then((state) => setDockOpen(state))
      .catch(() => undefined)
    return off
  }, [])

  // the launch bounce's lifecycle: the ask item is the one target that
  // opens something THIS surface stays visible over (the drawer overlay
  // grows beside the document) — its bounce runs from the click until the
  // open-target report says the drawer is up (Home reports it, main pushes
  // it here), with the hook's own 8s cap as the backstop. The launchers
  // route to Home (which rises, standing this overlay down) — there is no
  // bounce to see, so there is none to play. An already-open drawer is a
  // bring-forward, not a launch — no bounce for it.
  const bounce = useDockBounce()
  const settleBounce = bounce.settle
  useEffect(() => {
    if (dockOpen.ask) settleBounce('dock:ask')
  }, [dockOpen.ask, settleBounce])

  // ── the reveal pin: while the dock's own context menu is open or a drag
  // is rearranging the pill, the pointer can leave the pill without the
  // dock hiding — the leave is deferred, and delivered when the
  // interaction ends with the pointer actually gone (main's grace timer
  // then hides the dock the usual way)
  const pinnedRef = useRef(false)
  const unpinRef = useRef<(() => void) | null>(null)
  const onInteractionChange = useCallback((active: boolean) => {
    pinnedRef.current = active
    if (!active) unpinRef.current?.()
  }, [])

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
  // a summon outside the pill's span could strand the dock revealed. A
  // deferred leave (the pin above) joins the stream when the pin lifts.
  // Native listeners (enter/leave do not bubble); guarded for a stale
  // preload without the channel — the surface then stays the strip forever,
  // never a dead boot
  useEffect(() => {
    const root = rootRef.current
    const report = (window.aiOffice as Partial<HomeApi> | undefined)?.dockHotEdge
    if (!root || typeof report !== 'function') return
    const pill = root.querySelector('.dock')
    let pointerInside = false
    let leavePending = false
    const onEnter = (): void => {
      pointerInside = true
      report({ enter: true })
    }
    const onLeave = (): void => {
      pointerInside = false
      if (pinnedRef.current) {
        leavePending = true
        return
      }
      report({ leave: true })
    }
    unpinRef.current = (): void => {
      if (leavePending && !pointerInside) report({ leave: true })
      leavePending = false
    }
    root.addEventListener('pointerenter', onEnter)
    root.addEventListener('pointerleave', onLeave)
    pill?.addEventListener('pointerenter', onEnter)
    pill?.addEventListener('pointerleave', onLeave)
    return () => {
      unpinRef.current = null
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
  /** the menu's drawer verb: open or collapse, whichever the report says is not current */
  const toggleDrawer = (): void => {
    const api = window.aiOffice as Partial<HomeApi>
    if (typeof api.setAiDock === 'function') {
      void api.setAiDock({ collapsed: dockOpen.ask }).catch(() => undefined)
    }
  }

  /** one launcher menu: bring the target forward, plus close when it is open */
  const targetMenu = (
    isOpen: boolean,
    open: () => void,
    close: () => void,
  ): readonly DockMenuEntry[] => [
    { label: t('dockMenuOpen'), onSelect: open },
    ...(isOpen ? [{ label: t('dockMenuClose'), onSelect: close, danger: true }] : []),
  ]

  // the same groups the Home-side dock carries (the shared nav artwork above
  // and the desktop tiles' launcher glyphs), minus the active dots: the
  // current view is Home's state — the running dots below come from the
  // open-target report instead, so the two mounts read one truth
  const groups: readonly (readonly DockItem[])[] = [
    [
      {
        id: 'dock:desktop',
        label: DESKTOP_STRINGS[lang].navDesktop,
        icon: <DockDesktopIcon />,
        tile: 'desktop',
        running: dockOpen.view === 'desktop',
        menu: [
          {
            label: DESKTOP_STRINGS[lang].navDesktop,
            onSelect: () => route({ kind: 'nav', view: 'desktop' }),
          },
        ],
        onSelect: () => route({ kind: 'nav', view: 'desktop' }),
      },
      {
        id: 'dock:recent',
        label: t('navRecent'),
        icon: <DockRecentIcon />,
        tile: 'recent',
        running: dockOpen.view === 'recent',
        menu: [{ label: t('navRecent'), onSelect: () => route({ kind: 'nav', view: 'recent' }) }],
        onSelect: () => route({ kind: 'nav', view: 'recent' }),
      },
      {
        id: 'dock:starred',
        label: t('navStarred'),
        icon: <DockStarredIcon />,
        tile: 'starred',
        running: dockOpen.view === 'starred',
        menu: [{ label: t('navStarred'), onSelect: () => route({ kind: 'nav', view: 'starred' }) }],
        onSelect: () => route({ kind: 'nav', view: 'starred' }),
      },
    ],
    [
      // the cloud launcher: the retired sidebar's one nav the dock did not
      // carry — visible while the report says the account is signed in,
      // its dot lit while the projects view is showing (view === 'cloud'),
      // routed through the same nav intent the doc-mode nav items use
      ...(dockOpen.loggedIn
        ? [
            {
              id: 'dock:cloud',
              label: t('navCloud'),
              icon: <CloudGlyph />,
              tile: 'cloud',
              running: dockOpen.view === 'cloud',
              menu: [
                { label: t('navCloud'), onSelect: () => route({ kind: 'nav', view: 'cloud' }) },
              ],
              onSelect: () => route({ kind: 'nav', view: 'cloud' }),
            } as DockItem,
          ]
        : []),
      {
        id: 'dock:settings',
        label: DESKTOP_STRINGS[lang].appSettings,
        icon: <GearGlyph />,
        tile: 'settings',
        running: dockOpen.settings,
        menu: targetMenu(
          dockOpen.settings,
          () => route({ kind: 'settings', section: 'general' }),
          () => route({ kind: 'close', target: 'settings' }),
        ),
        onSelect: () => route({ kind: 'settings', section: 'general' }),
      },
      {
        id: 'dock:templates',
        label: DESKTOP_STRINGS[lang].appTemplates,
        icon: <TemplatesGlyph />,
        tile: 'templates',
        running: dockOpen.templates,
        menu: targetMenu(
          dockOpen.templates,
          () => route({ kind: 'templates' }),
          () => route({ kind: 'close', target: 'templates' }),
        ),
        onSelect: () => route({ kind: 'templates' }),
      },
      {
        id: 'dock:plugins',
        label: DESKTOP_STRINGS[lang].appPlugins,
        icon: <PlugGlyph />,
        tile: 'plugins',
        running: dockOpen.plugins,
        menu: targetMenu(
          dockOpen.plugins,
          () => route({ kind: 'settings', section: 'plugins' }),
          () => route({ kind: 'close', target: 'plugins' }),
        ),
        onSelect: () => route({ kind: 'settings', section: 'plugins' }),
      },
    ],
    [
      {
        id: 'dock:ask',
        label: t('navAsk'),
        icon: <DockAskIcon />,
        tile: 'ask',
        running: dockOpen.ask,
        menu: [
          {
            label: dockOpen.ask ? t('dockMenuCollapseDrawer') : t('dockMenuOpenDrawer'),
            onSelect: toggleDrawer,
          },
        ],
        onSelect: () => {
          if (!dockOpen.ask) bounce.launch('dock:ask')
          openDrawer()
        },
      },
    ],
  ]

  return (
    <div className="dock-entry" ref={rootRef}>
      <Dock
        groups={groups}
        ariaLabel={t('dockLabel')}
        magnify={dockPrefs.magnify}
        baseSize={dockPrefs.baseSize}
        maxScale={dockPrefs.maxScale}
        order={dockPrefs.order}
        onReorder={(order) => commitDockPrefs({ order: [...order] })}
        bouncing={bounce.bouncing}
        onInteractionChange={onInteractionChange}
      />
    </div>
  )
}
