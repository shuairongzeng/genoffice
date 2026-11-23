/**
 * The brand glyphs the desktop's app tiles draw (DesktopView.tsx) — extracted
 * so the macOS-style dock (Dock.tsx) renders the exact same artwork for the
 * launcher items it shares with the desktop. Line-art glyphs use `currentColor`
 * to stay on theme tokens, while hardware/system glyphs (`ComputerGlyph`,
 * `DriveGlyph`, `OsDesktopGlyph`) use `useId()`-scoped SVG gradients.
 */

import { useId } from 'react'

function useGlyphIds(): (name: string) => string {
  const uid = useId().replace(/:/g, '_')
  return (name: string) => `${uid}-${name}`
}

export function TemplatesGlyph(): React.JSX.Element {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect
        x="9.5"
        y="4.5"
        width="18"
        height="23"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="2.4"
        opacity="0.55"
      />
      <rect x="4.5" y="8.5" width="18" height="19" rx="2.5" fill="currentColor" opacity="0.25" />
      <rect
        x="4.5"
        y="8.5"
        width="18"
        height="19"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="2.4"
      />
      <path
        d="M9 14h9M9 18.5h9M9 23h5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function PlugGlyph(): React.JSX.Element {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 2.5v5.5M15 2.5v5.5M6 8h12v4a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8zM12 18v3.5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function GearGlyph(): React.JSX.Element {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="2.2" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ── the dock's nav icons: line-art glyphs distinct from the squircle
// launcher tiles — the views are switches, not apps ──

export function DockDesktopIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="1.8"
        y="1.8"
        width="5.4"
        height="5.4"
        rx="1.4"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <rect
        x="8.8"
        y="1.8"
        width="5.4"
        height="5.4"
        rx="1.4"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <rect
        x="1.8"
        y="8.8"
        width="5.4"
        height="5.4"
        rx="1.4"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <rect
        x="8.8"
        y="8.8"
        width="5.4"
        height="5.4"
        rx="1.4"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  )
}

export function DockRecentIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.8V8l2.2 1.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

export function DockStarredIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.9l1.9 3.85 4.25.62-3.07 3 .72 4.23L8 11.6l-3.8 2 .72-4.23-3.07-3 4.25-.62z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function DockAskIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M14 10.5c0 .9-.7 1.6-1.6 1.6H5.4L2 14.5V3.6C2 2.7 2.7 2 3.6 2h8.8c.9 0 1.6.7 1.6 1.6z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M5 6.2h6M5 8.6h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

// the cloud launcher (云项目): the Genspark web projects surface — a cloud
// with the spark the brand's project tiles carry, so the launcher family
// reads as one set (same 32×32 stroke weights as the launchers above)
export function CloudGlyph(): React.JSX.Element {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7 18a4.5 4.5 0 0 1-.5-8.97 5.5 5.5 0 0 1 10.66-1.4A4.28 4.28 0 0 1 17.5 18H7z"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path
        d="M12 9.2l.95 2.85L15.8 13l-2.85.95L12 16.8l-.95-2.85L8.2 13l2.85-.95L12 9.2z"
        fill="currentColor"
        opacity="0.9"
      />
    </svg>
  )
}

// ── glyphs ──────────────────────────────────────────────

export function FolderGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3.1c.44 0 .85.19 1.13.52L8.4 4.4H13A1.5 1.5 0 0 1 14.5 5.9v5.6A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5V4z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.14"
      />
    </svg>
  )
}

export function KbGlyph() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M4 24.5V7.5l4.5-2 4 2v17l-4-2-4.5 2z"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path
        d="M12.5 24.5V7.5l4.5-2 4 2v17l-4-2-4.5 2z"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.10"
      />
      <path
        d="M21 24.5V7.5l3.5-2 3.5 2v17l-3.5-2-3.5 2z"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function DocsGlyph() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect x="6.5" y="3.5" width="19" height="25" rx="3" stroke="currentColor" strokeWidth="2.4" />
      <path
        d="M11 11h10M11 16h10M11 21h6"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function SheetsGlyph() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect x="4.5" y="4.5" width="23" height="23" rx="3" stroke="currentColor" strokeWidth="2.2" />
      <path d="M4.5 11.5h23M11.5 11.5v16" stroke="currentColor" strokeWidth="2.2" />
      <rect x="13.5" y="13.5" width="6" height="5" rx="1" fill="currentColor" opacity="0.55" />
      <rect x="20.5" y="19.5" width="5" height="6" rx="1" fill="currentColor" opacity="0.55" />
    </svg>
  )
}

