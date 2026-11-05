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
  }
}

export {}
