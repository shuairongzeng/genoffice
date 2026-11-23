import type { WebContents } from 'electron'
import type { TabKind } from '../shared/tabs-api'

export const SPLIT_SCROLL_MSG_PREFIX = '__GENOFFICE_SPLIT_SCROLL__:'

export interface ScrollSyncOptions {
  /** Suppression cooldown applied to the follower after a forwarded scroll (ms). */
  cooldownMs?: number
  /** Minimum ratio delta required before forwarding another scroll update. */
  epsilon?: number
  /** Minimum reverse delta inside the cooldown window required to preempt leadership. */
  takeoverDelta?: number
}

export interface ScrollBindingIds {
  enabled: boolean
  leftWcId: number | null
  rightWcId: number | null
}

export interface ScrollSyncDispatch {
  targetWcId: number
  ratio: number
}

export interface SuppressionWindow {
  ratio: number
  untilMs: number
}

export interface ScrollSyncState {
  enabled: boolean
  leftWcId: number | null
  rightWcId: number | null
  suppressed: ReadonlyMap<number, SuppressionWindow>
  lastForwardedRatio: ReadonlyMap<number, number>
}

export interface SplitScrollPaneTarget {
  tabId: string
  kind: TabKind
  webContents: WebContents
}

export interface SplitScrollSyncBinding {
  enabled: boolean
  left?: SplitScrollPaneTarget | null
  right?: SplitScrollPaneTarget | null
}

export interface SplitScrollSyncControllerOptions {
  /** Resolves the scrollable WebContents for a pane (e.g. browser chrome -> page WebContents). */
  resolveScrollWebContents?: (
    tabId: string,
    kind: TabKind,
    defaultWc: WebContents,
  ) => WebContents | undefined
  coordinatorOptions?: ScrollSyncOptions
}

interface BoundViewEntry {
  wc: WebContents
  onConsoleMessage: (...args: unknown[]) => void
  onDidFinishLoad: () => void
}

const DEFAULT_COOLDOWN_MS = 120
const DEFAULT_EPSILON = 0.0005
const DEFAULT_TAKEOVER_DELTA = 0.025

function clampRatio(value: number): number {
  const clamped = Math.min(1, Math.max(0, value))
  return clamped === 0 ? 0 : clamped
}

