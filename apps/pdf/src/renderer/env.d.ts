/// <reference types="vite/client" />

import type { PdfApi } from '../shared/ipc'

declare global {
  interface Window {
    pdfApi: PdfApi
    /** the viewer's text selection reporter (main's selection-store.ts) */
    pdfSelection: { report: (text: string) => void }
  }
}

export {}
