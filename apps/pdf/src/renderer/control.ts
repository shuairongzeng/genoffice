/** Request/reply the shell relays from `genoffice open --page` and `genoffice selection`. */
export type ControlRequest =
  { cmd: 'goto'; target: { kind: string; page?: number; text?: string } } | { cmd: 'selection' }

export type ControlReply =
  | { status: 'ok'; result: Record<string, unknown> }
  | { status: 'not_ready' }
  | {
      status: 'error'
      error: { reason: string; message: string; detail?: Record<string, unknown> }
    }

export interface PdfControlState {
  loaded: boolean
  pageCount: number
  currentPage: number
  scrollToPage: (page: number) => void
  selectedText: () => string
  /**
   * The search deep link's reveal (issue #56): search for the text and land
   * on the first match (the find bar opens populated). False when the text
   * does not occur; the underlying search index build is awaited inside, so
   * a big document just takes its time.
   */
  gotoText?: (text: string) => Promise<boolean>
}

export async function handlePdfControl(
  req: ControlRequest,
  state: PdfControlState,
): Promise<ControlReply> {
  if (!state.loaded || state.pageCount === 0) return { status: 'not_ready' }
  if (req.cmd === 'selection') {
    const text = state.selectedText()
    return { status: 'ok', result: { page: state.currentPage, ...(text ? { text } : {}) } }
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
    if (!state.gotoText) return { status: 'not_ready' }
    const found = await state.gotoText(text)
    return found
      ? { status: 'ok', result: { text } }
      : {
          status: 'error',
          error: {
            reason: 'target_not_found',
            message: `"${text}" does not occur in the document`,
          },
        }
  }
  const { page } = req.target
  if (page === undefined || !Number.isInteger(page) || page < 1 || page > state.pageCount) {
    return {
      status: 'error',
      error: {
        reason: 'out_of_range',
        message: `page ${page} is out of range (the document has ${state.pageCount} pages)`,
        detail: { valid_range: `1-${state.pageCount}` },
      },
    }
  }
  state.scrollToPage(page)
  return { status: 'ok', result: { page } }
}
