/**
 * Issue #56 P2 #8 — the inspector's find half, executed for real in jsdom:
 * the raw source is evaluated once, the way instrumentForPreview injects it
 * (a plain script in the frame). window.parent === window in jsdom, so
 * window.postMessage is stubbed to capture the inspector's posts
 * synchronously, and control messages are dispatched as message events on
 * the same window. Range rects are stubbed — jsdom has no layout, but the
 * overlay math only needs client rects to exist. jsdom applies the UA
 * stylesheet (block/inline displays, visibility), so the rendered-text and
 * block-boundary logic runs the way it does in a real frame.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import inspectorSource from '../src/renderer/preview/inspector.js?raw'

const OVERLAY = 'data-gx-inspector-overlay'
type DocTextNode = { id: number; text: string; sep?: string }
type DocTextMsg = { type: 'gx:docText'; nodes: DocTextNode[] }

/** every post the inspector made, in order (the raw source's version is NaN —
 *  instrumentForPreview replaces it in real frames) */
let posted: Array<Record<string, unknown>> = []
const lastOf = (type: string): Record<string, unknown> | undefined =>
  posted.filter((m) => m.type === type).at(-1)

const send = (msg: Record<string, unknown>): void => {
  window.dispatchEvent(new MessageEvent('message', { data: msg }))
}

const waitForPosted = (type: string, timeout = 3000): Promise<Record<string, unknown>> =>
  vi.waitFor(() => {
    const found = lastOf(type)
    if (!found) throw new Error(`no ${type} posted yet`)
    return found
  }, timeout)

const overlayBoxes = (): HTMLElement[] =>
  Array.from(
    document.documentElement.querySelectorAll<HTMLElement>(
      `[${OVERLAY}="findhit"], [${OVERLAY}="findact"]`,
    ),
  )

const docTextCount = (): number => posted.filter((m) => m.type === 'gx:docText').length

/** swap the frame body, then let the observer deliver the reset's mutation
 *  records BEFORE reporting turns on — an undelivered record would schedule a
 *  spurious re-push the moment a test arms the session */
const setBody = async (html: string): Promise<void> => {
  document.body.innerHTML = html
  await new Promise((r) => setTimeout(r, 0))
}

const realPostMessage = window.postMessage.bind(window)
const realClientRects = Range.prototype.getClientRects
const realScrollIntoView = Element.prototype.scrollIntoView
let scrollToSpy: ReturnType<typeof vi.spyOn>

beforeAll(() => {
  window.postMessage = ((data: unknown) => {
    if (data && typeof (data as Record<string, unknown>).type === 'string')
      posted.push(data as Record<string, unknown>)
  }) as typeof window.postMessage
  // jsdom elements cannot scrollIntoView; the inspector only needs it not to
  // throw while a selection message is handled
  Element.prototype.scrollIntoView = () => {}
  new Function(inspectorSource)()
})

afterAll(() => {
  window.postMessage = realPostMessage
  Element.prototype.scrollIntoView = realScrollIntoView
})

