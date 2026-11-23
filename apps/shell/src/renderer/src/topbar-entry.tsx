import { useCallback, useEffect, useState } from 'react'
import type { HomeApi, HomeTabEntry, SplitState, WindowChromeState } from '../../shared/home-api'
import { HomeTabs, useSplitCompareActions } from './HomeTabs'
import { useI18n } from './locale'

/** True while the shell renderer is loaded as the doc-mode floating top bar overlay (`?view=topbar`). */
export function isTopBarView(search: string = location.search): boolean {
  return new URLSearchParams(search).get('view') === 'topbar'
}

const DEFAULT_CHROME_STATE: WindowChromeState = {
  maximized: false,
  fullScreen: false,
  autoHideEnabled: true,
  autoHideActive: false,
  revealed: false,
}

/**
 * Standalone mount for the doc-mode auto-hide top tab strip (`?view=topbar`).
 * Lives inside a transparent native `WebContentsView` positioned at the top
 * of the shell window above the active document view. At rest it occupies a
 * 4px invisible trigger strip; on hover it expands to 44px and shows the live
 * tab strip without reflowing the document underneath.
 */
export function TopBarEntry(): React.JSX.Element {
  const { lang } = useI18n()
  const [tabs, setTabs] = useState<readonly HomeTabEntry[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [splitState, setSplitState] = useState<SplitState | null>(null)
  const [chromeState, setChromeState] = useState<WindowChromeState>(DEFAULT_CHROME_STATE)

  useEffect(() => {
    document.documentElement.classList.add('topbar-view')
    return () => document.documentElement.classList.remove('topbar-view')
  }, [])

  useEffect(() => {
    let alive = true
    const api = window.aiOffice as Partial<HomeApi> | undefined
    const offTabs = api?.onTabsChanged?.((state) => {
      setTabs(state.tabs.filter((tab) => tab.kind !== 'home'))
      setActiveId(state.activeId)
      setSplitState(state.split ?? null)
    })
    const offChrome = api?.onWindowChromeStateChanged?.((next) => {
      setChromeState(next)
    })
    void api
      ?.splitGetState?.()
      .then((next) => {
        if (alive) setSplitState(next ?? null)
      })
      .catch(() => undefined)
    void api
      ?.getWindowChromeState?.()
      .then((next) => {
        if (alive) setChromeState(next)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      offTabs?.()
      offChrome?.()
    }
  }, [])

  const onShowDesktop = useCallback(() => {
    void (window.aiOffice as Partial<HomeApi> | undefined)?.tabsActivate?.('home')
  }, [])

  const onActivate = useCallback((id: string) => {
    void (window.aiOffice as Partial<HomeApi> | undefined)?.tabsActivate?.(id)
  }, [])

  const onClose = useCallback((id: string) => {
    void (window.aiOffice as Partial<HomeApi> | undefined)?.tabsClose?.(id)
  }, [])

  const reportHotEdge = useCallback((enter: boolean) => {
    const fn = (window.aiOffice as Partial<HomeApi> | undefined)?.topBarHotEdge
    fn?.(enter ? { enter: true } : { leave: true })
  }, [])

  const { onSplitToggle, onSplitSwap, onSplitSyncToggle, onOpenCompare } = useSplitCompareActions(
    tabs,
    activeId,
    splitState,
  )

  const docTabActive = activeId !== null && activeId !== 'home'

  return (
    <div
      className={`topbar-view-root${chromeState.revealed ? ' is-revealed' : ''}`}
      data-testid="doc-topbar-overlay"
      onPointerEnter={() => reportHotEdge(true)}
      onPointerLeave={() => reportHotEdge(false)}
    >
      <HomeTabs
        lang={lang}
        tabs={tabs}
        desktopActive={!docTabActive}
        onShowDesktop={onShowDesktop}
        onActivate={onActivate}
        onClose={onClose}
        split={splitState}
        onSplitToggle={onSplitToggle}
        onSplitSwap={onSplitSwap}
        onSplitSyncToggle={onSplitSyncToggle}
        onOpenCompare={onOpenCompare}
        onToggleTerminal={() =>
          void (window.aiOffice as Partial<HomeApi> | undefined)?.terminalRequestDrawer?.({
            action: 'toggle',
          })
        }
      />
    </div>
  )
}
