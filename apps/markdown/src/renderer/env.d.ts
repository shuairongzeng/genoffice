/// <reference types="vite/client" />

import type { ProjectApi } from '@genoffice/project-store'
import type { MarkdownApi } from '../shared/ipc'

declare global {
  interface Window {
    markdownApi: MarkdownApi
    /** the editor's text selection reporter (main's selection-store.ts) */
    markdownSelection: { report: (text: string) => void }
    projectApi?: Pick<ProjectApi, 'resolveChat' | 'appendChat' | 'loadChat' | 'rebindChat'>
  }
}

export {}
