declare module '*.md?raw' {
  const content: string
  export default content
}

import type { DesktopApi } from '../shared/desktop-api'
import type { ProjectApi } from '@genoffice/project-store'

declare global {
  interface Window {
    readonly desktopApi: DesktopApi
    readonly projectApi: ProjectApi
    /** the sheet's selection reporter (main's selection-store.ts) */
    readonly sheetsSelection: { report: (text: string) => void }
    /** the hosted AI slot's rect reporter + re-measure request subscription */
    readonly sheetsSlotRect: {
      report(rect: { x: number; y: number; width: number; height: number }): void
      onRequest(handler: () => void): () => void
    }
    /** shell hosting + the shared permission posture (main's home-ipc) */
    readonly sheetsHost: {
      isHostedInShell(): Promise<boolean>
      openGlobalAi(question?: string): Promise<void>
      getAiPermissions(): Promise<'auto' | 'smart' | 'paranoid'>
      setAiPermissions(mode: 'auto' | 'smart' | 'paranoid'): Promise<unknown>
      onAiPermissionsChanged(handler: (mode: 'auto' | 'smart' | 'paranoid') => void): () => void
    }
  }
}

export {}
