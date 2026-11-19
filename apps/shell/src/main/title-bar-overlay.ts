import type { TitleBarOverlay } from 'electron'

import { desktopHeaderHeight } from '../shared/desktop-geometry'

/// Windows/Linux draw the caption buttons over the workbench's embedded tab
/// strip (titleBarStyle 'hidden'); a transparent overlay (`#00000000`) lets
/// `.work-tabs` and its frosted glass backdrop flow seamlessly behind the
/// window controls while `symbolColor` keeps the glyphs readable against each
/// theme (`#f2f2f5` dark, `#454746` light).
///
/// Its height follows the interface scale (genoffice#1913) and matches
/// `.work-tabs` (44px at 100% scale via `desktopHeaderHeight(uiScale)`): the
/// chrome around it is `zoom`ed, so a 150% band is 66px tall and an unscaled
/// overlay would leave the caption buttons misaligned with the header strip.
///
/// The overlay is only used together with the window controls that live in
/// it (min/max/close on Windows/Linux; the traffic lights are native macOS
/// chrome) — the desktop owns the tab strip's visuals, never these buttons.

export function tabStripOverlay(dark: boolean, uiScale = 1): TitleBarOverlay {
  return {
    color: '#00000000',
    symbolColor: dark ? '#f2f2f5' : '#454746',
    height: desktopHeaderHeight(uiScale),
  }
}
