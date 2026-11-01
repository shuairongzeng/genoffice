import { createRoot } from 'react-dom/client'
import { htmlDir, htmlLang, type Lang } from '@genoffice/i18n'
import App from './App'
import { LocaleProvider, ensureLocale } from './i18n/locale'
import type { BrowserUiTheme } from '../shared/ipc'
import '@genoffice/ui/tokens.css'
import './browser.css'

function applyTheme(theme: BrowserUiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

void (async () => {
  const [lang, theme] = await Promise.all([
    window.browserApi.getLanguage().catch(() => 'zh' as const),
    window.browserApi.getTheme().catch(() => 'system' as const),
  ])
  document.documentElement.lang = htmlLang(lang as Lang)
  document.documentElement.dir = htmlDir(lang)
  applyTheme(theme)
  window.browserApi.onThemeChanged(applyTheme)
  // the UI language's dictionary must be registered before the first render
  await ensureLocale(lang as Lang)
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider initial={lang}>
      <App />
    </LocaleProvider>,
  )
})()