function resolveNonNegativeOption(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Pure state machine coordinating bidirectional scroll sync across two views
 * while suppressing mirror echoes and micro-jitter.
 */
export class ScrollSyncCoordinator {
  private readonly cooldownMs: number
  private readonly epsilon: number
  private readonly takeoverDelta: number
  private binding: ScrollBindingIds = {
    enabled: false,
    leftWcId: null,
    rightWcId: null,
  }
  private readonly suppressed = new Map<number, SuppressionWindow>()
  private readonly lastForwardedRatio = new Map<number, number>()

  constructor(options: ScrollSyncOptions = {}) {
    this.cooldownMs = resolveNonNegativeOption(options.cooldownMs, DEFAULT_COOLDOWN_MS)
    this.epsilon = resolveNonNegativeOption(options.epsilon, DEFAULT_EPSILON)
    this.takeoverDelta = resolveNonNegativeOption(options.takeoverDelta, DEFAULT_TAKEOVER_DELTA)
  }

  /** Updates the bound pane IDs and resets transient suppression state when they change. */
  configure(binding: ScrollBindingIds): void {
    const changed =
      this.binding.enabled !== binding.enabled ||
      this.binding.leftWcId !== binding.leftWcId ||
      this.binding.rightWcId !== binding.rightWcId
    if (!changed) return

    this.binding = {
      enabled: binding.enabled,
      leftWcId: binding.leftWcId,
      rightWcId: binding.rightWcId,
    }
    this.reset()
  }

  /** Clears active suppression windows and cached forwarded ratios. */
  reset(): void {
    this.suppressed.clear()
    this.lastForwardedRatio.clear()
  }

  /** Returns a read-only snapshot of coordinator configuration and transient state. */
  getState(): ScrollSyncState {
    const suppressedSnapshot = new Map<number, SuppressionWindow>()
    for (const [wcId, entry] of this.suppressed.entries()) {
      suppressedSnapshot.set(wcId, { ...entry })
    }
    return {
      enabled: this.binding.enabled,
      leftWcId: this.binding.leftWcId,
      rightWcId: this.binding.rightWcId,
      suppressed: suppressedSnapshot,
      lastForwardedRatio: new Map(this.lastForwardedRatio),
    }
  }

  /**
   * Evaluates a normalized scroll report from one pane and returns the target
   * dispatch if it should be forwarded to the opposite pane.
   */
  handleReport(fromWcId: number, rawRatio: number, nowMs = Date.now()): ScrollSyncDispatch | null {
    const { enabled, leftWcId, rightWcId } = this.binding
    if (
      !enabled ||
      !Number.isFinite(rawRatio) ||
      !Number.isFinite(nowMs) ||
      leftWcId === null ||
      rightWcId === null ||
      leftWcId === rightWcId
    ) {
      return null
    }

    let targetWcId: number
    if (fromWcId === leftWcId) {
      targetWcId = rightWcId
    } else if (fromWcId === rightWcId) {
      targetWcId = leftWcId
    } else {
      return null
    }

    const ratio = clampRatio(rawRatio)

    const suppressed = this.suppressed.get(fromWcId)
    if (suppressed !== undefined) {
      if (nowMs <= suppressed.untilMs) {
        if (Math.abs(ratio - suppressed.ratio) < this.takeoverDelta) {
          return null
        }
      } else {
        this.suppressed.delete(fromWcId)
      }
    }

    const lastRatio = this.lastForwardedRatio.get(targetWcId)
    if (lastRatio !== undefined && Math.abs(ratio - lastRatio) < this.epsilon) {
      return null
    }

    // Clear stale echo/position tracking on the new leader before arming the follower's window.
    this.suppressed.delete(fromWcId)
    this.lastForwardedRatio.delete(fromWcId)
    this.suppressed.set(targetWcId, {
      ratio,
      untilMs: nowMs + this.cooldownMs,
    })
    this.lastForwardedRatio.set(targetWcId, ratio)

    return { targetWcId, ratio }
  }
}

/**
 * Extracts the console message string from either Electron's newer object-event
 * signature (`(details)`) or legacy positional tuple signature (`(event, level, message, ...)`).
 */
export function parseSplitScrollConsoleMessage(args: readonly unknown[]): string | null {
  if (args.length === 0) return null

  const first = args[0]
  if (
    typeof first === 'object' &&
    first !== null &&
    'message' in first &&
    typeof (first as { message?: unknown }).message === 'string'
  ) {
    return (first as { message: string }).message
  }

  if (typeof args[2] === 'string') {
    return args[2]
  }

  return null
}

/** Parses and clamps a scroll ratio payload carrying `SPLIT_SCROLL_MSG_PREFIX`. */
export function parseScrollRatioMessage(message: string): number | null {
  if (typeof message !== 'string' || !message.startsWith(SPLIT_SCROLL_MSG_PREFIX)) {
    return null
  }

  const raw = message.slice(SPLIT_SCROLL_MSG_PREFIX.length).trim()
  if (raw.length === 0) return null

  const value = Number(raw)
  if (!Number.isFinite(value)) return null

  return clampRatio(value)
}

/**
 * Builds the self-contained, idempotent renderer script that detects the primary
 * vertical scroller, reports user-initiated scroll ratios, and applies peer updates.
 */
export function buildScrollBridgeScript(enabled: boolean): string {
  const initialFlag = enabled ? 'true' : 'false'
  return `(function (initialActive) {
  var KEY = '__genofficeScrollSync';
  var PREFIX = '${SPLIT_SCROLL_MSG_PREFIX}';
  var existing = window[KEY];
  if (existing && typeof existing.setActive === 'function') {
    existing.setActive(Boolean(initialActive));
    return;
  }

  var active = Boolean(initialActive);
  var suppressUntil = 0;
  var lastUserGestureAt = -Infinity;
  var rafId = 0;

  var PRIORITY_SELECTORS = [
    '.editor-scroll',
    '.cm-scroller',
    '[data-scroll-container]',
    '.compare-body',
    '.pdf-viewer',
    'main'
  ];

  function isScrollableCandidate(el) {
    if (!el) return false;
    if (typeof el.clientHeight !== 'number' || typeof el.scrollHeight !== 'number') return false;
    return el.clientHeight > 0 && (el.scrollHeight - el.clientHeight) > 16;
  }

  function findPrimaryScroller() {
    var best = null;
    var bestRange = 0;

    for (var i = 0; i < PRIORITY_SELECTORS.length; i++) {
      var matched = document.querySelectorAll(PRIORITY_SELECTORS[i]);
      for (var j = 0; j < matched.length; j++) {
        var candidate = matched[j];
        if (!isScrollableCandidate(candidate)) continue;
        var range = candidate.scrollHeight - candidate.clientHeight;
        if (range > bestRange) {
          bestRange = range;
          best = candidate;
        }
      }
    }

    var docScroller = document.scrollingElement;
    if (isScrollableCandidate(docScroller)) {
      var docRange = docScroller.scrollHeight - docScroller.clientHeight;
      if (docRange > bestRange) {
        bestRange = docRange;
        best = docScroller;
      }
    }

    if (best) return best;

    var fallbackNodes = document.querySelectorAll('div, section, main');
    var visibleCount = 0;
    for (var k = 0; k < fallbackNodes.length && visibleCount < 150; k++) {
      var el = fallbackNodes[k];
      if (!el || typeof el.clientHeight !== 'number' || el.clientHeight <= 0) continue;
      visibleCount++;
      var fallbackRange = el.scrollHeight - el.clientHeight;
      if (fallbackRange <= 16) continue;
      var style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(el) : null;
      var overflowY = style ? style.overflowY : '';
      if (overflowY === 'auto' || overflowY === 'scroll') {
        if (fallbackRange > bestRange) {
          bestRange = fallbackRange;
          best = el;
        }
      }
    }

    return best;
  }

  function markUserGesture() {
    lastUserGestureAt = performance.now();
  }

  function cancelPendingFrame() {
    if (rafId !== 0) {
      if (typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(rafId);
      }
      rafId = 0;
    }
  }

  function emitCurrentRatio() {
    rafId = 0;
    if (!active) return;
    var now = performance.now();
    if (now <= suppressUntil) return;
    if (now - lastUserGestureAt >= 1000) return;

    var el = findPrimaryScroller();
    if (!el) return;
    var maxScroll = el.scrollHeight - el.clientHeight;
    if (maxScroll <= 0) return;

    var ratio = el.scrollTop / maxScroll;
    if (!Number.isFinite(ratio)) return;
    if (ratio < 0) ratio = 0;
    if (ratio > 1) ratio = 1;
    console.debug(PREFIX + ratio.toFixed(6));
  }

  function onScroll() {
    if (!active) return;
    var now = performance.now();
    if (now <= suppressUntil) return;
    if (now - lastUserGestureAt >= 1000) return;
    if (rafId !== 0) return;

    if (typeof window.requestAnimationFrame === 'function') {
      rafId = window.requestAnimationFrame(emitCurrentRatio);
    } else {
      rafId = 1;
      emitCurrentRatio();
    }
  }

  function applyRatio(ratio) {
    var numeric = Number(ratio);
    if (!Number.isFinite(numeric)) return;
    if (numeric < 0) numeric = 0;
    if (numeric > 1) numeric = 1;

    suppressUntil = performance.now() + 150;
    cancelPendingFrame();

    var el = findPrimaryScroller();
    if (el && el.scrollHeight > el.clientHeight) {
      el.scrollTop = numeric * (el.scrollHeight - el.clientHeight);
    }

    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      try {
        var frame = iframes[i];
        var cw = frame && frame.contentWindow;
        if (cw && typeof cw.postMessage === 'function') {
          cw.postMessage({ type: 'gx:scrollTo', ratio: numeric }, '*');
        }
      } catch (_err) {}
    }
  }

  function setActive(flag) {
    active = Boolean(flag);
    if (!active) {
      cancelPendingFrame();
    }
  }

  var gestureEvents = ['wheel', 'pointerdown', 'touchstart', 'keydown'];
  for (var g = 0; g < gestureEvents.length; g++) {
    document.addEventListener(gestureEvents[g], markUserGesture, true);
  }
  document.addEventListener('scroll', onScroll, true);

  window[KEY] = {
    applyRatio: applyRatio,
    setActive: setActive,
    findPrimaryScroller: findPrimaryScroller
  };
})(${initialFlag});`
}

/**
 * Manages Electron WebContents listener bindings, bridge injection, and
 * main-process scroll forwarding for a split-pane pair.
 */
export class SplitScrollSyncController {
  private readonly coordinator: ScrollSyncCoordinator
  private readonly resolveScrollWebContents?: SplitScrollSyncControllerOptions['resolveScrollWebContents']
  private readonly boundViews = new Map<number, BoundViewEntry>()
  private disposed = false

  constructor(options: SplitScrollSyncControllerOptions = {}) {
    this.resolveScrollWebContents = options.resolveScrollWebContents
    this.coordinator = new ScrollSyncCoordinator(options.coordinatorOptions)
  }

  /** Synchronizes listener bindings and bridge state with the latest split-pane pairing. */
  sync(binding: SplitScrollSyncBinding | null): void {
    if (this.disposed) return

    const leftWc = binding?.enabled ? this.resolvePaneWebContents(binding.left) : null
    const rightWc = binding?.enabled ? this.resolvePaneWebContents(binding.right) : null

    const pairValid =
      Boolean(binding?.enabled) &&
      leftWc !== null &&
      rightWc !== null &&
      leftWc !== rightWc &&
      leftWc.id !== rightWc.id

    const nextTargets = new Map<number, WebContents>()
    if (pairValid && leftWc && rightWc) {
      nextTargets.set(leftWc.id, leftWc)
      nextTargets.set(rightWc.id, rightWc)
    }

    for (const [wcId, entry] of this.boundViews.entries()) {
      if (nextTargets.get(wcId) !== entry.wc) {
        this.unbindEntry(entry)
        this.boundViews.delete(wcId)
      }
    }

    if (pairValid && leftWc && rightWc) {
      this.ensureBound(leftWc)
      this.ensureBound(rightWc)
      this.coordinator.configure({
        enabled: true,
        leftWcId: leftWc.id,
        rightWcId: rightWc.id,
      })
    } else {
      this.coordinator.configure({
        enabled: false,
        leftWcId: null,
        rightWcId: null,
      })
    }
  }

  /** Returns a read-only snapshot of the underlying coordinator state. */
  getState(): ScrollSyncState {
    return this.coordinator.getState()
  }

  /** Unbinds all attached WebContents listeners and disables scroll sync permanently. */
  dispose(): void {
    this.disposed = true
    for (const entry of this.boundViews.values()) {
      this.unbindEntry(entry)
    }
    this.boundViews.clear()
    this.coordinator.configure({
      enabled: false,
      leftWcId: null,
      rightWcId: null,
    })
  }

  private resolvePaneWebContents(
    pane: SplitScrollPaneTarget | null | undefined,
  ): WebContents | null {
    if (!pane) return null
    const resolved = this.resolveScrollWebContents
      ? this.resolveScrollWebContents(pane.tabId, pane.kind, pane.webContents)
      : pane.webContents
    if (!resolved || this.isWcDestroyed(resolved)) {
      return null
    }
    return resolved
  }

  private ensureBound(wc: WebContents): void {
    if (this.isWcDestroyed(wc)) return
    const existing = this.boundViews.get(wc.id)
    if (existing && existing.wc === wc) return

    const onConsoleMessage = (...args: unknown[]): void => {
      if (this.disposed || this.isWcDestroyed(wc)) return
      const message = parseSplitScrollConsoleMessage(args)
      if (message === null) return
      const ratio = parseScrollRatioMessage(message)
      if (ratio === null) return

      const dispatch = this.coordinator.handleReport(wc.id, ratio)
      if (!dispatch) return

      const target = this.boundViews.get(dispatch.targetWcId)
      if (!target || this.isWcDestroyed(target.wc)) return

      const applyScript = `try { if (window.__genofficeScrollSync && typeof window.__genofficeScrollSync.applyRatio === "function") window.__genofficeScrollSync.applyRatio(${dispatch.ratio}); } catch (_err) {}`
      this.safeExecuteJavaScript(target.wc, applyScript)
    }

    const onDidFinishLoad = (): void => {
      if (this.disposed || this.isWcDestroyed(wc)) return
      if (this.boundViews.get(wc.id)?.wc !== wc) return
      this.safeExecuteJavaScript(wc, buildScrollBridgeScript(true))
    }

    wc.on('console-message', onConsoleMessage as (...args: any[]) => void)
    wc.on('did-finish-load', onDidFinishLoad)

    this.boundViews.set(wc.id, { wc, onConsoleMessage, onDidFinishLoad })
    this.safeExecuteJavaScript(wc, buildScrollBridgeScript(true))
  }

  private unbindEntry(entry: BoundViewEntry): void {
    if (this.isWcDestroyed(entry.wc)) return
    this.detachListener(entry.wc, 'console-message', entry.onConsoleMessage)
    this.detachListener(entry.wc, 'did-finish-load', entry.onDidFinishLoad)

    const deactivateScript =
      'try { if (window.__genofficeScrollSync && typeof window.__genofficeScrollSync.setActive === "function") window.__genofficeScrollSync.setActive(false); } catch (_err) {}'
    this.safeExecuteJavaScript(entry.wc, deactivateScript)
  }

  private detachListener(
    wc: WebContents,
    event: 'console-message' | 'did-finish-load',
    listener: (...args: unknown[]) => void,
  ): void {
    try {
      const emitter = wc as unknown as {
        removeListener?: (eventName: string, fn: (...args: unknown[]) => void) => unknown
        off?: (eventName: string, fn: (...args: unknown[]) => void) => unknown
      }
      if (typeof emitter.removeListener === 'function') {
        emitter.removeListener(event, listener)
      } else if (typeof emitter.off === 'function') {
        emitter.off(event, listener)
      }
    } catch {
      // Ignore listener teardown errors on closing WebContents.
    }
  }

  private safeExecuteJavaScript(wc: WebContents, code: string): void {
    if (this.isWcDestroyed(wc)) return
    try {
      const pending = wc.executeJavaScript(code)
      if (pending && typeof (pending as Promise<unknown>).catch === 'function') {
        void (pending as Promise<unknown>).catch(() => {})
      }
    } catch {
      // Ignore synchronous executeJavaScript failures when WebContents closes mid-call.
    }
  }

  private isWcDestroyed(wc: WebContents | null | undefined): boolean {
    if (!wc) return true
    try {
      return typeof wc.isDestroyed === 'function' ? wc.isDestroyed() : false
    } catch {
      return true
    }
  }
}
