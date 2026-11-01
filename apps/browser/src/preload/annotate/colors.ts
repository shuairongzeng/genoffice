/**
 * The annotation overlay's fixed palette. This layer paints over *untrusted
 * page content*, so the suite's design tokens cannot apply: custom properties
 * inherit across shadow boundaries (`var(--surface)` would resolve against
 * whatever the page defines), and the overlay must stay legible on arbitrary
 * page colors regardless of the suite's light/dark theme. Like the canvas
 * chrome tables (CLAUDE.md rule 5) this is one constants table, not theme
 * keyed — the contrast target is the page, not the app chrome.
 */

/** the browser app's brand blue (browser.css --accent) for picking state */
const HOVER = '#0284c7'

export const ANNOTATE_COLORS = {
  /** the picking-mode hover outline and the ask-AI action */
  hover: HOVER,
  /** the hover outline's fill */
  hoverFill: 'rgb(2 132 199 / 12%)',
  /** the ask-AI button's hover state */
  hoverStrong: '#075985',
  /** text placed on the blue/amber fills */
  onAccent: '#ffffff',
  /** the persisted marker's dashed outline and badge */
  marker: '#d97706',
  /** the popup card */
  cardBg: '#ffffff',
  cardBorder: '#e2e8f0',
  noteBg: '#f8fafc',
  text: '#0f172a',
  /** the picking-mode hint chip */
  hintBg: 'rgb(15 23 42 / 85%)',
  hintText: '#f8fafc',
  /** the delete action */
  danger: '#b91c1c',
  dangerSoft: 'rgb(185 28 28 / 10%)',
} as const
