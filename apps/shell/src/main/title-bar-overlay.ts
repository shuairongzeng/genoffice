import type { TitleBarOverlay } from 'electron'

import { tabStripHeight } from '../shared/tab-drag-geometry'

/// Windows/Linux draw the caption buttons over the desktop's chrome
/// (titleBarStyle 'hidden'); the overlay must match the band the Home
/// renderer draws at the window's top-right — the workbench chrome the
/// retired native strip's tabbar.css used to color #ebebeb (light) on
/// #454746 ink.
///
/// Its height has to follow the interface scale too (genoffice#1913): the
/// chrome around it is `zoom`ed, so a 150% band is 60px tall and a 40px
/// overlay would leave the caption buttons floating over the content.
///
/// The overlay is only retired together with the window controls that live in
/// it (min/max/close on Windows/Linux; the traffic lights are native macOS
/// chrome) — the desktop owns the tab strip's visuals, never these buttons.

export function tabStripOverlay(dark: boolean, uiScale = 1): TitleBarOverlay {
  const height = tabStripHeight(uiScale)
  return dark
    ? { color: '#2a2a2a', symbolColor: '#e4e4e4', height }
    : { color: '#ebebeb', symbolColor: '#454746', height }
}