export function SlidesGlyph() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect
        x="3.5"
        y="5.5"
        width="25"
        height="16"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="2.4"
      />
      <path d="M13 10.5l6 3.5-6 3.5z" fill="currentColor" />
      <path
        d="M12 27.5h8M16 21.5v6"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function PdfGlyph() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect x="6.5" y="3.5" width="19" height="25" rx="3" stroke="currentColor" strokeWidth="2.4" />
      <text
        x="16"
        y="17.5"
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
        fontSize="8.5"
        fontWeight="800"
        fontFamily="inherit"
        letterSpacing="0.5"
      >
        PDF
      </text>
    </svg>
  )
}

export function MarkdownGlyph() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect x="4.5" y="6.5" width="23" height="19" rx="3" stroke="currentColor" strokeWidth="2.4" />
      <path
        d="M9 20v-7l3.5 4 3.5-4v7"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 13v7M18.5 17l2.5 3 2.5-3"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function HtmlGlyph() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M11.5 10.5L7 16l4.5 5.5M20.5 10.5L25 16l-4.5 5.5"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/* same artwork as the strip's BrowserIcon, at the desktop tile's scale */
export function BrowserGlyph() {
  return (
    <svg width="32" height="32" viewBox="0 0 240 240" fill="none" aria-hidden="true">
      <circle cx="120" cy="120" r="62" stroke="currentColor" strokeWidth="14" />
      <ellipse cx="120" cy="120" rx="26" ry="62" stroke="currentColor" strokeWidth="14" />
      <path d="M58 96h124M58 144h124" stroke="currentColor" strokeWidth="14" />
    </svg>
  )
}

export function SparkGlyph() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M16 3.5l3.1 9.4 9.4 3.1-9.4 3.1-3.1 9.4-3.1-9.4-9.4-3.1 9.4-3.1z"
        fill="currentColor"
      />
    </svg>
  )
}

/** Dual-bubble chat wireframe glyph for the global AI Sessions center tile. */
export function SessionsGlyph() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M5 7.5A2.5 2.5 0 0 1 7.5 5h12A2.5 2.5 0 0 1 22 7.5v7A2.5 2.5 0 0 1 19.5 17H11l-4 3.2V17H7.5A2.5 2.5 0 0 1 5 14.5v-7z"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.1"
      />
      <path
        d="M14 20.5v1A2.5 2.5 0 0 0 16.5 24H21l4 3v-3h.5A2.5 2.5 0 0 0 28 21.5v-6A2.5 2.5 0 0 0 25.5 13H24"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Media player glyph (rounded frame with centered play triangle) for desktop and dock tiles. */
export function PlayerGlyph(): React.JSX.Element {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect
        x="4.5"
        y="6.5"
        width="23"
        height="19"
        rx="4"
        stroke="currentColor"
        strokeWidth="2.3"
        fill="currentColor"
        fillOpacity="0.12"
      />
      <path
        d="M13 11.4c0-.65.72-1.05 1.27-.7l7.15 4.6c.5.32.5 1.08 0 1.4l-7.15 4.6c-.55.35-1.27-.05-1.27-.7v-9.2z"
        fill="currentColor"
      />
    </svg>
  )
}

/** Terminal console glyph (rounded terminal window with top dots and >_ prompt) for desktop and dock tiles. */
export function TerminalGlyph(): React.JSX.Element {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect
        x="4"
        y="5.5"
        width="24"
        height="21"
        rx="3.5"
        stroke="currentColor"
        strokeWidth="2.3"
        fill="currentColor"
        fillOpacity="0.12"
      />
      <circle cx="8.5" cy="9.8" r="1.15" fill="currentColor" />
      <circle cx="12" cy="9.8" r="1.15" fill="currentColor" />
      <circle cx="15.5" cy="9.8" r="1.15" fill="currentColor" />
      <path
        d="M9 16.5l4 3-4 3"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M15.5 22.5h6.5" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
    </svg>
  )
}

