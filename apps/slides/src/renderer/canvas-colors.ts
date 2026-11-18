/**
 * Konva-drawn editing chrome colours. The redact frame rides into thumbnails
 * over the picture it marks, so it is drawn the same in both UI themes.
 */
export const CANVAS_COLORS = {
  redactFrame: {
    stroke: 'rgba(0,0,0,0.55)',
    chip: 'rgba(0,0,0,0.55)',
    label: '#ffffff',
  },
  /** Find-hit highlight (issue #56 P1 #7): translucent marker yellow over the
   *  hit's line box. Slide content is document data, so this does not follow
   *  the UI theme — one color over both light and dark slide backgrounds. */
  findHit: 'rgba(255,205,0,0.45)',
} as const
