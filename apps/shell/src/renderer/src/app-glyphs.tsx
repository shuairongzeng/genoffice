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

// ── the dock's nav icons: the exact artwork the sidebar nav carried (the
// items migrate to the dock, their glyphs travel with them; the launcher
// glyphs above are shared with the desktop tiles) ──
// ── the dock's nav icons: the exact artwork the sidebar nav carried (the
// items migrate to the dock, their glyphs travel with them; the launcher
// glyphs come from app-glyphs.tsx, shared with the desktop tiles) ──

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
