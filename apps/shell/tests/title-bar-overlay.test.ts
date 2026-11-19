import { describe, expect, it } from 'vitest'

import { tabStripOverlay } from '../src/main/title-bar-overlay'
import { DESKTOP_HEADER_HEIGHT, desktopHeaderHeight } from '../src/shared/desktop-geometry'

describe('tabStripOverlay', () => {
  it('uses a transparent overlay matching the desktop header band in both themes', () => {
    expect(tabStripOverlay(false)).toEqual({
      color: '#00000000',
      symbolColor: '#454746',
      height: DESKTOP_HEADER_HEIGHT,
    })
    expect(tabStripOverlay(true)).toEqual({
      color: '#00000000',
      symbolColor: '#f2f2f5',
      height: DESKTOP_HEADER_HEIGHT,
    })
    expect(DESKTOP_HEADER_HEIGHT).toBe(44)
  })

  it('grows the caption band with the interface scale', () => {
    // Windows and Linux draw the caption buttons over `.work-tabs`, so the
    // overlay band has to be the strip's *rendered* height. The strip is
    // `zoom`ed by `--ui-scale` (genoffice#1913); a fixed 44 would leave the
    // buttons misaligned once the interface is enlarged.
    expect(tabStripOverlay(false, 1.5).height).toBe(66)
    expect(tabStripOverlay(true, 1.5).height).toBe(desktopHeaderHeight(1.5))
    expect(tabStripOverlay(false, 1.5).height).toBe(tabStripOverlay(true, 1.5).height)
  })

  it('defaults to unscaled so an old call site keeps its band', () => {
    // The scale argument is optional: a caller that does not know about genoffice#1913
    // still gets the 44px band it had before.
    expect(tabStripOverlay(false).height).toBe(tabStripOverlay(false, 1).height)
  })
})
