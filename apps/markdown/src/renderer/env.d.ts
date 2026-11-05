/// <reference types="vite/client" />

import type { ProjectApi } from '@genoffice/project-store'
import type { MarkdownApi } from '../shared/ipc'

declare global {
  interface Window {
    markdownApi: MarkdownApi
    /** the editor's text selection reporter (main's selection-store.ts) */
    markdownSelection: { report: (text: string) => void }
    /** shell hosting + the shared permission posture (main's home-ipc) */
    markdownHost: {
      isHostedInShell(): Promise<boolean>
      openGlobalAi(question?: string): Promise<void>
      getAiPermissions(): Promise<'auto' | 'smart' | 'paranoid'>
      setAiPermissions(mode: 'auto' | 'smart' | 'paranoid'): Promise<unknown>
      onAiPermissionsChanged(handler: (mode: 'auto' | 'smart' | 'paranoid') => void): () => void
    }
    projectApi?: Pick<ProjectApi, 'resolveChat' | 'appendChat' | 'loadChat' | 'rebindChat'>
  }
}

export {}