/** Desktop "This PC" Studio Display × Win11 Bloom squircle glyph for desktop and dock tiles. */
export function ComputerGlyph(): React.JSX.Element {
  const id = useGlyphIds()

  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <defs>
        <linearGradient
          id={id('tile-bg')}
          x1="32"
          y1="2"
          x2="32"
          y2="62"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#f7faff" />
          <stop offset="52%" stopColor="#e6f0fb" />
          <stop offset="100%" stopColor="#cde0f6" />
        </linearGradient>
        <linearGradient
          id={id('tile-edge')}
          x1="32"
          y1="2"
          x2="32"
          y2="62"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.92" />
          <stop offset="50%" stopColor="#94a3b8" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#64748b" stopOpacity="0.38" />
        </linearGradient>
        <linearGradient
          id={id('tile-sheen')}
          x1="32"
          y1="2.75"
          x2="32"
          y2="61.25"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="30%" stopColor="#ffffff" stopOpacity="0.24" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={id('base-shadow')} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#0f172a" stopOpacity="0.28" />
          <stop offset="65%" stopColor="#1e293b" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#1e293b" stopOpacity="0" />
        </radialGradient>
        <linearGradient
          id={id('stand-neck')}
          x1="32"
          y1="44.5"
          x2="32"
          y2="52"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#475569" />
          <stop offset="28%" stopColor="#94a3b8" />
          <stop offset="72%" stopColor="#cbd5e1" />
          <stop offset="100%" stopColor="#e2e8f0" />
        </linearGradient>
        <linearGradient
          id={id('stand-foot')}
          x1="20"
          y1="51.5"
          x2="44"
          y2="51.5"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#94a3b8" />
          <stop offset="24%" stopColor="#e2e8f0" />
          <stop offset="50%" stopColor="#f8fafc" />
          <stop offset="76%" stopColor="#cbd5e1" />
          <stop offset="100%" stopColor="#64748b" />
        </linearGradient>
        <linearGradient
          id={id('stand-lip')}
          x1="20"
          y1="53"
          x2="44"
          y2="53"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#64748b" />
          <stop offset="30%" stopColor="#94a3b8" />
          <stop offset="50%" stopColor="#cbd5e1" />
          <stop offset="70%" stopColor="#94a3b8" />
          <stop offset="100%" stopColor="#475569" />
        </linearGradient>
        <linearGradient
          id={id('bezel-bg')}
          x1="32"
          y1="11"
          x2="32"
          y2="40.5"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#334155" />
          <stop offset="50%" stopColor="#1e293b" />
          <stop offset="100%" stopColor="#0f172a" />
        </linearGradient>
        <linearGradient
          id={id('bezel-rim')}
          x1="32"
          y1="11"
          x2="32"
          y2="45.5"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.82" />
          <stop offset="45%" stopColor="#94a3b8" stopOpacity="0.52" />
          <stop offset="100%" stopColor="#475569" stopOpacity="0.45" />
        </linearGradient>
        <linearGradient
          id={id('chin-bg')}
          x1="9"
          y1="42.75"
          x2="55"
          y2="42.75"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#cbd5e1" />
          <stop offset="20%" stopColor="#e2e8f0" />
          <stop offset="48%" stopColor="#f8fafc" />
          <stop offset="76%" stopColor="#e2e8f0" />
          <stop offset="100%" stopColor="#94a3b8" />
        </linearGradient>
        <linearGradient
          id={id('screen-base')}
          x1="11"
          y1="13"
          x2="53"
          y2="40"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#0f172a" />
          <stop offset="45%" stopColor="#1e3a8a" />
          <stop offset="82%" stopColor="#1d4ed8" />
          <stop offset="100%" stopColor="#0284c7" />
        </linearGradient>
        <radialGradient id={id('glow-purple')} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#a855f7" stopOpacity="0.58" />
          <stop offset="100%" stopColor="#a855f7" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id('glow-cyan')} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.58" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
        </radialGradient>
        <linearGradient
          id={id('wave-1')}
          x1="11"
          y1="36"
          x2="53"
          y2="18"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.78" />
          <stop offset="55%" stopColor="#6366f1" stopOpacity="0.56" />
          <stop offset="100%" stopColor="#a855f7" stopOpacity="0.38" />
        </linearGradient>
        <linearGradient
          id={id('wave-2')}
          x1="11"
          y1="22"
          x2="53"
          y2="30"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#e879f9" stopOpacity="0.46" />
          <stop offset="50%" stopColor="#38bdf8" stopOpacity="0.74" />
          <stop offset="100%" stopColor="#bae6fd" stopOpacity="0.68" />
        </linearGradient>
        <linearGradient
          id={id('wave-rim')}
          x1="11"
          y1="30"
          x2="53"
          y2="20"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#e0f2fe" stopOpacity="0.35" />
          <stop offset="50%" stopColor="#ffffff" stopOpacity="0.88" />
          <stop offset="100%" stopColor="#bae6fd" stopOpacity="0.3" />
        </linearGradient>
        <linearGradient
          id={id('screen-glare')}
          x1="11"
          y1="13"
          x2="32"
          y2="34"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={id('chassis-clip')}>
          <rect x="9" y="11" width="46" height="34.5" rx="4.2" />
        </clipPath>
        <clipPath id={id('screen-clip')}>
          <rect x="11" y="13" width="42" height="27" rx="3" />
        </clipPath>
      </defs>

      {/* Outer macOS squircle backdrop */}
      <rect
        x="2"
        y="2"
        width="60"
        height="60"
        rx="15"
        fill={`url(#${id('tile-bg')})`}
        stroke={`url(#${id('tile-edge')})`}
        strokeWidth="1"
      />
      <rect
        x="2.75"
        y="2.75"
        width="58.5"
        height="58.5"
        rx="14.25"
        stroke={`url(#${id('tile-sheen')})`}
        strokeWidth="0.85"
      />

      {/* Soft contact shadow beneath stand */}
      <ellipse cx="32" cy="54.2" rx="13.5" ry="2.2" fill={`url(#${id('base-shadow')})`} />

      {/* Studio Display aluminum neck & chamfered base */}
      <path d="M27.2 44.5h9.6l1.7 7.3H25.5l1.7-7.3z" fill={`url(#${id('stand-neck')})`} />
      <path d="M27.3 45.2l-1.45 6.4" stroke="#f8fafc" strokeWidth="0.6" strokeOpacity="0.55" />
      <path d="M36.7 45.2l1.45 6.4" stroke="#64748b" strokeWidth="0.6" strokeOpacity="0.35" />
      <path
        d="M20.2 52.3c0-.45.36-.8.8-.8h22c.44 0 .8.35.8.8v.85c0 .55-.45 1-1 1H21.2c-.55 0-1-.45-1-1v-.85z"
        fill={`url(#${id('stand-lip')})`}
      />
      <path
        d="M22.2 50.7c.35-.45.9-.7 1.5-.7h16.6c.6 0 1.15.25 1.5.7l1.8 1.9c.28.3.07.8-.34.8H20.74c-.41 0-.62-.5-.34-.8l1.8-1.9z"
        fill={`url(#${id('stand-foot')})`}
      />
      <path d="M21.1 52.5h21.8" stroke="#ffffff" strokeOpacity="0.7" strokeWidth="0.55" />

      {/* Display chassis + brushed aluminum chin */}
      <g clipPath={`url(#${id('chassis-clip')})`}>
        <rect x="9" y="11" width="46" height="29.5" fill={`url(#${id('bezel-bg')})`} />
        <rect x="9" y="40" width="46" height="5.5" fill={`url(#${id('chin-bg')})`} />
        <line
          x1="9"
          y1="40.2"
          x2="55"
          y2="40.2"
          stroke="#0f172a"
          strokeOpacity="0.35"
          strokeWidth="0.5"
        />
        <line
          x1="9"
          y1="45"
          x2="55"
          y2="45"
          stroke="#ffffff"
          strokeOpacity="0.55"
          strokeWidth="0.7"
        />
        <circle cx="32" cy="42.8" r="0.85" fill="#475569" opacity="0.65" />
      </g>
      <rect
        x="9.35"
        y="11.35"
        width="45.3"
        height="33.8"
        rx="3.9"
        stroke={`url(#${id('bezel-rim')})`}
        strokeWidth="0.85"
      />

      {/* Screen: Win11 Bloom × macOS Sonoma aurora fluid waves */}
      <g clipPath={`url(#${id('screen-clip')})`}>
        <rect x="11" y="13" width="42" height="27" fill={`url(#${id('screen-base')})`} />
        <circle cx="17" cy="36" r="16" fill={`url(#${id('glow-purple')})`} />
        <circle cx="47" cy="17" r="16" fill={`url(#${id('glow-cyan')})`} />
        <path
          d="M9 32 C17 20, 27 33, 36 22 C43 14, 49 17, 55 21 L55 41 L9 41 Z"
          fill={`url(#${id('wave-1')})`}
        />
        <path
          d="M9 26 C18 33, 25 18, 35 23 C43 27, 48 16, 55 15 L55 34 C46 31, 39 38, 29 33 C20 29, 15 35, 9 33 Z"
          fill={`url(#${id('wave-2')})`}
        />
        <path
          d="M10 31.5 C18 22, 27 31, 36 22.5 C43 16, 49 18, 54 20.5"
          stroke={`url(#${id('wave-rim')})`}
          strokeWidth="1.2"
          strokeLinecap="round"
          opacity="0.72"
        />

        {/* Centered translucent dock/taskbar capsule with 4 micro app dots */}
        <rect
          x="20.5"
          y="34.4"
          width="23"
          height="3.8"
          rx="1.9"
          fill="#ffffff"
          fillOpacity="0.28"
          stroke="#ffffff"
          strokeOpacity="0.48"
          strokeWidth="0.45"
        />
        <rect x="24.1" y="35" width="2.6" height="2.6" rx="0.9" fill="#38bdf8" />
        <rect x="28.5" y="35" width="2.6" height="2.6" rx="0.9" fill="#4ade80" />
        <rect x="32.9" y="35" width="2.6" height="2.6" rx="0.9" fill="#fb923c" />
        <rect x="37.3" y="35" width="2.6" height="2.6" rx="0.9" fill="#f472b6" />

        {/* Diagonal glass reflection & inner frame depth */}
        <path d="M11 13h25L18 40h-7V13z" fill={`url(#${id('screen-glare')})`} />
        <rect
          x="11.2"
          y="13.2"
          width="41.6"
          height="26.6"
          rx="2.6"
          stroke="#020617"
          strokeOpacity="0.45"
          strokeWidth="0.5"
        />
      </g>
    </svg>
  )
}

