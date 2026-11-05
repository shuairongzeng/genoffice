/// <reference types="vite/client" />

import type { PdfApi } from '../shared/ipc'

declare global {
  interface Window {
    pdfApi: PdfApi
    /** the viewer's text selection reporter (main's selection-store.ts) */
    pdfSelection: { report: (text: string) => void }
    /** shell hosting + the shared permission posture (main's home-ipc) */
    pdfHost: {
      isHostedInShell(): Promise<boolean>
      openGlobalAi(question?: string): Promise<void>
      getAiPermissions(): Promise<'auto' | 'smart' | 'paranoid'>
      setAiPermissions(mode: 'auto' | 'smart' | 'paranoid'): Promise<unknown>
      onAiPermissionsChanged(handler: (mode: 'auto' | 'smart' | 'paranoid') => void): () => void
    }
  }
}

export {}
