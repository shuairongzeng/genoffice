import { useCallback, useEffect, useState } from 'react'
import type { HomeApi, HomeTabEntry, WindowChromeState } from '../../shared/home-api'
import { HomeTabs } from './HomeTabs'
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
  const [chromeState, setChromeState] = useState<WindowChromeState>(DEFAULT_CHROME_STATE)

  useEffect(() => {
    document.documentElement.classList.add('topbar-view')
    return () => document.documentElement.classList.remove('topbar-view')
  }, [])

  useEffect(() => {
    const api = window.aiOffice as Partial<HomeApi> | undefined
    const offTabs = api?.onTabsChanged?.((state) => {
      setTabs(state.tabs.filter((tab) => tab.kind !== 'home'))
      setActiveId(state.activeId)
    })
    const offChrome = api?.onWindowChromeStateChanged?.((next) => {
      setChromeState(next)
    })
    void api
      ?.getWindowChromeState?.()
      .then((next) => setChromeState(next))
      .catch(() => undefined)
    return () => {
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
      />
    </div>
  )
}
