import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    isReady: () => false,
    getPath: () => '',
    getAppPath: () => '',
    setPath: () => {},
  },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
  },
}))

import {
  computeSplashBounds,
  createSplashCoordinator,
  shouldShowSplash,
  SPLASH_HEIGHT,
  SPLASH_WIDTH,
} from '../src/main/splash-state'
import { buildSplashHtml, SPLASH_PALETTE, splashStageLabel } from '../src/main/splash-html'
import { SHELL_PRIVILEGED_SCHEMES } from '../src/main/boot-env'

const tokensCss = readFileSync(
  resolve(__dirname, '../../../packages/ui/src/tokens.css'),
  'utf8',
)
const previewProtocolTs = readFileSync(
  resolve(__dirname, '../../html/src/main/preview-protocol.ts'),
  'utf8',
)
const rendererSchemeTs = readFileSync(
  resolve(__dirname, '../../../packages/electron-utils/src/renderer-scheme.ts'),
  'utf8',
)

function surfaceInTokens(selector: string): string | undefined {
  return new RegExp(`${selector}\\s*\\{[^}]*?--surface:\\s*(#[0-9a-fA-F]{3,8})\\s*;`).exec(
    tokensCss,
  )?.[1]
}

afterEach(() => {
  vi.useRealTimers()
})

describe('shouldShowSplash', () => {
  it('allows normal primary GUI launches', () => {
    expect(shouldShowSplash({ headless: false, hasSingleInstanceLock: true })).toBe(true)
  })

  it('suppresses splash for headless exports, secondary launches, and env opt-out', () => {
    expect(shouldShowSplash({ headless: true, hasSingleInstanceLock: true })).toBe(false)
    expect(shouldShowSplash({ headless: false, hasSingleInstanceLock: false })).toBe(false)
    expect(
      shouldShowSplash({ headless: false, hasSingleInstanceLock: true, disabledByEnv: true }),
    ).toBe(false)
  })
})

describe('computeSplashBounds', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 }
  const secondary = { x: 1920, y: 0, width: 2560, height: 1400 }

  it('centers on the primary work area when no saved bounds exist', () => {
    expect(computeSplashBounds([primary, secondary], primary, null)).toEqual({
      x: Math.round((1920 - SPLASH_WIDTH) / 2),
      y: Math.round((1040 - SPLASH_HEIGHT) / 2),
      width: SPLASH_WIDTH,
      height: SPLASH_HEIGHT,
    })
  })

  it('centers on the secondary display when the saved window was there', () => {
    const savedOnSecondary = { x: 2100, y: 120, width: 1360, height: 900 }
    expect(computeSplashBounds([primary, secondary], primary, savedOnSecondary)).toEqual({
      x: Math.round(1920 + (2560 - SPLASH_WIDTH) / 2),
      y: Math.round((1400 - SPLASH_HEIGHT) / 2),
      width: SPLASH_WIDTH,
      height: SPLASH_HEIGHT,
    })
  })

  it('picks the work area with maximum intersection if the window center sits off-screen', () => {
    const straddling = { x: 1940, y: -200, width: 1200, height: 600 }
    const bounds = computeSplashBounds([primary, secondary], primary, straddling)
    expect(bounds.x).toBeGreaterThanOrEqual(secondary.x)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(secondary.x + secondary.width)
  })

  it('falls back to the primary display when the saved monitor was unplugged', () => {
    const onMissingMonitor = { x: -2560, y: 0, width: 1360, height: 900 }
    expect(computeSplashBounds([primary], primary, onMissingMonitor)).toEqual({
      x: Math.round((1920 - SPLASH_WIDTH) / 2),
      y: Math.round((1040 - SPLASH_HEIGHT) / 2),
      width: SPLASH_WIDTH,
      height: SPLASH_HEIGHT,
    })
  })

  it('clamps splash dimensions and position within tiny work areas', () => {
    const tiny = { x: 10, y: 20, width: 300, height: 200 }
    expect(computeSplashBounds([tiny], tiny, null)).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    })
  })
})

