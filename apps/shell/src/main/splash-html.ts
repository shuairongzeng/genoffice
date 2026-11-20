import type { SplashStage } from './splash-state'
import { SPLASH_STAGE_PROGRESS } from './splash-state'

export interface SplashHtmlOptions {
  dark: boolean
  lang: string
}

/**
 * Surface and chrome colors aligned with `packages/ui/src/tokens.css`
 * (`:root` and `[data-theme='dark']`) so the splash card shares the exact
 * visual temperature of the main window before the renderer bundle loads.
 */
export const SPLASH_PALETTE = {
  light: {
    surface: '#ffffff',
    surfaceSubtle: '#f6f7f9',
    border: '#e3e6ea',
    text: '#232425',
    textSecondary: '#606366',
    track: '#eaeaea',
  },
  dark: {
    surface: '#1e1e1e',
    surfaceSubtle: '#252526',
    border: '#333333',
    text: '#e8eaed',
    textSecondary: '#9aa0a6',
    track: '#2f3136',
  },
} as const

type LocaleFamily = 'zh' | 'zh-TW' | 'en'

function resolveLocaleFamily(lang: string): LocaleFamily {
  const normalized = lang.trim().toLowerCase()
  if (normalized === 'zh-tw' || normalized === 'zh-hk' || normalized === 'zh-hant') {
    return 'zh-TW'
  }
  if (normalized.startsWith('zh')) {
    return 'zh'
  }
  return 'en'
}

const STAGE_LABELS: Record<LocaleFamily, Record<SplashStage, string>> = {
  zh: {
    boot: '正在启动 GenOffice…',
    core: '正在加载文档引擎…',
    workspace: '正在准备工作台…',
    ready: '准备就绪',
  },
  'zh-TW': {
    boot: '正在啟動 GenOffice…',
    core: '正在載入文件引擎…',
    workspace: '正在準備工作台…',
    ready: '準備就緒',
  },
  en: {
    boot: 'Starting GenOffice…',
    core: 'Loading document engines…',
    workspace: 'Preparing workspace…',
    ready: 'Ready',
  },
}

