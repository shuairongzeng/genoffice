import { useEffect, useState } from 'react'
import { Home } from './Home'
import { Onboarding } from './Onboarding'
import { StarPromptCard } from './StarPromptCard'

interface AppFrameProps {
  /** resolved before first paint (main.tsx) so home never flashes under the overlay */
  initialOnboardingSeen: boolean
}

export function AppFrame({ initialOnboardingSeen }: AppFrameProps) {
  const [homeActive, setHomeActive] = useState(true)
  const [showOnboarding, setShowOnboarding] = useState(!initialOnboardingSeen)
  const [starPromptDocOpens, setStarPromptDocOpens] = useState<number | null>(null)

  useEffect(() => {
    const applyTabs = (tabs: Awaited<ReturnType<typeof window.aiOfficeTabs.list>>) => {
      const active = tabs.find((tab) => tab.active)
      setHomeActive(!active || active.kind === 'home')
    }
    void window.aiOfficeTabs.list().then(applyTabs)
    return window.aiOfficeTabs.onChanged(applyTabs)
  }, [])

  // document tabs are sibling WebContentsViews: they see neither this press
  // nor a focus change, so relay it for them to dismiss open popovers
  useEffect(() => {
    const notify = (): void => window.aiOfficeTabs.notifyChromePressed?.()
    document.addEventListener('pointerdown', notify, true)
    return () => document.removeEventListener('pointerdown', notify, true)
  }, [])

  // The "star us" invitation is decided (and counted as shown) by the main
  // process; ask once per session, and never while onboarding is up — a
  // first-run user can't have met the value threshold anyway.
  useEffect(() => {
    if (showOnboarding) return
    let alive = true
    void window.aiOffice.starPromptShouldShow?.().then((result) => {
      if (alive && result.show) setStarPromptDocOpens(result.docOpens)
    })
    return () => {
      alive = false
    }
  }, [showOnboarding])

  const finishOnboarding = async (): Promise<boolean> => {
    try {
      const persisted = await window.aiOffice.setOnboardingSeen()
      if (!persisted) return false
      setShowOnboarding(false)
      return true
    } catch {
      return false
    }
  }

  return (
    <div className="app-frame">
      {/* Home is the persistent workbench: it stays mounted and visible
       * whatever tab is active. Document tabs are WebContentsViews the main
       * process bounds to Home's content stage, so the docked AI panel and
       * the embedded tab strip keep their margins around a document — the
       * stage itself is what yields. The native tab strip is retired: the
       * window's drag surface is the workbench chrome itself (work-tabs
       * track, dock head, sidebar logo), and the OS window controls live in
       * the main process's title-bar overlay / native traffic lights. Only
       * the first-run overlays below still wait for the home tab, since a
       * document's view paints above them. */}
      <Home />
      {/* editor WebContentsViews paint above ALL shell DOM, so the overlay only
       * renders while the home tab is active — it comes back when home does */}
      {showOnboarding && homeActive && <Onboarding onDone={finishOnboarding} />}
      {starPromptDocOpens !== null && !showOnboarding && homeActive && (
        <StarPromptCard docOpens={starPromptDocOpens} onClose={() => setStarPromptDocOpens(null)} />
      )}
    </div>
  )
}
