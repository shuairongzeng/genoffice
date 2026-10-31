import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { navigateToBlock } from './ai/doc-nav'
import { findMatches } from './components/FindPanel'
import { isPhasedContentPending } from './phased-content'

/** Request/reply the shell relays from `genoffice open --block` and `genoffice selection`. */
export type ControlRequest =
  { cmd: 'goto'; target: { kind: string; block?: number; text?: string } } | { cmd: 'selection' }

export type ControlReply =
  | { status: 'ok'; result: Record<string, unknown> }
  | { status: 'not_ready' }
  | {
      status: 'error'
      error: { reason: string; message: string; detail?: Record<string, unknown> }
    }

export function handleDocsControl(
  req: ControlRequest,
  editor: Editor | null,
  loaded: boolean,
): ControlReply {
  if (!editor || !loaded) return { status: 'not_ready' }
  const doc = editor.state.doc
  if (req.cmd === 'selection') {
    const { from, to, empty } = editor.state.selection
    const lastIndex = doc.childCount - 1
    // a caret after the last node resolves to childCount; `to` is exclusive, so a
    // whole-paragraph selection ends on the next block's boundary
    const first = Math.min(doc.resolve(from).index(0), lastIndex)
    const last = empty ? first : Math.min(doc.resolve(Math.max(from, to - 1)).index(0), lastIndex)
    return {
      status: 'ok',
      result: {
        blocks: [first, Math.max(first, last)],
        text: empty ? '' : doc.textBetween(from, to, '\n'),
        collapsed: empty,
      },
    }
  }
  // the search deep link's target (issue #56): reveal the first text match
  if (req.target.kind === 'text') {
    const text = req.target.text ?? ''
    if (!text.trim()) {
      return {
        status: 'error',
        error: { reason: 'invalid_argument', message: 'a text target must not be empty' },
      }
    }
    // the phased tail is still landing — a match inside it would be missed;
    // the shell asks again once the content settles
    if (isPhasedContentPending()) return { status: 'not_ready' }
    // the panel's default matching, verbatim: case-insensitive AND width-folding
    // — the deep link's text comes from the find surface the panel offers, and
    // a hand-written fragment should land wherever Ctrl+F would land it
    const first = findMatches(editor, text, {
      matchCase: false,
      wholeWord: false,
      matchWidth: false,
    })[0]
    if (!first) {
      return {
        status: 'error',
        error: {
          reason: 'target_not_found',
          message: `"${text}" does not occur in the document`,
        },
      }
    }
    // the NavPane match idiom: select the range, then center it in the page.
    // The optional call covers a reveal that lands before the editor's DOM is
    // attached (and jsdom, which has no scrollIntoView) — the selection, not
    // the scroll, is the load-bearing half.
    const { state, view } = editor
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, first.from, first.to)))
    const { node } = view.domAtPos(first.from)
    const el = node instanceof HTMLElement ? node : node.parentElement
    el?.scrollIntoView?.({ block: 'center' })
    return { status: 'ok', result: { from: first.from, to: first.to } }
  }
  const { block } = req.target
  if (block === undefined || !Number.isInteger(block) || block < 0 || block >= doc.childCount) {
    return {
      status: 'error',
      error: {
        reason: 'out_of_range',
        message: `block ${block} is out of range (the document has ${doc.childCount} blocks)`,
        detail: { valid_range: `0-${doc.childCount - 1}` },
      },
    }
  }
  navigateToBlock(editor, block)
  return { status: 'ok', result: { block, type: doc.child(block).type.name } }
}