export function splashStageLabel(stage: SplashStage, lang: string): string {
  return STAGE_LABELS[resolveLocaleFamily(lang)][stage]
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Self-contained HTML document loaded via `data:text/html` so the splash
 * renders immediately with zero disk or network round trips. Uses GPU-only
 * transforms/opacity animations and mirrors `apps/shell/build/logo.svg`.
 */
export function buildSplashHtml(opts: SplashHtmlOptions): string {
  const colors = opts.dark ? SPLASH_PALETTE.dark : SPLASH_PALETTE.light
  const initialLabel = escapeHtml(splashStageLabel('boot', opts.lang))
  const initialPct = SPLASH_STAGE_PROGRESS.boot
  const shadow = opts.dark
    ? '0 18px 42px rgba(0, 0, 0, 0.55), 0 2px 10px rgba(0, 0, 0, 0.35)'
    : '0 18px 42px rgba(15, 23, 42, 0.14), 0 2px 10px rgba(15, 23, 42, 0.06)'

  return `<!doctype html>
<html lang="${escapeHtml(opts.lang || 'en')}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>GenOffice Splash</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: transparent;
    overflow: hidden;
    user-select: none;
    -webkit-user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  }
  .stage {
    width: 100%;
    height: 100%;
    padding: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 18px;
    background: ${colors.surface};
    border: 1px solid ${colors.border};
    box-shadow: ${shadow};
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 24px 28px 22px;
    opacity: 0;
    transform: translateY(8px) scale(0.97);
    animation: cardIn 220ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
    transition: opacity 160ms cubic-bezier(0.4, 0, 1, 1), transform 160ms cubic-bezier(0.4, 0, 1, 1);
    overflow: hidden;
  }
  .card.exiting {
    opacity: 0 !important;
    transform: scale(0.96) !important;
  }
  .halo {
    position: absolute;
    top: -42px;
    width: 220px;
    height: 140px;
    border-radius: 999px;
    background: radial-gradient(circle, rgba(15, 127, 255, 0.14) 0%, rgba(249, 115, 22, 0.06) 52%, transparent 74%);
    pointer-events: none;
    animation: haloPulse 2.6s ease-in-out infinite;
  }
  .logo-wrap {
    position: relative;
    width: 68px;
    height: 68px;
    display: grid;
    place-items: center;
  }
  .logo {
    width: 64px;
    height: 64px;
    overflow: visible;
    animation: logoFloat 3s ease-in-out infinite;
  }
  .blade {
    transform-origin: 512px 512px;
    opacity: 0;
    animation: bladeIn 420ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
  }
  .blade-1 { animation-delay: 20ms; }
  .blade-2 { animation-delay: 85ms; }
  .blade-3 { animation-delay: 150ms; }
  .blade-4 { animation-delay: 215ms; }
  .blade-lock { animation-delay: 240ms; }
  .spark {
    position: absolute;
    width: 14px;
    height: 14px;
    border-radius: 999px;
    background: radial-gradient(circle, rgba(255, 255, 255, 0.92) 0%, rgba(15, 127, 255, 0.25) 58%, transparent 100%);
    opacity: 0.65;
    animation: sparkBreath 1.8s ease-in-out infinite;
    pointer-events: none;
  }
  .brand {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: ${colors.text};
    line-height: 1.2;
  }
  .status {
    margin: -6px 0 2px;
    font-size: 12.5px;
    font-weight: 400;
    color: ${colors.textSecondary};
    line-height: 1.4;
    min-height: 18px;
    text-align: center;
    transition: opacity 140ms ease;
  }
  .progress-track {
    position: relative;
    width: 216px;
    height: 4px;
    border-radius: 999px;
    background: ${colors.track};
    overflow: hidden;
  }
  .progress-fill {
    position: absolute;
    inset: 0 auto 0 0;
    width: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, #0f7fff 0%, #16a34a 35%, #f97316 70%, #ef4444 100%);
    transform-origin: left center;
    transform: scaleX(${(initialPct / 100).toFixed(2)});
    transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .progress-shimmer {
    position: absolute;
    inset: 0;
    width: 45%;
    background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.55) 50%, transparent 100%);
    transform: translateX(-120%);
    animation: shimmer 1.4s ease-in-out infinite;
  }
  @keyframes cardIn {
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes bladeIn {
    0% { opacity: 0; transform: scale(0.84) rotate(-18deg); }
    100% { opacity: 1; transform: scale(1) rotate(0deg); }
  }
  @keyframes haloPulse {
    0%, 100% { opacity: 0.75; transform: scale(0.98); }
    50% { opacity: 1; transform: scale(1.06); }
  }
  @keyframes logoFloat {
    0%, 100% { transform: translateY(0px); }
    50% { transform: translateY(-2px); }
  }
  @keyframes sparkBreath {
    0%, 100% { opacity: 0.45; transform: scale(0.82); }
    50% { opacity: 0.95; transform: scale(1.18); }
  }
  @keyframes shimmer {
    0% { transform: translateX(-130%); }
    100% { transform: translateX(260%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .card, .halo, .logo, .blade, .spark, .progress-shimmer {
      animation: none !important;
    }
    .card {
      opacity: 1;
      transform: none;
    }
    .blade {
      opacity: 1;
      transform: none;
    }
    .progress-shimmer {
      display: none;
    }
  }
</style>
</head>
<body>
  <div class="stage">
    <div class="card" id="card" data-stage="boot">
      <div class="halo"></div>
      <div class="logo-wrap">
        <svg class="logo" viewBox="0 0 1024 1024" aria-hidden="true">
          <g transform="translate(100 100) scale(0.89)" stroke-linejoin="round" stroke-width="28" stroke-linecap="round">
            <g class="blade blade-1"><polygon points="512,112 660,500 512,392 364,500" fill="#0f7fff" stroke="#0f7fff"/></g>
            <g class="blade blade-2"><polygon points="512,112 660,500 512,392 364,500" fill="#16a34a" stroke="#16a34a" transform="rotate(90 512 512)"/></g>
            <g class="blade blade-3"><polygon points="512,112 660,500 512,392 364,500" fill="#f97316" stroke="#f97316" transform="rotate(180 512 512)"/></g>
            <g class="blade blade-4"><polygon points="512,112 660,500 512,392 364,500" fill="#ef4444" stroke="#ef4444" transform="rotate(270 512 512)"/></g>
            <g class="blade blade-lock">
              <polygon points="512,112 512,392 364,500" fill="#0f7fff" stroke="#0f7fff"/>
              <polygon points="524,364 660,440 632,512" fill="#16a34a" stroke="#16a34a"/>
            </g>
          </g>
        </svg>
        <div class="spark"></div>
      </div>
      <h1 class="brand">GenOffice</h1>
      <p class="status" id="status">${initialLabel}</p>
      <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${initialPct}" id="track">
        <div class="progress-fill" id="fill"></div>
        <div class="progress-shimmer"></div>
      </div>
    </div>
  </div>
  <script>
    window.__setSplashStage = function(stage, label, pct) {
      var card = document.getElementById('card');
      var status = document.getElementById('status');
      var fill = document.getElementById('fill');
      var track = document.getElementById('track');
      if (card && typeof stage === 'string') card.setAttribute('data-stage', stage);
      if (status && typeof label === 'string') status.textContent = label;
      if (fill && typeof pct === 'number') {
        var clamped = Math.max(0, Math.min(100, pct));
        fill.style.transform = 'scaleX(' + (clamped / 100).toFixed(2) + ')';
        if (track) track.setAttribute('aria-valuenow', String(Math.round(clamped)));
      }
    };
    window.__exitSplash = function() {
      var card = document.getElementById('card');
      if (card) card.classList.add('exiting');
    };
  </script>
</body>
</html>`
}
