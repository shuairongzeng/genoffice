/// <reference types="vite/client" />

import type { ProjectApi } from '@genoffice/project-store'
import type { HtmlApi } from '../shared/ipc'

declare global {
  interface Window {
    htmlApi: HtmlApi
    /** the editor's text selection reporter (main's selection-store.ts) */
    htmlSelection: { report: (text: string) => void }
    projectApi?: Pick<ProjectApi, 'resolveChat' | 'appendChat' | 'loadChat' | 'rebindChat'>
  }
}

export {}