/** Local physical drive glyph: brushed aluminum top plate + dark slate bezel with cyan status bar. */
export function DriveGlyph(): React.JSX.Element {
  const id = useGlyphIds()

  const topShellPath =
    'M14.2 15.6C14.8 14.3 16 13.5 17.4 13.5h29.2c1.4 0 2.6.8 3.2 2.1l6.4 16.4c.5 1.3-.4 2.5-1.8 2.5H9.6c-1.4 0-2.3-1.2-1.8-2.5l6.4-16.4z'

  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <defs>
        <radialGradient id={id('shadow')} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#0f172a" stopOpacity="0.34" />
          <stop offset="65%" stopColor="#0f172a" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#0f172a" stopOpacity="0" />
        </radialGradient>
        <linearGradient
          id={id('top-metal')}
          x1="10"
          y1="13"
          x2="54"
          y2="35"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#f8fafc" />
          <stop offset="38%" stopColor="#e2e8f0" />
          <stop offset="74%" stopColor="#cbd5e1" />
          <stop offset="100%" stopColor="#94a3b8" />
        </linearGradient>
        <linearGradient
          id={id('top-sheen')}
          x1="12"
          y1="13.5"
          x2="26"
          y2="33"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <linearGradient
          id={id('front-slate')}
          x1="32"
          y1="34"
          x2="32"
          y2="49.5"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#475569" />
          <stop offset="20%" stopColor="#334155" />
          <stop offset="75%" stopColor="#1e293b" />
          <stop offset="100%" stopColor="#0f172a" />
        </linearGradient>
        <radialGradient id={id('led-glow')} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0" />
        </radialGradient>
        <linearGradient
          id={id('led-bar')}
          x1="13.5"
          y1="41.9"
          x2="24.5"
          y2="41.9"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#7dd3fc" />
          <stop offset="45%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#0ea5e9" />
        </linearGradient>
        <clipPath id={id('top-clip')}>
          <path d={topShellPath} />
        </clipPath>
      </defs>

      {/* Soft contact shadow */}
      <ellipse cx="32" cy="51.2" rx="23" ry="3.2" fill={`url(#${id('shadow')})`} />

      {/* Sloped aluminum top cover */}
      <path d={topShellPath} fill={`url(#${id('top-metal')})`} />
      <g clipPath={`url(#${id('top-clip')})`}>
        <path d="M15 13.5h12L17 34.5H9.5z" fill={`url(#${id('top-sheen')})`} />
        <ellipse
          cx="32"
          cy="23.5"
          rx="11.5"
          ry="5.4"
          stroke="#64748b"
          strokeOpacity="0.16"
          strokeWidth="0.9"
        />
        <ellipse
          cx="32"
          cy="23.5"
          rx="4.2"
          ry="2"
          stroke="#64748b"
          strokeOpacity="0.18"
          strokeWidth="0.85"
        />
      </g>
      <path d={topShellPath} stroke="#64748b" strokeOpacity="0.38" strokeWidth="0.7" />
      {/* Left & top chamfer highlight */}
      <path
        d="M9.1 32.4l5.4-16.3c.5-1.3 1.7-2 3-2h29"
        stroke="#ffffff"
        strokeOpacity="0.68"
        strokeWidth="0.75"
        strokeLinecap="round"
      />

      {/* Dark slate titanium front bezel */}
      <path
        d="M7.5 34.2h49v11a4.3 4.3 0 0 1-4.3 4.3H11.8a4.3 4.3 0 0 1-4.3-4.3v-11z"
        fill={`url(#${id('front-slate')})`}
      />
      <line
        x1="8.2"
        y1="34.3"
        x2="55.8"
        y2="34.3"
        stroke="#ffffff"
        strokeOpacity="0.78"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
      <path
        d="M11.5 48.8h41"
        stroke="#94a3b8"
        strokeOpacity="0.28"
        strokeWidth="0.7"
        strokeLinecap="round"
      />

      {/* Recessed glowing cyan status indicator bar */}
      <rect x="11.5" y="38.8" width="15" height="6.2" rx="3.1" fill={`url(#${id('led-glow')})`} />
      <rect
        x="12.5"
        y="40"
        width="13"
        height="3.8"
        rx="1.9"
        fill="#020617"
        stroke="#64748b"
        strokeOpacity="0.34"
        strokeWidth="0.45"
      />
      <rect x="13.5" y="40.8" width="11" height="2.2" rx="1.1" fill={`url(#${id('led-bar')})`} />
      <circle cx="15.3" cy="41.9" r="1.1" fill="#e0f2fe" />

      {/* Precision micro-vent grooves on the right */}
      <rect x="36.5" y="39.2" width="14" height="1.1" rx="0.55" fill="#090d16" />
      <line
        x1="36.9"
        y1="40.45"
        x2="50.1"
        y2="40.45"
        stroke="#94a3b8"
        strokeOpacity="0.24"
        strokeWidth="0.4"
      />
      <rect x="36.5" y="41.4" width="14" height="1.1" rx="0.55" fill="#090d16" />
      <line
        x1="36.9"
        y1="42.65"
        x2="50.1"
        y2="42.65"
        stroke="#94a3b8"
        strokeOpacity="0.24"
        strokeWidth="0.4"
      />
      <rect x="36.5" y="43.6" width="14" height="1.1" rx="0.55" fill="#090d16" />
      <line
        x1="36.9"
        y1="44.85"
        x2="50.1"
        y2="44.85"
        stroke="#94a3b8"
        strokeOpacity="0.24"
        strokeWidth="0.4"
      />
    </svg>
  )
}

