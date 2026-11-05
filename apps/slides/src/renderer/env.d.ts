/// <reference types="vite/client" />
import type { SlidesApi } from '../shared/ipc'
import type { ProjectApi } from '@genoffice/project-store'

declare global {
  interface Window {
    slidesApi: SlidesApi
    projectApi: ProjectApi
    /** the editor's text selection reporter (main's selection-store.ts) */
    slidesSelection: { report: (text: string) => void }
    /** shell hosting + the shared permission posture (main's home-ipc) */
    slidesHost: {
      isHostedInShell(): Promise<boolean>
      openGlobalAi(question?: string): Promise<void>
      getAiPermissions(): Promise<'auto' | 'smart' | 'paranoid'>
      setAiPermissions(mode: 'auto' | 'smart' | 'paranoid'): Promise<unknown>
      onAiPermissionsChanged(handler: (mode: 'auto' | 'smart' | 'paranoid') => void): () => void
    }
  }
}

export {}
