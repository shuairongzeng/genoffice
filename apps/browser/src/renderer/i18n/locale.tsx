import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  createI18n,
  htmlDir,
  htmlLang,
  type Lang,
  type LangDicts,
  type Params,
} from '@genoffice/i18n'
import { zh } from './lang/zh'
import { en } from './lang/en'

type Dict = typeof zh

export type StringKey = keyof Dict
export type TFunc = (key: StringKey, params?: Params) => string

// zh and en stay in the entry bundle: createI18n's fallback chain and the
// module-level t() below must answer before any lazy shard resolves. Every
// other locale registers into this registry once its chunk has loaded.
const dicts: Partial<Record<Lang, Record<StringKey, string>>> = { zh, en }
const translate = createI18n(dicts as LangDicts<Dict>)

const LOADERS: { [L in Exclude<Lang, 'zh' | 'en'>]: () => Promise<Record<StringKey, string>> } = {
  ja: () => import('./lang/ja').then((m) => m.ja),
  ko: () => import('./lang/ko').then((m) => m.ko),
  fr: () => import('./lang/fr').then((m) => m.fr),
  de: () => import('./lang/de').then((m) => m.de),
  es: () => import('./lang/es').then((m) => m.es),
  th: () => import('./lang/th').then((m) => m.th),
  id: () => import('./lang/id').then((m) => m.id),
  ru: () => import('./lang/ru').then((m) => m.ru),
  ar: () => import('./lang/ar').then((m) => m.ar),
  pt: () => import('./lang/pt').then((m) => m.pt),
  it: () => import('./lang/it').then((m) => m.it),
  pl: () => import('./lang/pl').then((m) => m.pl),
  cs: () => import('./lang/cs').then((m) => m.cs),
  nl: () => import('./lang/nl').then((m) => m.nl),
  ms: () => import('./lang/ms').then((m) => m.ms),
  he: () => import('./lang/he').then((m) => m.he),
  hi: () => import('./lang/hi').then((m) => m.hi),
  vi: () => import('./lang/vi').then((m) => m.vi),
  'zh-TW': () => import('./lang/zh-TW').then((m) => m.zhTW),
}

const pending = new Map<Lang, Promise<void>>()

/** Register a locale's dictionary before it becomes active; never rejects. */
export function ensureLocale(lang: Lang): Promise<void> {
  if (dicts[lang]) return Promise.resolve()
  const inFlight = pending.get(lang)
  if (inFlight) return inFlight
  const load = LOADERS[lang as Exclude<Lang, 'zh' | 'en'>]()
    .then((dict) => {
      dicts[lang] = dict
    })
    .catch(() => {
      pending.delete(lang)
    })
  pending.set(lang, load)
  return load
}

const LocaleContext = createContext<{ lang: Lang; dictsRev: number }>({
  lang: 'zh',
  dictsRev: 0,
})

/** Module-level current language: for code outliving render closures, kept in sync with the Provider */
let moduleLang: Lang = 'zh'

export function t(key: StringKey, params?: Params): string {
  return translate(moduleLang, key, params)
}

export function LocaleProvider({ initial, children }: { initial: Lang; children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(initial)
  const [dictsRev, setDictsRev] = useState(0)
  const latest = useRef<Lang>(initial)
  moduleLang = lang

  // a locale only becomes active once its dictionary is registered, so no
  // consumer ever renders fallback strings for a locale that has a shard
  const activate = useCallback((next: Lang) => {
    latest.current = next
    if (dicts[next]) {
      setLang(next)
      return
    }
    void ensureLocale(next).then(() => {
      if (latest.current !== next) return
      setLang(next)
      setDictsRev((rev) => rev + 1)
    })
  }, [])

  useEffect(() => {
    activate(initial)
  }, [activate, initial])
  useEffect(
    () =>
      window.browserApi.onLanguageChanged((next) => {
        document.documentElement.lang = htmlLang(next)
        document.documentElement.dir = htmlDir(next)
        activate(next)
      }),
    [activate],
  )
  return <LocaleContext.Provider value={{ lang, dictsRev }}>{children}</LocaleContext.Provider>
}

export function useI18n(): { lang: Lang; t: TFunc } {
  const { lang } = useContext(LocaleContext)
  return { lang, t: (key, params) => translate(lang, key, params) }
}
