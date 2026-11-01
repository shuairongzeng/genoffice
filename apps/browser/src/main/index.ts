import { startBrowserStandalone } from './browser-main'

// Standalone dev entry (`npm run dev -w @genoffice/browser`): the shell is the
// real host; this only gives the module a window of its own for isolated work.
startBrowserStandalone()
