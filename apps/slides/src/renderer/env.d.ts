/// <reference types="vite/client" />
import type { SlidesApi } from '../shared/ipc'
import type { ProjectApi } from '@genoffice/project-store'

declare global {
  interface Window {
    slidesApi: SlidesApi
    projectApi: ProjectApi
    /** the editor's text selection reporter (main's selection-store.ts) */
    slidesSelection: { report: (text: string) => void }
  }
}

export {}
