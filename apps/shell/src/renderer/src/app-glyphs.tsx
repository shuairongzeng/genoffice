/**
 * The brand glyphs the desktop's app tiles draw (DesktopView.tsx) — extracted
 * so the macOS-style dock (Dock.tsx) renders the exact same artwork for the
 * launcher items it shares with the desktop. Same 32×32 viewBoxes and stroke
 * weights as before; `currentColor` keeps them on the theme tokens wherever
 * they perch.
 */

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
