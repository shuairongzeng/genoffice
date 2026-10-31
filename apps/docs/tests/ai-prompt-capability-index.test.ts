/**
 * Issue #40 item 4: AGENT_SYSTEM_PROMPT mentioned none of the registered
 * page-furniture / style tools (set_watermark, define_style, list_styles,
 * insert_text_box, insert_section_break, set_page_setup), so the model told
 * users it could not do things it could (routing knowledge, not schema
 * knowledge — the op signature index is generated and never drifted).
 */
import { describe, expect, it } from 'vitest'
import { AGENT_SYSTEM_PROMPT } from '../src/renderer/ai/protocol'

describe('AGENT_SYSTEM_PROMPT capability index (issue 40 item 4)', () => {
  const NAMES = [
    'set_watermark',
    'define_style',
    'list_styles',
    'insert_text_box',
    'insert_section_break',
    'set_page_setup',
  ] as const

  it.each([...NAMES])('names the %s tool', (name) => {
    expect(AGENT_SYSTEM_PROMPT).toContain(name)
  })

  it('routes style application to the applyStyle op with its signature', () => {
    expect(AGENT_SYSTEM_PROMPT).toContain('{ op: "applyStyle", target, styleId }')
  })

  it('keeps the family grouped under one heading after headers & footers', () => {
    expect(AGENT_SYSTEM_PROMPT).toContain('# Watermark, styles & page layout')
    expect(AGENT_SYSTEM_PROMPT.indexOf('# Headers & footers')).toBeLessThan(
      AGENT_SYSTEM_PROMPT.indexOf('# Watermark, styles & page layout'),
    )
  })
})