describe('createSplashCoordinator', () => {
  it('waits for both readyToShow and firstPaint before revealing once', () => {
    const reveal = vi.fn()
    const onRevealed = vi.fn()
    const coord = createSplashCoordinator({
      timeoutMs: 10_000,
      revealMainWindow: reveal,
      onRevealed,
    })

    coord.markReadyToShow()
    expect(reveal).not.toHaveBeenCalled()
    expect(coord.isRevealed()).toBe(false)

    coord.markFirstPaint()
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(reveal).toHaveBeenCalledWith('ready')
    expect(onRevealed).toHaveBeenCalledTimes(1)
    expect(coord.isRevealed()).toBe(true)

    coord.markFirstPaint()
    coord.forceReveal()
    expect(reveal).toHaveBeenCalledTimes(1)
    coord.dispose()
  })

  it('advances splash stages monotonically without regressing', () => {
    const stages: string[] = []
    const coord = createSplashCoordinator({
      timeoutMs: 0,
      onStage: (s) => stages.push(s),
      revealMainWindow: vi.fn(),
    })

    coord.setStage('core')
    coord.setStage('workspace')
    coord.setStage('core')
    coord.setStage('boot')
    expect(stages).toEqual(['core', 'workspace'])
    expect(coord.currentStage()).toBe('workspace')
    coord.dispose()
  })

  it('reveals via safety timeout if renderer paint hangs', () => {
    vi.useFakeTimers()
    const reveal = vi.fn()
    const onRevealed = vi.fn()
    const coord = createSplashCoordinator({
      timeoutMs: 5000,
      revealMainWindow: reveal,
      onRevealed,
    })

    vi.advanceTimersByTime(4999)
    expect(reveal).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(reveal).toHaveBeenCalledWith('timeout')
    expect(onRevealed).toHaveBeenCalledWith('timeout')
    coord.dispose()
  })

  it('stops all timers and future reveals after dispose', () => {
    vi.useFakeTimers()
    const reveal = vi.fn()
    const coord = createSplashCoordinator({
      timeoutMs: 5000,
      revealMainWindow: reveal,
    })

    coord.dispose()
    coord.markReadyToShow()
    coord.markFirstPaint()
    vi.advanceTimersByTime(10_000)
    expect(reveal).not.toHaveBeenCalled()
  })
})

describe('buildSplashHtml', () => {
  it('aligns surface tokens with packages/ui/src/tokens.css', () => {
    expect(surfaceInTokens(':root')?.toLowerCase()).toBe(SPLASH_PALETTE.light.surface)
    expect(surfaceInTokens("\\[data-theme='dark'\\]")?.toLowerCase()).toBe(
      SPLASH_PALETTE.dark.surface,
    )
    expect(buildSplashHtml({ dark: false, lang: 'en' })).toContain(SPLASH_PALETTE.light.surface)
    expect(buildSplashHtml({ dark: true, lang: 'zh' })).toContain(SPLASH_PALETTE.dark.surface)
  })

  it('includes the GenOffice pinwheel logo, reduced-motion guard, and localized stage copy', () => {
    const html = buildSplashHtml({ dark: false, lang: 'zh-CN' })
    expect(html).toContain('#0f7fff')
    expect(html).toContain('#16a34a')
    expect(html).toContain('#f97316')
    expect(html).toContain('#ef4444')
    expect(html).toContain('prefers-reduced-motion: reduce')
    expect(html).toContain(splashStageLabel('boot', 'zh-CN'))
    expect(splashStageLabel('core', 'zh-TW')).toContain('文件引擎')
    expect(splashStageLabel('workspace', 'en')).toContain('Preparing workspace')
  })
})

describe('SHELL_PRIVILEGED_SCHEMES', () => {
  it('matches all five schemes declared in html preview-protocol and electron-utils', () => {
    const names = SHELL_PRIVILEGED_SCHEMES.map((s) => s.scheme)
    expect(names).toEqual([
      'genoffice-app',
      'genoffice-docx-media',
      'genoffice-media',
      'html-preview',
      'html-asset',
    ])
    expect(SHELL_PRIVILEGED_SCHEMES[0]?.privileges?.codeCache).toBe(true)
    expect(rendererSchemeTs).toContain("RENDERER_SCHEME = 'genoffice-app'")
    expect(rendererSchemeTs).toContain("MEDIA_SCHEME = 'genoffice-media'")
    expect(previewProtocolTs).toContain('DOCX_MEDIA_SCHEME_PRIVILEGE')
    expect(previewProtocolTs).toContain('PREVIEW_SCHEME')
    expect(previewProtocolTs).toContain('ASSET_SCHEME')
  })
})
