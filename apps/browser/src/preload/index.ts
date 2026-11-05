import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { Lang } from '@genoffice/i18n'
import { BROWSER_CHANNELS } from '../shared/ipc'
import type { BrowserApi, BrowserPageState, BrowserUiTheme } from '../shared/ipc'

const api: BrowserApi = {
  navigate: (input) => ipcRenderer.invoke(BROWSER_CHANNELS.navigate, input),
  goBack: () => ipcRenderer.send(BROWSER_CHANNELS.goBack),
  goForward: () => ipcRenderer.send(BROWSER_CHANNELS.goForward),
  reload: () => ipcRenderer.send(BROWSER_CHANNELS.reload),
  stop: () => ipcRenderer.send(BROWSER_CHANNELS.stop),
  setAnnotateMode: (on) => ipcRenderer.send(BROWSER_CHANNELS.setAnnotateMode, on),
  getState: () => ipcRenderer.invoke(BROWSER_CHANNELS.getState),
  onState: (handler) => {
    const listener = (_e: IpcRendererEvent, state: BrowserPageState) => handler(state)
    ipcRenderer.on(BROWSER_CHANNELS.stateChanged, listener)
    return () => ipcRenderer.removeListener(BROWSER_CHANNELS.stateChanged, listener)
  },
  reportContentRect: (rect) => ipcRenderer.send(BROWSER_CHANNELS.contentRect, rect),
  onDrawerInset: (handler) => {
    const listener = (_e: IpcRendererEvent, inset: number) => handler(inset)
    ipcRenderer.on(BROWSER_CHANNELS.drawerInset, listener)
    return () => ipcRenderer.removeListener(BROWSER_CHANNELS.drawerInset, listener)
  },
  getLanguage: () => ipcRenderer.invoke(BROWSER_CHANNELS.getLanguage),
  onLanguageChanged: (handler) => {
    const listener = (_e: IpcRendererEvent, lang: Lang) => handler(lang)
    ipcRenderer.on(BROWSER_CHANNELS.languageChanged, listener)
    return () => ipcRenderer.removeListener(BROWSER_CHANNELS.languageChanged, listener)
  },
  getTheme: () => ipcRenderer.invoke(BROWSER_CHANNELS.getTheme),
  onThemeChanged: (handler) => {
    const listener = (_e: IpcRendererEvent, theme: BrowserUiTheme) => handler(theme)
    ipcRenderer.on(BROWSER_CHANNELS.themeChanged, listener)
    return () => ipcRenderer.removeListener(BROWSER_CHANNELS.themeChanged, listener)
  },
}

contextBridge.exposeInMainWorld('browserApi', api)