/** OS Desktop place glyph (`sys-place:desktop`): icy glass wallpaper frame, mini tiles & dock pill. */
export function OsDesktopGlyph(): React.JSX.Element {
  const id = useGlyphIds()

  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <defs>
        <radialGradient id={id('shadow')} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#0f172a" stopOpacity="0.28" />
          <stop offset="65%" stopColor="#0f172a" stopOpacity="0.11" />
          <stop offset="100%" stopColor="#0f172a" stopOpacity="0" />
        </radialGradient>
        <linearGradient
          id={id('frame-bg')}
          x1="32"
          y1="12"
          x2="32"
          y2="51"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#f0f9ff" stopOpacity="0.95" />
          <stop offset="55%" stopColor="#bae6fd" stopOpacity="0.82" />
          <stop offset="100%" stopColor="#7dd3fc" stopOpacity="0.72" />
        </linearGradient>
        <linearGradient
          id={id('frame-edge')}
          x1="32"
          y1="12"
          x2="32"
          y2="51"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#0284c7" stopOpacity="0.45" />
        </linearGradient>
        <linearGradient
          id={id('wallpaper-bg')}
          x1="9.5"
          y1="14.5"
          x2="54.5"
          y2="48.5"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#e0f2fe" />
          <stop offset="45%" stopColor="#60a5fa" />
          <stop offset="100%" stopColor="#2563eb" />
        </linearGradient>
        <linearGradient
          id={id('aurora-wave')}
          x1="10"
          y1="40"
          x2="54"
          y2="18"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.68" />
          <stop offset="60%" stopColor="#818cf8" stopOpacity="0.42" />
          <stop offset="100%" stopColor="#a78bfa" stopOpacity="0.34" />
        </linearGradient>
        <linearGradient
          id={id('aurora-mist')}
          x1="9.5"
          y1="28"
          x2="54.5"
          y2="30"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#bae6fd" stopOpacity="0.16" />
        </linearGradient>
        <linearGradient
          id={id('glass-glare')}
          x1="9.5"
          y1="14.5"
          x2="34"
          y2="42"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={id('screen-clip')}>
          <rect x="9.5" y="14.5" width="45" height="34" rx="5.2" />
        </clipPath>
      </defs>

      {/* Soft ground shadow */}
      <ellipse cx="32" cy="52.4" rx="20.5" ry="2.6" fill={`url(#${id('shadow')})`} />

      {/* Icy glass window frame */}
      <rect
        x="7"
        y="12"
        width="50"
        height="39"
        rx="7.5"
        fill={`url(#${id('frame-bg')})`}
        stroke={`url(#${id('frame-edge')})`}
        strokeWidth="1"
      />

      {/* Desktop wallpaper surface */}
      <g clipPath={`url(#${id('screen-clip')})`}>
        <rect x="9.5" y="14.5" width="45" height="34" fill={`url(#${id('wallpaper-bg')})`} />
        <path
          d="M8 38 C16 26, 28 34, 38 23 C45 16, 51 19, 56 22 V50 H8 Z"
          fill={`url(#${id('aurora-wave')})`}
        />
        <path
          d="M8 31 C17 37, 27 23, 39 28 C46 31, 51 24, 56 23 V39 C47 36, 37 42, 26 37 C18 33, 12 37, 8 36 Z"
          fill={`url(#${id('aurora-mist')})`}
        />

        {/* Two crisp mini desktop icon blocks in the top-right */}
        <rect x="43" y="18.7" width="7.2" height="7.2" rx="2" fill="#0f172a" fillOpacity="0.16" />
        <rect x="42.5" y="18" width="7.2" height="7.2" rx="2" fill="#ffffff" fillOpacity="0.95" />
        <rect x="44.1" y="19.8" width="4" height="1.2" rx="0.6" fill="#38bdf8" />
        <rect x="44.1" y="21.9" width="2.8" height="1.1" rx="0.55" fill="#94a3b8" opacity="0.6" />

        <rect x="43" y="28.2" width="7.2" height="7.2" rx="2" fill="#0f172a" fillOpacity="0.16" />
        <rect x="42.5" y="27.5" width="7.2" height="7.2" rx="2" fill="#f0f9ff" fillOpacity="0.9" />
        <path
          d="M44 29.8c0-.4.3-.7.7-.7h1.4l.6.6h1.6c.4 0 .7.3.7.7v2.1c0 .4-.3.7-.7.7h-3.6c-.4 0-.7-.3-.7-.7v-2.7z"
          fill="#0ea5e9"
          opacity="0.88"
        />

        {/* Translucent bottom centered desktop dock pill */}
        <rect
          x="17.5"
          y="40.8"
          width="29"
          height="5.8"
          rx="2.9"
          fill="#0f172a"
          fillOpacity="0.14"
        />
        <rect
          x="17.5"
          y="40.1"
          width="29"
          height="5.8"
          rx="2.9"
          fill="#ffffff"
          fillOpacity="0.56"
          stroke="#ffffff"
          strokeOpacity="0.84"
          strokeWidth="0.65"
        />
        <rect x="22.25" y="41.65" width="2.7" height="2.7" rx="0.9" fill="#0ea5e9" />
        <rect x="27.85" y="41.65" width="2.7" height="2.7" rx="0.9" fill="#10b981" />
        <rect x="33.45" y="41.65" width="2.7" height="2.7" rx="0.9" fill="#f97316" />
        <rect x="39.05" y="41.65" width="2.7" height="2.7" rx="0.9" fill="#6366f1" />

        {/* Diagonal glass sheen & inner rim */}
        <path d="M9.5 14.5h26L17 48.5H9.5V14.5z" fill={`url(#${id('glass-glare')})`} />
        <rect
          x="9.75"
          y="14.75"
          width="44.5"
          height="33.5"
          rx="5"
          stroke="#ffffff"
          strokeOpacity="0.35"
          strokeWidth="0.5"
        />
      </g>
    </svg>
  )
}