describe('inspector find-in-preview (issue #56 P2 #8)', () => {
  beforeEach(async () => {
    posted = []
    await setBody(
      '<p id="a">Hel<b>lo wo</b>rld</p><script>var x = "plain"</script><style>.x{color:red}</style>',
    )
    // jsdom has no layout: give ranges one stable client rect so the overlay
    // pool is exercised
    Range.prototype.getClientRects = () =>
      [{ left: 10, top: 20, width: 30, height: 12 }] as DOMRectList
    scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    // start each test from a blank find slate (also cancels a pending push)
    send({ type: 'gx:findClear' })
    send({ type: 'gx:setDocText', on: false })
    // the fixture reset above is itself a mutation: let the observer deliver
    // those records while reporting is still off, or they would schedule a
    // spurious re-push the moment a test turns reporting on
    await new Promise((r) => setTimeout(r, 0))
  })
  afterEach(() => {
    send({ type: 'gx:findClear' })
    send({ type: 'gx:setDocText', on: false })
    scrollToSpy.mockRestore()
    Range.prototype.getClientRects = realClientRects
    document.body.innerHTML = ''
  })

  it('pushes the rendered body text node by node, skipping script and style', async () => {
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    expect(snapshot.nodes.map((n) => n.text)).toEqual(['Hel', 'lo wo', 'rld'])
    // distinct stable ids the host addresses ranges by
    expect(new Set(snapshot.nodes.map((n) => n.id)).size).toBe(3)
    // one inline run inside the paragraph: no block boundary, no separator
    expect(snapshot.nodes.every((n) => n.sep === undefined)).toBe(true)
  })

  it('skips text the reader cannot see: display:none, hidden visibility, closed details', async () => {
    await setBody(
      '<p id="v">visible</p>' +
        '<div style="display:none">secret</div>' +
        '<div style="visibility:hidden">vsecret</div>' +
        '<details><summary>More</summary><p>hidden-needle</p></details>' +
        '<p>after</p>',
    )
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    // a closed details hides its content but keeps its summary on screen
    expect(snapshot.nodes.map((n) => n.text)).toEqual(['visible', 'More', 'after'])
  })

  it('mirrors form-control values (their own block, never joined) and skips non-textual controls', async () => {
    await setBody(
      '<p id="p1">Hel</p>' +
        '<input id="in" value="fieldtext">' +
        '<input type="checkbox" value="nope">' +
        '<input type="hidden" value="nope2">' +
        '<div style="display:none"><input value="hiddenval"></div>' +
        '<textarea id="ta">ta text</textarea>' +
        '<p id="p2">lo</p>',
    )
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    expect(snapshot.nodes.map((n) => n.text)).toEqual(['Hel', 'fieldtext', 'ta text', 'lo'])
    // the controls own a block each: a separator before them and before the
    // text that follows, so a phrase never joins across a control
    expect(snapshot.nodes.map((n) => n.sep)).toEqual([undefined, '\n', '\n', '\n'])
    // a control's value paints as one box over the control itself. jsdom
    // rects are all-zero, which the scroll now rightly skips as not-rendered:
    // give the control a real box so the scroll has somewhere to go
    const control = snapshot.nodes.find((n) => n.text === 'fieldtext')!
    const input = document.querySelector('#in') as HTMLElement
    input.getBoundingClientRect = () => ({ left: 5, top: 300, width: 60, height: 16 }) as DOMRect
    send({
      type: 'gx:findMark',
      matches: [[{ id: control.id, start: 0, end: 9 }]],
      active: 0,
      scroll: true,
    })
    expect(overlayBoxes()).toHaveLength(1)
    expect(overlayBoxes()[0]!.getAttribute(OVERLAY)).toBe('findact')
    expect(window.scrollTo).toHaveBeenCalled()
  })

  it('typing into a control re-pushes (values change without mutation records)', async () => {
    await setBody('<p>Hel</p><textarea id="ta">ta text</textarea>')
    send({ type: 'gx:setDocText', on: true })
    await waitForPosted('gx:docText')
    const before = docTextCount()
    const ta = document.querySelector('#ta') as HTMLTextAreaElement
    ta.value = 'edited'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => {
      if (docTextCount() !== before + 1) throw new Error('input re-push did not arrive')
    })
    const latest = lastOf('gx:docText') as unknown as DocTextMsg
    expect(latest.nodes.map((n) => n.text)).toEqual(['Hel', 'edited'])
    // and reporting off also silences the input listener
    send({ type: 'gx:setDocText', on: false })
    ta.value = 'edited again'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 600))
    expect(docTextCount()).toBe(before + 1)
  })

  it('drops whitespace runs that straddle blocks, keeps the ones inside a block', async () => {
    await setBody('<div id="d1">a</div> <div id="d2">b</div><p id="p">c <b>d</b></p>')
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    // the ' ' between the divs is layout-collapsed: gone. 'c ' and 'd' share
    // the paragraph, so they read continuously
    expect(snapshot.nodes.map((n) => n.text)).toEqual(['a', 'b', 'c ', 'd'])
    expect(snapshot.nodes.map((n) => n.sep)).toEqual([undefined, '\n', '\n', undefined])
  })

  it('a <br> separates lines: whole words break and phrases do not glue across it', async () => {
    await setBody('<p id="a">line one<br>line two</p>')
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    expect(snapshot.nodes.map((n) => n.text)).toEqual(['line one', 'line two'])
    expect(snapshot.nodes.map((n) => n.sep)).toEqual([undefined, '\n'])
    // whitespace right after the break is line-leading: collapsed away
    await setBody('<p id="a">one<br>  two</p>')
    send({ type: 'gx:setDocText', on: false })
    send({ type: 'gx:setDocText', on: true })
    const second = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    expect(second.nodes.map((n) => n.text)).toEqual(['one', 'two'])
    expect(second.nodes.map((n) => n.sep)).toEqual([undefined, '\n'])
    // an empty block box between same-host runs still breaks the line
    await setBody('<div id="a">x<p></p> z</div>')
    send({ type: 'gx:setDocText', on: false })
    send({ type: 'gx:setDocText', on: true })
    const third = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    expect(third.nodes.map((n) => n.text)).toEqual(['x', 'z'])
    expect(third.nodes.map((n) => n.sep)).toEqual([undefined, '\n'])
  })

  it('a source line wrap inside a paragraph renders as one space, and matches paint at raw offsets', async () => {
    await setBody('<p id="a">Results\n\nare in</p>')
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    // the reader sees "Results are in": the whitespace run collapsed to one
    // space, so the phrase is findable
    expect(snapshot.nodes.map((n) => n.text)).toEqual(['Results are in'])
    // a match the host computed on the NORMALIZED text still addresses the
    // node's raw data: 'are' is normalized 8..11, raw 9..12 (the run was two
    // characters wide)
    const offsets: Array<{ start: number; end: number }> = []
    Range.prototype.getClientRects = function (this: Range) {
      offsets.push({ start: this.startOffset, end: this.endOffset })
      return [{ left: 10, top: 20, width: 30, height: 12 }] as DOMRectList
    }
    send({
      type: 'gx:findMark',
      matches: [[{ id: snapshot.nodes[0]!.id, start: 8, end: 11 }]],
      active: 0,
      scroll: false,
    })
    expect(offsets).toEqual([{ start: 9, end: 12 }])
    expect(overlayBoxes()).toHaveLength(1)
    // a run split across inline nodes renders as ONE space: the leading run
    // of the second node collapses into the first node's trailing space
    await setBody('<p id="a">a <b> b</b>c</p>')
    send({ type: 'gx:setDocText', on: false })
    send({ type: 'gx:setDocText', on: true })
    const second = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    expect(second.nodes.map((n) => n.text)).toEqual(['a ', 'b', 'c'])
  })

  it('inline-level boxes (inline-block chips) join flush: no false block separator', async () => {
    await setBody(
      '<p id="p">Hel<span style="display:inline-block">lo</span> wo<span style="display:inline-flex">r</span>ld</p>',
    )
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    // the reader sees "Hello world" on one line: the mirror must join the
    // same way, or a phrase query across a chip returns 0 matches
    expect(snapshot.nodes.map((n) => n.text)).toEqual(['Hel', 'lo', ' wo', 'r', 'ld'])
    expect(snapshot.nodes.every((n) => n.sep === undefined)).toBe(true)
  })

  it('a dropdown select mirrors only its selected label; a listbox keeps its options', async () => {
    await setBody(
      '<p id="p1">Hel</p>' +
        '<select id="s"><option value="a">Alpha</option><option value="b" selected>Beta</option></select>' +
        '<p id="p2">lo</p>',
    )
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    // the closed dropdown renders one label (its selected option), the rest
    // of the options are hidden — not searchable
    expect(snapshot.nodes.map((n) => n.text)).toEqual(['Hel', 'Beta', 'lo'])
    expect(snapshot.nodes.map((n) => n.sep)).toEqual([undefined, '\n', '\n'])
    // a listbox (multiple) shows every option, one line each
    await setBody('<select id="m" multiple><option>Alpha</option><option>Beta</option></select>')
    send({ type: 'gx:setDocText', on: false })
    send({ type: 'gx:setDocText', on: true })
    const second = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    expect(second.nodes.map((n) => n.text)).toEqual(['Alpha', 'Beta'])
    expect(second.nodes.map((n) => n.sep)).toEqual([undefined, '\n'])
  })

  it('a matched control removed after painting hides its box instead of painting a phantom at (0,0)', async () => {
    await setBody('<p>Hel</p><input id="in" value="fieldtext">')
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    const control = snapshot.nodes.find((n) => n.text === 'fieldtext')!
    send({
      type: 'gx:findMark',
      matches: [[{ id: control.id, start: 0, end: 9 }]],
      active: 0,
      scroll: true,
    })
    expect(overlayBoxes()).toHaveLength(1)
    scrollToSpy.mockClear()
    // the page removes the control: a repaint must hide the box (a detached
    // rect reads (0,0)) and activation must not yank the scroll to it
    document.getElementById('in')!.remove()
    window.dispatchEvent(new Event('scroll'))
    expect(overlayBoxes()[0]!.style.display).toBe('none')
    send({ type: 'gx:findActivate', active: 0 })
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  it('page content appended directly under <html> is mirrored (the chrome filter must not swallow it)', async () => {
    await setBody('<p id="a">Hel</p>')
    send({ type: 'gx:setDocText', on: true })
    await waitForPosted('gx:docText')
    const before = docTextCount()
    // a page script legally appends straight to <html> (outside body)
    const extra = document.createElement('div')
    extra.textContent = 'bonus text'
    document.documentElement.appendChild(extra)
    await vi.waitFor(() => {
      if (docTextCount() !== before + 1) throw new Error('html-append re-push did not arrive')
    })
    const latest = lastOf('gx:docText') as unknown as DocTextMsg
    expect(latest.nodes.map((n) => n.text)).toEqual(['Hel', 'bonus text'])
    // our chrome appended the same way stays filtered: painting a match (pool
    // growth under documentElement) does not re-push
    const after = docTextCount()
    send({
      type: 'gx:findMark',
      matches: [[{ id: latest.nodes[0]!.id, start: 0, end: 3 }]],
      active: 0,
      scroll: false,
    })
    await new Promise((r) => setTimeout(r, 600))
    expect(docTextCount()).toBe(after)
    extra.remove()
  })

  it('emphasizes whole matches (all their pieces), addresses matches by index, and scrolls only when asked', async () => {
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    const [first, second, third] = snapshot.nodes
    // match 1 spans two nodes (two pieces); match 2 is the single-node 'rld'
    send({
      type: 'gx:findMark',
      matches: [
        [
          { id: first.id, start: 0, end: 3 },
          { id: second.id, start: 0, end: 2 },
        ],
        [{ id: third.id, start: 0, end: 3 }],
      ],
      active: 1,
      scroll: false,
    })
    // one box per piece; the ACTIVE match is match 2 — match 1's pieces stay
    // plain no matter how many nodes they span (the panel counts matches,
    // never pieces)
    const boxes = overlayBoxes()
    expect(boxes).toHaveLength(3)
    expect(boxes.map((b) => b.getAttribute(OVERLAY))).toEqual(['findhit', 'findhit', 'findact'])
    // a repaint-in-place rescan must not hijack the viewport
    expect(window.scrollTo).not.toHaveBeenCalled()
    // navigation: match 1 becomes active — BOTH its pieces light up
    send({ type: 'gx:findActivate', active: 0 })
    expect(overlayBoxes().map((b) => b.getAttribute(OVERLAY))).toEqual([
      'findact',
      'findact',
      'findhit',
    ])
    expect(window.scrollTo).toHaveBeenCalled()
    // a search whose context moved (fresh needle) scrolls to its active match
    scrollToSpy.mockClear()
    send({
      type: 'gx:findMark',
      matches: [[{ id: third.id, start: 0, end: 3 }]],
      active: 0,
      scroll: true,
    })
    expect(overlayBoxes()).toHaveLength(1)
    expect(window.scrollTo).toHaveBeenCalled()
    send({ type: 'gx:findClear' })
    expect(overlayBoxes()).toHaveLength(0)
  })

  it('a match whose node is gone paints nothing but keeps its index slot', async () => {
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    const [first] = snapshot.nodes
    send({
      type: 'gx:findMark',
      matches: [[{ id: 999, start: 0, end: 3 }], [{ id: first.id, start: 0, end: 3 }]],
      active: 1,
      scroll: false,
    })
    // the stale id painted nothing, yet match 2 still occupies slot 2: the
    // emphasis addresses the real match, not the shifted survivor
    const boxes = overlayBoxes()
    expect(boxes).toHaveLength(1)
    expect(boxes[0]!.getAttribute(OVERLAY)).toBe('findact')
  })

  it('own-chrome churn (selection label on scroll/resize) does not re-push the snapshot', async () => {
    await setBody('<p id="a" data-gx-sid="7">Hel<b>lo</b></p>')
    send({ type: 'gx:setDocText', on: true })
    await waitForPosted('gx:docText')
    const before = docTextCount()
    // arm the selection label, then churn it the way refresh() does on every
    // scroll and resize event — the label is our [MARK] chrome
    send({ type: 'gx:select', sid: 7 })
    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('resize'))
    await new Promise((r) => setTimeout(r, 600))
    expect(docTextCount()).toBe(before)
    // a real page mutation still pushes after the debounce
    document.body.querySelector('#a')!.append('!')
    await vi.waitFor(() => {
      if (docTextCount() !== before + 1) throw new Error('mutation re-push did not arrive')
    })
    const latest = lastOf('gx:docText') as unknown as DocTextMsg
    expect(latest.nodes.map((n) => n.text)).toEqual(['Hel', 'lo', '!'])
  })

  it('re-pushes the snapshot after settled page mutations, and stops when turned off', async () => {
    send({ type: 'gx:setDocText', on: true })
    const first = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    const before = docTextCount()
    document.body.querySelector('#a')!.append('!')
    // the initial snapshot still satisfies a "last docText" probe: wait for
    // the count itself to move (the observer debounces ~250ms)
    await vi.waitFor(() => {
      if (docTextCount() !== before + 1) throw new Error('mutation re-push did not arrive')
    })
    const latest = lastOf('gx:docText') as unknown as DocTextMsg
    // append('!') adds a sibling text node (DOM does not merge runs) — a new
    // node with a fresh id, the survivors keep theirs
    expect(latest.nodes.map((n) => n.text)).toEqual(['Hel', 'lo wo', 'rld', '!'])
    expect(latest.nodes.slice(0, 3).map((n) => n.id)).toEqual(first.nodes.map((n) => n.id))
    expect(latest.nodes[3]!.id).not.toBe(first.nodes[0]!.id)

    send({ type: 'gx:setDocText', on: false })
    document.body.querySelector('#a')!.append('?')
    await new Promise((r) => setTimeout(r, 600))
    // reporting is off: the mutation pushed nothing
    expect(docTextCount()).toBe(before + 1)
  })

  it('pre-formatted runs keep their leading whitespace (identity map stays aligned)', async () => {
    // pre-family whitespace is RENDERED: the line-leading strip must not fire,
    // or the pushed text loses a real character and every painted range in the
    // node shifts one char left (map is null there — nothing would catch it)
    await setBody('<div style="white-space:pre">one<br> two</div>')
    send({ type: 'gx:setDocText', on: true })
    const first = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    expect(first.nodes.map((n) => n.text)).toEqual(['one', ' two'])
    // a pre block after another block: the indented first line keeps its spaces
    await setBody('<p>intro</p><pre>  indented()</pre>')
    send({ type: 'gx:setDocText', on: false })
    send({ type: 'gx:setDocText', on: true })
    const second = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    expect(second.nodes.map((n) => n.text)).toEqual(['intro', '  indented()'])
    expect(second.nodes.map((n) => n.sep)).toEqual([undefined, '\n'])
    // and a match still paints at the RAW offsets (identity map = raw data),
    // while this fixture is still the live document
    const offsets: Array<{ start: number; end: number }> = []
    Range.prototype.getClientRects = function (this: Range) {
      offsets.push({ start: this.startOffset, end: this.endOffset })
      return [{ left: 10, top: 20, width: 30, height: 12 }] as DOMRectList
    }
    send({
      type: 'gx:findMark',
      matches: [[{ id: second.nodes[1]!.id, start: 2, end: 10 }]],
      active: 0,
      scroll: false,
    })
    expect(offsets).toEqual([{ start: 2, end: 10 }])
    expect(overlayBoxes()).toHaveLength(1)
    // pre-wrap across inline nodes: both spaces are real, nothing collapses
    // (jsdom does not inherit computed styles, so the b restates the property
    // the way a real engine computes it for the child)
    await setBody(
      '<div style="white-space:pre-wrap">a <b style="white-space:pre-wrap"> b</b></div>',
    )
    send({ type: 'gx:setDocText', on: false })
    send({ type: 'gx:setDocText', on: true })
    const third = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    expect(third.nodes.map((n) => n.text)).toEqual(['a ', ' b'])
    expect(third.nodes.every((n) => n.sep === undefined)).toBe(true)
  })

  it('a <br> the layout does not render (display:none) draws no separator', async () => {
    await setBody('<p id="a">a<br style="display:none">b</p>')
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    // no line is drawn, so "ab" reads continuously and stays findable
    expect(snapshot.nodes.map((n) => n.text)).toEqual(['a', 'b'])
    expect(snapshot.nodes.every((n) => n.sep === undefined)).toBe(true)
  })

  it('out-of-flow boxes (positioned, floated) do not wedge separators into flush text', async () => {
    // real engines blockify these to display:block while the text keeps
    // flowing around them: the mirror must not read the blockification as a
    // line break, or the phrase the reader sees becomes unfindable
    await setBody(
      '<p id="a">Hel<span style="position:absolute;display:block">x</span>lo</p>' +
        '<p id="b">a<span style="float:left;display:block">y</span>b</p>',
    )
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    expect(snapshot.nodes.map((n) => n.text)).toEqual(['Hel', 'x', 'lo', 'a', 'y', 'b'])
    // the ONLY separator is the real one between the two paragraphs: the
    // out-of-flow spans join their paragraphs' runs flush
    expect(snapshot.nodes.map((n) => n.sep)).toEqual([
      undefined,
      undefined,
      undefined,
      '\n',
      undefined,
      undefined,
    ])
    // an IN-flow block box between same-host runs still breaks the line
    await setBody('<p id="c">a<span style="display:block">mid</span>b</p>')
    send({ type: 'gx:setDocText', on: false })
    send({ type: 'gx:setDocText', on: true })
    const second = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    expect(second.nodes.map((n) => n.text)).toEqual(['a', 'mid', 'b'])
    expect(second.nodes.map((n) => n.sep)).toEqual([undefined, '\n', '\n'])
  })

  it('a dropdown option with a label attribute mirrors the label it renders', async () => {
    await setBody('<select id="s"><option label="Shown label">raw text</option></select>')
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    // the closed dropdown draws the label attribute, not the option's text
    expect(snapshot.nodes.map((n) => n.text)).toEqual(['Shown label'])
  })

  it('a piece with only zero rects (connected but not rendered) never yanks the scroll', async () => {
    await setBody('<p id="a">needle</p>')
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    // all-zero rects read as (0,0): scrolling there would jump the reader to
    // the top of the page — the piece is skipped instead
    Range.prototype.getClientRects = () => [{ left: 0, top: 0, width: 0, height: 0 }] as DOMRectList
    send({
      type: 'gx:findMark',
      matches: [[{ id: snapshot.nodes[0]!.id, start: 0, end: 6 }]],
      active: 0,
      scroll: true,
    })
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  it('a match deep inside a nested overflow container scrolls the container too', async () => {
    await setBody(
      '<p>top</p><div id="scroller" style="overflow:auto"><p id="deep">needle</p></div>',
    )
    // jsdom has no layout: give the scroller a plausible box and the match a
    // rect far below the fold
    const scroller = document.getElementById('scroller')!
    let scrolledTo = -1
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => 0,
      set: (v: number) => {
        scrolledTo = v
      },
      configurable: true,
    })
    Range.prototype.getClientRects = () =>
      [{ left: 10, top: 500, width: 30, height: 12 }] as DOMRectList
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    const deep = snapshot.nodes.find((n) => n.text === 'needle')!
    send({
      type: 'gx:findMark',
      matches: [[{ id: deep.id, start: 0, end: 6 }]],
      active: 0,
      scroll: true,
    })
    // the window scrolls to the match AND the inner container moves it into
    // its own viewport: the frame window alone would leave it clipped
    expect(window.scrollTo).toHaveBeenCalled()
    expect(scrolledTo).toBe(400)
  })

  it('a forged findMark payload is skipped or clamped, never thrown', async () => {
    await setBody('<p id="a">a  b</p>')
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    const n = snapshot.nodes[0]!
    // non-array matches / pieces and non-numeric ids are dropped; the real
    // piece beside the garbage still paints, and the match keeps its slot
    send({
      type: 'gx:findMark',
      matches: 'nope',
      active: 0,
      scroll: false,
    })
    expect(overlayBoxes()).toHaveLength(0)
    send({
      type: 'gx:findMark',
      matches: [[{ id: 'x', start: 0, end: 1 }], 'garbage', [{ id: n.id, start: 0, end: 2 }]],
      active: 2,
      scroll: false,
    })
    expect(overlayBoxes()).toHaveLength(1)
    expect(overlayBoxes()[0]!.getAttribute(OVERLAY)).toBe('findact')
    // offsets past the data clamp to its end instead of throwing
    send({
      type: 'gx:findMark',
      matches: [[{ id: n.id, start: 99, end: 999 }]],
      active: 0,
      scroll: false,
    })
    expect(overlayBoxes()).toHaveLength(1)
    // the node shrank after the mirror was built (stale map): the map path
    // must clamp to the CURRENT length, or setEnd throws past the handler and
    // the whole paint dies half-cleared
    document.querySelector('#a')!.childNodes[0]!.textContent = 'a'
    send({
      type: 'gx:findMark',
      matches: [[{ id: n.id, start: 0, end: 2 }]],
      active: 0,
      scroll: false,
    })
    expect(overlayBoxes()).toHaveLength(1)
  })

  it('a closed details without a summary still breaks the line (its collapsed box renders)', async () => {
    await setBody('<div id="a">a<details></details>b</div>')
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    // the details box occupies a line even though none of its content
    // renders: 'a' and 'b' must not glue into 'ab' (whole-word edges at that
    // boundary depend on the separator)
    expect(snapshot.nodes.map((n) => n.text)).toEqual(['a', 'b'])
    expect(snapshot.nodes.map((n) => n.sep)).toEqual([undefined, '\n'])
  })

  it('a connected-but-not-rendered control piece paints no phantom 2x2 box at (0,0)', async () => {
    await setBody('<p>Hel</p><input id="in" value="fieldtext">')
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    const control = snapshot.nodes.find((n) => n.text === 'fieldtext')!
    const input = document.querySelector('#in') as HTMLElement
    // an all-zero rect: the piece is connected but nothing renders there
    input.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 }) as DOMRect
    send({
      type: 'gx:findMark',
      matches: [[{ id: control.id, start: 0, end: 9 }]],
      active: 0,
      scroll: false,
    })
    // the pool box exists but hides: no 2x2 sliver at the page corner
    expect(overlayBoxes()).toHaveLength(1)
    expect(overlayBoxes()[0]!.style.display).toBe('none')
  })

  it('range rects arrive as a real DOMRectList: array methods must not be called on it', async () => {
    await setBody('<p id="a">needle</p>')
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    // the shape real engines return: iterable, length/item/indexed — but NO
    // .find/.map (jsdom stubs usually hand back plain arrays, which is why
    // this class hides from the suite)
    const r = { left: 10, top: 300, width: 30, height: 12 }
    const list = {
      0: r,
      length: 1,
      item: (i: number) => (i === 0 ? r : null),
      [Symbol.iterator]: function* () {
        yield r
      },
    }
    Range.prototype.getClientRects = () => list as unknown as DOMRectList
    send({
      type: 'gx:findMark',
      matches: [[{ id: snapshot.nodes[0]!.id, start: 0, end: 6 }]],
      active: 0,
      scroll: true,
    })
    // painting uses length/indexed access; the scroll picks the first usable
    // rect with .find — only the Array.from conversion in pieceRects keeps
    // both working against a genuine DOMRectList
    expect(overlayBoxes()).toHaveLength(1)
    expect(overlayBoxes()[0]!.style.display).toBe('block')
    expect(window.scrollTo).toHaveBeenCalled()
  })

  it('the window target is re-measured after the container scroll, not before it', async () => {
    await setBody('<div id="scroller" style="overflow:auto"><p id="deep">needle</p></div>')
    const scroller = document.getElementById('scroller')!
    // browser-like coupling: scrolling the container moves the needle up the
    // viewport by the same amount (jsdom has neither layout nor scroll)
    let rectTop = 500
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => 0,
      set: (v: number) => {
        rectTop -= v
      },
      configurable: true,
    })
    Range.prototype.getClientRects = () =>
      [{ left: 10, top: rectTop, width: 30, height: 12 }] as DOMRectList
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    const deep = snapshot.nodes.find((n) => n.text === 'needle')!
    send({
      type: 'gx:findMark',
      matches: [[{ id: deep.id, start: 0, end: 6 }]],
      active: 0,
      scroll: true,
    })
    // the container scrolled 400: the needle now sits at viewport 100, already
    // visible. The window target must reflect that (scrollTo 0). A target
    // captured BEFORE the container scroll would aim at 500 - innerHeight/3
    // and dump the reader ~244px past the match
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0)
  })

  it('only the FIRST summary of a closed details renders; later siblings stay hidden', async () => {
    await setBody('<div>a<details><summary>A</summary><summary>Bee</summary></details>b</div>')
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    // the engine renders only the first summary child of a closed details: a
    // later summary is ordinary hidden content — a reported-but-invisible
    // "Bee" match would paint nothing and scroll nowhere
    expect(snapshot.nodes.map((n) => n.text)).toEqual(['a', 'A', 'b'])
    expect(snapshot.nodes.map((n) => n.sep)).toEqual([undefined, '\n', '\n'])
  })

  it('dropdown options (display:block in real engines, popup-owned layout) break no line', async () => {
    // real engines compute display:block for option; jsdom says inline — the
    // inline style emulates the real computed value so the guard is exercised
    await setBody(
      '<div>a<select style="visibility:hidden">' +
        '<option style="display:block" selected>o</option></select> b</div>',
    )
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    // the hidden select is not mirrored, and its popup options draw nothing
    // in the page flow: "a b" reads flush on one line and stays findable
    expect(snapshot.nodes.map((n) => n.text)).toEqual(['a', ' b'])
    expect(snapshot.nodes.every((n) => n.sep === undefined)).toBe(true)
  })

  it('a <br> inside a hidden-visibility subtree still breaks the rendered line', async () => {
    await setBody('<div>a<span style="visibility:hidden">x<br>y</span>b</div>')
    send({ type: 'gx:setDocText', on: true })
    const snapshot = (await waitForPosted('gx:docText')) as unknown as DocTextMsg
    // the hidden run's text is not mirrored, but its <br> still forces the
    // line break the reader sees: 'a' and 'b' sit on different lines, so the
    // mirror must not glue them into one word
    expect(snapshot.nodes.map((n) => n.text)).toEqual(['a', 'b'])
    expect(snapshot.nodes.map((n) => n.sep)).toEqual([undefined, '\n'])
  })
})
