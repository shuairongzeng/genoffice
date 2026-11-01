/// <reference types="vite/client" />

import type { BrowserApi } from '../shared/ipc'

declare global {
  interface Window {
    browserApi: BrowserApi
  }
}

export {}
