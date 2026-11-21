import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react'
import type {
  MediaAudioMetadata,
  MediaFolderEntry,
  MediaInfo,
  MediaPlayMode,
  MediaPlayerPrefs,
  MediaPlayerStateSnapshot,
  MediaPlaylistItem,
  MediaSavePrefsPatch,
  MediaSnapshotReply,
  MediaSnapshotRequest,
  MediaStateMutationResult,
  MediaSubtitleTrack,
  MediaVisualizerMode,
} from '../../shared/home-api'
import { useI18n } from './locale'
import { getMediaPlayerStrings, playModeLabel } from './media-player-strings'
import {
  MIRROR_BAR_COUNT,
  VINYL_HALO_BAR_COUNT,
  computeLogSpectrum,
  deriveTrackPalette,
  extractPaletteFromImage,
  findActiveLyricIndex,
  normalizeVisualizerMode,
  renderFluidWave,
  renderMirrorBars,
  renderVinylHalo,
  updatePeakCaps,
  type AudioStagePalette,
} from './audio-visualizer'
import {
  SPEED_PRESETS,
  buildShuffleOrder,
  filterPlaylistItems,
  nextPlayMode,
  resolveNextTrackIndex,
  resolvePrevTrackIndex,
  stepPlaybackSpeed,
} from './media-playlist-engine'
import './media-viewer.css'

const MAX_AI_EDGE_PX = 1600
const MAX_PNG_BASE64_BYTES = 2_400_000
const MIN_ZOOM = 0.1
const MAX_ZOOM = 8
const POSITION_SAVE_INTERVAL_MS = 4000
const CONTROLS_IDLE_MS = 2500

const DEFAULT_PREFS: MediaPlayerPrefs = {
  playMode: 'list',
  volume: 1,
  muted: false,
  playbackRate: 1,
  playlistCollapsed: false,
  autoPlay: true,
  visualizerMode: 'vinyl',
}

function detectIsDarkTheme(): boolean {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-theme')
    if (attr === 'dark') return true
    if (attr === 'light') return false
  }
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false
}

function inferTrackLabelFallback(fileName: string): { title: string; artist?: string } {
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const cleaned = stem.replace(/^\s*\d{1,3}\s*(?:\.|-|_|\s)\s*/, '').trim() || stem
  const sep = /^(.+?)\s+[-–—]\s+(.+?)$/.exec(cleaned)
  if (sep) {
    return { title: sep[1]!.trim(), artist: sep[2]!.trim() }
  }
  return { title: cleaned }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const whole = Math.floor(sec)
  const hrs = Math.floor(whole / 3600)
  const mins = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${mins}:${String(secs).padStart(2, '0')}`
}

function canvasToBase64(
  canvas: HTMLCanvasElement,
  mime: 'image/png' | 'image/jpeg',
  quality?: number,
): { base64: string; mime: string } | null {
  const dataUrl =
    quality !== undefined ? canvas.toDataURL(mime, quality) : canvas.toDataURL(mime)
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  return { base64: dataUrl.slice(comma + 1), mime }
}

function renderElementToCanvas(
  source: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
): HTMLCanvasElement {
  const longEdge = Math.max(srcWidth, srcHeight, 1)
  const scale = longEdge > MAX_AI_EDGE_PX ? MAX_AI_EDGE_PX / longEdge : 1
  const outW = Math.max(1, Math.round(srcWidth * scale))
  const outH = Math.max(1, Math.round(srcHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context is unavailable')
  ctx.drawImage(source, 0, 0, outW, outH)
  return canvas
}

async function waitForImageReady(img: HTMLImageElement, timeoutMs = 5000): Promise<void> {
  if (img.complete) {
    if (img.naturalWidth > 0) return
    throw new Error('Image failed to load')
  }
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('Timed out loading image'))
    }, timeoutMs)
    const onLoad = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => {
      cleanup()
      reject(new Error('Image failed to decode'))
    }
    const cleanup = (): void => {
      window.clearTimeout(timer)
      img.removeEventListener('load', onLoad)
      img.removeEventListener('error', onError)
    }
    img.addEventListener('load', onLoad, { once: true })
    img.addEventListener('error', onError, { once: true })
  })
}

async function waitForMediaReady(
  el: HTMLMediaElement,
  minReadyState: number,
  timeoutMs = 5000,
): Promise<void> {
  if (el.error) throw new Error('Media playback failed due to an unsupported codec or invalid file')
  if (el.readyState >= minReadyState) return
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for media metadata'))
    }, timeoutMs)
    const onReady = (): void => {
      if (el.readyState >= minReadyState) {
        cleanup()
        resolve()
      }
    }
    const onError = (): void => {
      cleanup()
      reject(new Error('Media failed to decode'))
    }
    const cleanup = (): void => {
      window.clearTimeout(timer)
      el.removeEventListener('loadedmetadata', onReady)
      el.removeEventListener('loadeddata', onReady)
      el.removeEventListener('canplay', onReady)
      el.removeEventListener('error', onError)
    }
    el.addEventListener('loadedmetadata', onReady)
    el.addEventListener('loadeddata', onReady)
    el.addEventListener('canplay', onReady)
    el.addEventListener('error', onError, { once: true })
  })
}

async function seekVideoTo(
  video: HTMLVideoElement,
  timestampSec: number,
  timeoutMs = 4000,
): Promise<void> {
  await waitForMediaReady(video, 1, timeoutMs)
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0
  const maxTarget = duration > 0.05 ? duration - 0.05 : duration
  const target = duration > 0 ? Math.max(0, Math.min(timestampSec, maxTarget)) : timestampSec
  if (Math.abs(video.currentTime - target) < 0.04 && video.readyState >= 2) return
  await new Promise<void>((resolve) => {
    const timer = window.setTimeout(() => {
      cleanup()
      resolve()
    }, timeoutMs)
    const onSeeked = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => {
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      window.clearTimeout(timer)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
    }
    video.addEventListener('seeked', onSeeked, { once: true })
    video.addEventListener('error', onError, { once: true })
    video.currentTime = target
  })
  await waitForMediaReady(video, 2, 2000).catch(() => undefined)
}

function encodeNormalizedImage(
  img: HTMLImageElement,
  ext: string,
): { base64: string; mime: string } | null {
  const natW = Math.max(img.naturalWidth || img.width || 800, 1)
  const natH = Math.max(img.naturalHeight || img.height || 600, 1)
  const canvas = renderElementToCanvas(img, natW, natH)
  const preferPng = ['png', 'svg', 'webp', 'gif', 'ico'].includes(ext)
  if (preferPng) {
    const png = canvasToBase64(canvas, 'image/png')
    if (png && png.base64.length <= MAX_PNG_BASE64_BYTES) return png
  }
  return canvasToBase64(canvas, 'image/jpeg', 0.88)
}

function replaceUrlToken(token: string | undefined): void {
  try {
    const url = new URL(window.location.href)
    if (token) url.searchParams.set('token', token)
    else url.searchParams.delete('token')
    window.history.replaceState(null, '', url.toString())
  } catch {
    // Ignore history errors in test environments.
  }
}

function sameDir(a: string, b: string): boolean {
  const isWin = typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent)
  return isWin ? a.toLowerCase() === b.toLowerCase() : a === b
}

function sameFile(a: string, b: string): boolean {
  const isWin = typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent)
  return isWin ? a.toLowerCase() === b.toLowerCase() : a === b
}

function extractDroppedPaths(files: FileList): string[] {
  const out: string[] = []
  for (let i = 0; i < files.length; i += 1) {
    const file = files.item(i)
    if (!file) continue
    let resolved = ''
    try {
      resolved = window.aiOffice?.pathForFile?.(file) ?? ''
    } catch {
      resolved = ''
    }
    const legacyPath = (file as unknown as { path?: unknown }).path
    if (!resolved && typeof legacyPath === 'string') {
      resolved = legacyPath
    }
    if (resolved) out.push(resolved)
  }
  return out
}

function ensureSharedAudioGraph(
  ctxRef: React.MutableRefObject<AudioContext | null>,
  analyserRef: React.MutableRefObject<AnalyserNode | null>,
): { ctx: AudioContext; analyser: AnalyserNode } | null {
  if (typeof AudioContext === 'undefined') return null
  try {
    let ctx = ctxRef.current
    if (!ctx || ctx.state === 'closed') {
      ctx = new AudioContext()
      ctxRef.current = ctx
      analyserRef.current = null
    }
    let analyser = analyserRef.current
    if (!analyser) {
      analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.8
      analyser.connect(ctx.destination)
      analyserRef.current = analyser
    }
    return { ctx, analyser }
  } catch {
    return null
  }
}

export interface MediaPlaybackReport {
  readonly playing: boolean
  readonly title: string
  readonly artist?: string
  readonly mediaKind?: MediaInfo['mediaKind']
  readonly filePath?: string
  readonly coverUrl?: string
  readonly hasPrev: boolean
  readonly hasNext: boolean
}

export interface MediaExternalLoadRequest {
  readonly seq: number
  readonly token?: string
  readonly filePath?: string
}

export interface MediaExternalCommand {
  readonly seq: number
  readonly type: 'toggle-play' | 'next' | 'prev' | 'pause'
}

export interface MediaViewerProps {
  readonly embedded?: boolean
  readonly keyboardActive?: boolean
  readonly visualHidden?: boolean
  readonly compactMini?: boolean
  readonly externalLoadRequest?: MediaExternalLoadRequest | null
  readonly externalCommand?: MediaExternalCommand | null
  readonly onPlaybackReport?: (report: MediaPlaybackReport) => void
  readonly onExpandFromMini?: () => void
  readonly onMinimizeFromMini?: () => void
  readonly onCloseFromMini?: () => void
}

export function MediaViewer(props: MediaViewerProps = {}): React.JSX.Element {
  const {
    embedded = false,
    keyboardActive = true,
    visualHidden = false,
    compactMini = false,
    externalLoadRequest = null,
    externalCommand = null,
    onPlaybackReport,
    onExpandFromMini,
    onMinimizeFromMini,
    onCloseFromMini,
  } = props
  const { lang, t } = useI18n()
  const ps = getMediaPlayerStrings(lang)

  const [info, setInfo] = useState<MediaInfo | null>(null)
  const [playerMode, setPlayerMode] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  // Playlist & persisted library state
  const [items, setItems] = useState<MediaPlaylistItem[]>([])
  const [folders, setFolders] = useState<MediaFolderEntry[]>([])
  const [subtitles, setSubtitles] = useState<MediaSubtitleTrack[]>([])
  const [selectedSubId, setSelectedSubId] = useState<string | null>(null)
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true)
  const [folderFilter, setFolderFilter] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [dropActive, setDropActive] = useState(false)

  // Image viewport state
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null)
  const [fitMode, setFitMode] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [checkerboard, setCheckerboard] = useState(false)

  // Audio / video playback state
  const [playing, setPlaying] = useState(false)
  const [audioGraphTick, setAudioGraphTick] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [bufferedEnd, setBufferedEnd] = useState(0)
  const [hoverSeek, setHoverSeek] = useState<{ pct: number; sec: number } | null>(null)
  const [playbackRate, setPlaybackRate] = useState(DEFAULT_PREFS.playbackRate)
  const [volume, setVolume] = useState(DEFAULT_PREFS.volume)
  const [muted, setMuted] = useState(DEFAULT_PREFS.muted)
  const [playMode, setPlayMode] = useState<MediaPlayMode>(DEFAULT_PREFS.playMode)
  const [playlistCollapsed, setPlaylistCollapsed] = useState(DEFAULT_PREFS.playlistCollapsed)
  const [autoPlay, setAutoPlay] = useState(DEFAULT_PREFS.autoPlay)
  const [visualizerMode, setVisualizerMode] = useState<MediaVisualizerMode>(
    normalizeVisualizerMode(DEFAULT_PREFS.visualizerMode),
  )
  const [audioMeta, setAudioMeta] = useState<MediaAudioMetadata | undefined>(undefined)
  const [lyricsOpen, setLyricsOpen] = useState(true)
  const [isDarkTheme, setIsDarkTheme] = useState<boolean>(() => detectIsDarkTheme())
  const [coverPalette, setCoverPalette] = useState<AudioStagePalette | null>(null)
  const [videoDims, setVideoDims] = useState<{ w: number; h: number } | null>(null)
  const [captureNotice, setCaptureNotice] = useState(false)
  const [resumedNoticeSec, setResumedNoticeSec] = useState<number | null>(null)
  const [controlsIdle, setControlsIdle] = useState(false)

  const imgRef = useRef<HTMLImageElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioStageRef = useRef<HTMLElement | null>(null)
  const activeLyricRef = useRef<HTMLButtonElement | null>(null)
  const spectrumCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const sharedAudioCtxRef = useRef<AudioContext | null>(null)
  const sharedAnalyserRef = useRef<AnalyserNode | null>(null)
  const connectedSourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const connectedAudioElRef = useRef<HTMLAudioElement | null>(null)
  const vizBarsRef = useRef<Float32Array>(new Float32Array(VINYL_HALO_BAR_COUNT))
  const vizPeaksRef = useRef<Float32Array>(new Float32Array(VINYL_HALO_BAR_COUNT))
  const vizVelRef = useRef<Float32Array>(new Float32Array(VINYL_HALO_BAR_COUNT))
  const vizPhaseRef = useRef(0)
  const bassSmoothRef = useRef(0)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const activeItemRef = useRef<HTMLButtonElement | null>(null)
  const dragOriginRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const handledRequestsRef = useRef<Set<string>>(new Set())
  const keyDownHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {})
  const embeddedRef = useRef(embedded)
  embeddedRef.current = embedded
  const keyboardActiveRef = useRef(keyboardActive)
  keyboardActiveRef.current = keyboardActive
  const externalLoadRequestRef = useRef(externalLoadRequest)
  externalLoadRequestRef.current = externalLoadRequest
  const handledExternalLoadSeqRef = useRef(externalLoadRequest?.seq ?? 0)
  const handledExternalCommandSeqRef = useRef(externalCommand?.seq ?? 0)
  const mountedRef = useRef(false)

  const infoRef = useRef(info)
  infoRef.current = info
  const loadErrorRef = useRef(loadError)
  loadErrorRef.current = loadError
  const playerModeRef = useRef(playerMode)
  playerModeRef.current = playerMode
  const playModeRef = useRef(playMode)
  playModeRef.current = playMode
  const shuffleOrderRef = useRef<number[]>([])
  const switchSeqRef = useRef(0)
  const shouldAutoPlayRef = useRef(true)
  const pendingResumeSecRef = useRef(0)
  const lastPositionSaveAtRef = useRef(0)
  const idleTimerRef = useRef<number | null>(null)
  const wasPlayingBeforeDblClickRef = useRef<boolean | null>(null)

  const persistPrefs = useCallback((patch: MediaSavePrefsPatch): void => {
    void window.aiOffice?.mediaSavePrefs?.(patch)?.catch(() => undefined)
  }, [])

  const applyPlayerSnapshot = useCallback(
    (snapshot: MediaPlayerStateSnapshot, autoPlayNext: boolean): void => {
      setInfo(snapshot.current)
      setPlayerMode(snapshot.playerMode)
      setItems(snapshot.items)
      setFolders(snapshot.folders)
      setSubtitles(snapshot.subtitles)
      setSelectedSubId(snapshot.subtitles[0]?.id ?? null)
      setPlayMode(snapshot.prefs.playMode)
      setVolume(snapshot.prefs.volume)
      setMuted(snapshot.prefs.muted)
      setPlaybackRate(snapshot.prefs.playbackRate)
      setPlaylistCollapsed(snapshot.prefs.playlistCollapsed)
      setAutoPlay(snapshot.prefs.autoPlay)
      setVisualizerMode(normalizeVisualizerMode(snapshot.prefs.visualizerMode))
      setAudioMeta(snapshot.audioMeta)
      setCoverPalette(null)
      setLoadError(false)
      setCurrentTime(0)
      setDuration(0)
      setBufferedEnd(0)
      setVideoDims(null)
      setPlaying(false)
      shouldAutoPlayRef.current = autoPlayNext && snapshot.prefs.autoPlay
      pendingResumeSecRef.current = snapshot.resumePositionSec > 0 ? snapshot.resumePositionSec : 0
      setResumedNoticeSec(snapshot.resumePositionSec >= 5 ? snapshot.resumePositionSec : null)
      if (!embeddedRef.current) replaceUrlToken(snapshot.current?.token)

      const curIndex = snapshot.current
        ? snapshot.items.findIndex((item) => sameFile(item.filePath, snapshot.current!.filePath))
        : -1
      shuffleOrderRef.current = buildShuffleOrder(snapshot.items.length, curIndex)
    },
    [],
  )

  useEffect(() => {
    const params = embeddedRef.current ? null : new URLSearchParams(window.location.search)
    const token = embeddedRef.current
      ? (externalLoadRequestRef.current?.token ?? '')
      : (params?.get('token') ?? '')
    const isExplicitPlayerMode = embeddedRef.current ? true : params?.get('mode') === 'player'
    handledExternalLoadSeqRef.current = externalLoadRequestRef.current?.seq ?? 0
    mountedRef.current = true
    let cancelled = false
    setLoading(true)
    setLoadError(false)
    setNaturalSize(null)
    setVideoDims(null)
    setFitMode(true)
    setZoom(1)
    setRotation(0)
    setPan({ x: 0, y: 0 })
    setPlaying(false)
    setCurrentTime(0)
    setDuration(0)

    const loadInitial = async (): Promise<void> => {
      try {
        if (typeof window.aiOffice?.mediaGetPlayerState === 'function') {
          const snapshot = await window.aiOffice.mediaGetPlayerState(token || undefined)
          if (cancelled) return
          applyPlayerSnapshot(snapshot, true)
          setLoading(false)
          return
        }
        if (!token) {
          if (cancelled) return
          setInfo(null)
          setPlayerMode(isExplicitPlayerMode)
          setLoading(false)
          return
        }
        const res = await window.aiOffice.mediaGetInfo(token)
        if (cancelled) return
        const isPlayable = res?.mediaKind === 'audio' || res?.mediaKind === 'video'
        applyPlayerSnapshot(
          {
            current: res,
            subtitles: [],
            items: [],
            folders: [],
            prefs: DEFAULT_PREFS,
            resumePositionSec: 0,
            playerMode: isExplicitPlayerMode || isPlayable,
          },
          true,
        )
        setLoading(false)
      } catch {
        if (cancelled) return
        setInfo(null)
        setLoading(false)
        setLoadError(true)
      }
    }

    void loadInitial()
    return () => {
      cancelled = true
    }
  }, [applyPlayerSnapshot])

  const activeMediaElement = useCallback((): HTMLMediaElement | null => {
    const kind = infoRef.current?.mediaKind
    return kind === 'video' ? videoRef.current : kind === 'audio' ? audioRef.current : null
  }, [])

  const flushPlaybackPosition = useCallback((): void => {
    const cur = infoRef.current
    const el = activeMediaElement()
    if (!cur || !el || (cur.mediaKind !== 'audio' && cur.mediaKind !== 'video')) return
    const sec = Number.isFinite(el.currentTime) ? el.currentTime : 0
    const dur = Number.isFinite(el.duration) ? el.duration : 0
    persistPrefs({
      position: {
        filePath: cur.filePath,
        sec,
        ...(dur > 0 ? { durationSec: dur } : {}),
      },
    })
  }, [activeMediaElement, persistPrefs])

  // Load new media triggered externally while the embedded player stays mounted
  useEffect(() => {
    if (!mountedRef.current || !externalLoadRequest) return
    if (externalLoadRequest.seq <= handledExternalLoadSeqRef.current) return
    handledExternalLoadSeqRef.current = externalLoadRequest.seq
    let cancelled = false
    const run = async (): Promise<void> => {
      flushPlaybackPosition()
      try {
        if (typeof window.aiOffice?.mediaGetPlayerState === 'function') {
          const snapshot = await window.aiOffice.mediaGetPlayerState(
            externalLoadRequest.token || undefined,
          )
          if (!cancelled) {
            applyPlayerSnapshot(snapshot, true)
            setLoading(false)
          }
          return
        }
        if (externalLoadRequest.filePath && typeof window.aiOffice?.mediaSwitchTrack === 'function') {
          const res = await window.aiOffice.mediaSwitchTrack(externalLoadRequest.filePath)
          if (!cancelled && res.ok && res.state) {
            applyPlayerSnapshot(res.state, true)
            setLoading(false)
          }
        }
      } catch {
        // Keep current track alive if reload request fails transiently.
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [externalLoadRequest?.seq, externalLoadRequest, applyPlayerSnapshot, flushPlaybackPosition])

  useEffect(() => {
    const onPageHide = (): void => flushPlaybackPosition()
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('beforeunload', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('beforeunload', onPageHide)
      flushPlaybackPosition()
    }
  }, [flushPlaybackPosition])

  // Tear down shared Web Audio graph when unmounting the viewer
  useEffect(() => {
    return () => {
      try {
        connectedSourceRef.current?.disconnect()
      } catch {
        // Ignore errors when source node is already disconnected.
      }
      connectedSourceRef.current = null
      connectedAudioElRef.current = null
      try {
        sharedAnalyserRef.current?.disconnect()
      } catch {
        // Ignore errors when analyser node is already disconnected.
      }
      sharedAnalyserRef.current = null
      const ctx = sharedAudioCtxRef.current
      sharedAudioCtxRef.current = null
      if (ctx && typeof ctx.close === 'function' && ctx.state !== 'closed') {
        void ctx.close().catch(() => undefined)
      }
    }
  }, [])

  // Auto-dismiss resume notice toast
  useEffect(() => {
    if (resumedNoticeSec === null) return
    const timer = window.setTimeout(() => setResumedNoticeSec(null), 5000)
    return () => window.clearTimeout(timer)
  }, [resumedNoticeSec])

  // Scroll the active track row into view when switching tracks
  useEffect(() => {
    activeItemRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [info?.filePath])

  // Clear filter if the selected folder was removed
  useEffect(() => {
    if (folderFilter !== 'all' && !folders.some((f) => sameDir(f.path, folderFilter))) {
      setFolderFilter('all')
    }
  }, [folderFilter, folders])

  // Sync HTMLVideoElement textTracks visibility with selected subtitle toggle
  useEffect(() => {
    const video = videoRef.current
    if (!video || info?.mediaKind !== 'video') return
    const trackList = video.textTracks
    if (!trackList) return
    const targetIdx = subtitles.findIndex((s) => s.id === selectedSubId)
    for (let i = 0; i < trackList.length; i += 1) {
      const track = trackList[i]
      if (!track) continue
      track.mode = subtitlesEnabled && i === targetIdx ? 'showing' : 'disabled'
    }
  }, [info?.token, info?.mediaKind, subtitles, selectedSubId, subtitlesEnabled])

  // Attempt safe autoplay whenever the bound stream URL changes
  const safeStartAutoPlay = useCallback((el: HTMLMediaElement | null): void => {
    if (!el || !shouldAutoPlayRef.current) return
    shouldAutoPlayRef.current = false
    const promise = el.play?.()
    if (promise && typeof promise.catch === 'function') {
      promise.catch(() => undefined)
    }
  }, [])

  // Initialize audio properties and trigger autoplay once metadata is ready
  const initializeMediaElement = useCallback(
    (el: HTMLMediaElement): void => {
      el.volume = volume
      el.muted = muted
      el.playbackRate = playbackRate
      el.loop = playMode === 'loop-one'
      const dur = Number.isFinite(el.duration) ? el.duration : 0
      setDuration(dur)

      if (pendingResumeSecRef.current > 0) {
        const target =
          dur > 0 ? Math.min(pendingResumeSecRef.current, Math.max(0, dur - 2)) : pendingResumeSecRef.current
        pendingResumeSecRef.current = 0
        if (target > 0) {
          el.currentTime = target
          setCurrentTime(target)
        }
      }
      safeStartAutoPlay(el)
    },
    [volume, muted, playbackRate, playMode, safeStartAutoPlay],
  )

  // Track live theme toggles (`data-theme` attribute & OS color scheme) for acoustic stage palette
  useEffect(() => {
    const syncTheme = (): void => setIsDarkTheme(detectIsDarkTheme())
    syncTheme()
    const observer =
      typeof MutationObserver !== 'undefined' ? new MutationObserver(syncTheme) : null
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    const mql =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null
    mql?.addEventListener?.('change', syncTheme)
    return () => {
      observer?.disconnect()
      mql?.removeEventListener?.('change', syncTheme)
    }
  }, [])

  const stagePalette = useMemo<AudioStagePalette>(() => {
    if (coverPalette) return coverPalette
    const seed = audioMeta?.title || info?.fileName || 'genoffice-audio'
    return deriveTrackPalette(seed, isDarkTheme)
  }, [coverPalette, audioMeta?.title, info?.fileName, isDarkTheme])

  const activeLyricIdx = useMemo(() => {
    const lines = audioMeta?.lyrics
    if (!lines || lines.length === 0) return -1
    return findActiveLyricIndex(lines, currentTime)
  }, [audioMeta?.lyrics, currentTime])

  // Smoothly keep the active synchronized lyric centered
  useEffect(() => {
    if (!lyricsOpen || activeLyricIdx < 0) return
    activeLyricRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  }, [activeLyricIdx, lyricsOpen])

  // Web Audio API real-time acoustic stage visualizer (logarithmic bands, peak caps, 3 modes)
  useEffect(() => {
    const canvas = spectrumCanvasRef.current
    const audio = audioRef.current
    if (!canvas || !audio || info?.mediaKind !== 'audio' || loadError || compactMini || visualHidden) {
      if (connectedSourceRef.current && info?.mediaKind !== 'audio') {
        try {
          connectedSourceRef.current.disconnect()
        } catch {
          // Ignore disconnect errors when switching away from audio.
        }
        connectedSourceRef.current = null
        connectedAudioElRef.current = null
      }
      return
    }

    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) return

    let cancelled = false

    const attachAudioIfRunning = async (): Promise<void> => {
      if (!playing) return
      const graph = ensureSharedAudioGraph(sharedAudioCtxRef, sharedAnalyserRef)
      if (!graph) return
      const { ctx, analyser } = graph
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume()
        } catch {
          return
        }
      }
      // Never call createMediaElementSource while AudioContext is still suspended,
      // otherwise Chromium routes audio into the suspended graph and mutes playback.
      if (cancelled || ctx.state !== 'running' || audioRef.current !== audio) return
      if (connectedAudioElRef.current !== audio) {
        if (connectedSourceRef.current) {
          try {
            connectedSourceRef.current.disconnect()
          } catch {
            // Ignore cleanup errors for previous track source node.
          }
          connectedSourceRef.current = null
          connectedAudioElRef.current = null
        }
        try {
          const source = ctx.createMediaElementSource(audio)
          source.connect(analyser)
          connectedSourceRef.current = source
          connectedAudioElRef.current = audio
          setAudioGraphTick((n) => n + 1)
        } catch {
          // Keep native <audio> playback unmuted if Web Audio capture is disallowed.
        }
      }
    }

    void attachAudioIfRunning()

    const onGestureResume = (): void => {
      void attachAudioIfRunning()
    }
    window.addEventListener('pointerdown', onGestureResume, { capture: true })
    window.addEventListener('keydown', onGestureResume, { capture: true })

    const barCount = visualizerMode === 'bars' ? MIRROR_BAR_COUNT : VINYL_HALO_BAR_COUNT
    if (vizBarsRef.current.length !== barCount) {
      vizBarsRef.current = new Float32Array(barCount)
      vizPeaksRef.current = new Float32Array(barCount)
      vizVelRef.current = new Float32Array(barCount)
    }

    const liveAnalyser =
      sharedAudioCtxRef.current?.state === 'running' && connectedAudioElRef.current === audio
        ? sharedAnalyserRef.current
        : null
    const freqBins = liveAnalyser ? new Uint8Array(liveAnalyser.frequencyBinCount) : null
    const timeBins =
      liveAnalyser && visualizerMode === 'wave' ? new Uint8Array(liveAnalyser.fftSize) : null

    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let rafId = 0
    let lastTs = typeof performance !== 'undefined' ? performance.now() : Date.now()

    const measureCanvas = (): { width: number; height: number } => {
      const dpr = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
      const rect = canvas.getBoundingClientRect?.()
      const fallbackW = visualizerMode === 'vinyl' ? 340 : 620
      const fallbackH = visualizerMode === 'vinyl' ? 340 : 184
      const cssW = rect && rect.width > 12 ? rect.width : fallbackW
      const cssH = rect && rect.height > 12 ? rect.height : fallbackH
      const pxW = Math.max(1, Math.round(cssW * dpr))
      const pxH = Math.max(1, Math.round(cssH * dpr))
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW
        canvas.height = pxH
      }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
      return { width: cssW, height: cssH }
    }

    const drawFrame = (nowTs: number): void => {
      if (cancelled) return
      const dtSec = Math.min(0.1, Math.max(0.004, (nowTs - lastTs) / 1000))
      lastTs = nowTs

      const { width, height } = measureCanvas()
      const analyserReady =
        sharedAudioCtxRef.current?.state === 'running' && connectedAudioElRef.current === audio

      let bassEnergy = 0
      if (playing) {
        vizPhaseRef.current = (vizPhaseRef.current + dtSec * (reducedMotion ? 0.5 : 2.1)) % (Math.PI * 200)
      }

      if (playing && analyserReady && liveAnalyser && freqBins) {
        liveAnalyser.getByteFrequencyData(freqBins)
        const mapped = computeLogSpectrum(freqBins, barCount, vizBarsRef.current)
        vizBarsRef.current = mapped.bars
        bassEnergy = mapped.bassEnergy
        if (timeBins) {
          liveAnalyser.getByteTimeDomainData(timeBins)
        }
      } else if (playing) {
        // Gentle breathing wave when native audio plays before user-gesture Web Audio unlock.
        const nextBars = new Float32Array(barCount)
        for (let i = 0; i < barCount; i += 1) {
          const prev = vizBarsRef.current[i] ?? 0
          const target = 0.14 + 0.16 * Math.abs(Math.sin(vizPhaseRef.current * 1.4 + i * 0.42))
          nextBars[i] = prev + (target - prev) * 0.25
        }
        vizBarsRef.current = nextBars
        bassEnergy = 0.18 + 0.12 * Math.abs(Math.sin(vizPhaseRef.current * 1.1))
      } else {
        bassEnergy = 0
      }

      updatePeakCaps(vizBarsRef.current, vizPeaksRef.current, vizVelRef.current, dtSec)

      bassSmoothRef.current += (bassEnergy - bassSmoothRef.current) * 0.25
      if (audioStageRef.current) {
        audioStageRef.current.style.setProperty('--audio-bass', bassSmoothRef.current.toFixed(3))
      }

      const renderState = {
        bars: vizBarsRef.current,
        peaks: vizPeaksRef.current,
        timeData: timeBins,
        bassEnergy: bassSmoothRef.current,
        phase: vizPhaseRef.current,
        playing,
        isDark: isDarkTheme,
        palette: stagePalette,
      }

      if (visualizerMode === 'vinyl') {
        renderVinylHalo(ctx2d, width, height, renderState)
      } else if (visualizerMode === 'bars') {
        renderMirrorBars(ctx2d, width, height, renderState)
      } else {
        renderFluidWave(ctx2d, width, height, renderState)
      }

      const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      if (playing && !isHidden) {
        rafId = window.requestAnimationFrame(drawFrame)
      } else {
        rafId = 0
      }
    }

    const startOrRenderOnce = (): void => {
      if (rafId) {
        window.cancelAnimationFrame(rafId)
        rafId = 0
      }
      lastTs = typeof performance !== 'undefined' ? performance.now() : Date.now()
      drawFrame(lastTs)
    }

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') {
        if (rafId) {
          window.cancelAnimationFrame(rafId)
          rafId = 0
        }
      } else if (playing && !rafId) {
        startOrRenderOnce()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            if (!playing) startOrRenderOnce()
          })
        : null
    resizeObserver?.observe(canvas)

    startOrRenderOnce()
    return () => {
      cancelled = true
      if (rafId) window.cancelAnimationFrame(rafId)
      window.removeEventListener('pointerdown', onGestureResume, { capture: true })
      window.removeEventListener('keydown', onGestureResume, { capture: true })
      document.removeEventListener('visibilitychange', onVisibilityChange)
      resizeObserver?.disconnect()
    }
  }, [
    info?.token,
    info?.mediaKind,
    playing,
    loadError,
    audioGraphTick,
    visualizerMode,
    isDarkTheme,
    stagePalette,
    compactMini,
    visualHidden,
  ])

  // Idle auto-hide for video controls during playback
  const resetControlsIdle = useCallback((): void => {
    setControlsIdle(false)
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
    if (infoRef.current?.mediaKind === 'video' && playing) {
      idleTimerRef.current = window.setTimeout(() => {
        setControlsIdle(true)
      }, CONTROLS_IDLE_MS)
    }
  }, [playing])

  useEffect(() => {
    resetControlsIdle()
    return () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }
    }
  }, [playing, info?.mediaKind, resetControlsIdle])

  // Handle AI agent read_media snapshot requests (with dedupe across 250ms main retries)
  useEffect(() => {
    const unsubscribe = window.aiOffice.onMediaReadSnapshotRequest((req: MediaSnapshotRequest) => {
      if (!req?.requestId || handledRequestsRef.current.has(req.requestId)) return
      handledRequestsRef.current.add(req.requestId)
      if (handledRequestsRef.current.size > 64) {
        const first = handledRequestsRef.current.values().next().value
        if (first) handledRequestsRef.current.delete(first)
      }

      const run = async (): Promise<MediaSnapshotReply> => {
        const current = infoRef.current
        if (!current) {
          return {
            requestId: req.requestId,
            text: 'No media file is loaded in this tab.',
          }
        }
        const headerLines = [
          `File: ${current.fileName}`,
          `Path: ${current.filePath}`,
          `Kind: ${current.mediaKind} (.${current.ext}, ${current.mime})`,
          `Size: ${formatBytes(current.sizeBytes)} (${current.sizeBytes} bytes)`,
        ]

        if (current.mediaKind === 'image') {
          if (loadErrorRef.current || !imgRef.current) {
            return {
              requestId: req.requestId,
              text: `${headerLines.join('\n')}\nStatus: failed to decode image in viewer.`,
            }
          }
          try {
            await waitForImageReady(imgRef.current)
            const encoded = encodeNormalizedImage(imgRef.current, current.ext)
            const dims = `${imgRef.current.naturalWidth}x${imgRef.current.naturalHeight} px`
            if (!encoded) {
              return {
                requestId: req.requestId,
                text: `${headerLines.join('\n')}\nDimensions: ${dims}\nNote: Canvas export returned empty.`,
              }
            }
            return {
              requestId: req.requestId,
              text: `${headerLines.join('\n')}\nDimensions: ${dims}`,
              images: [encoded],
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return {
              requestId: req.requestId,
              text: `${headerLines.join('\n')}\nError: ${msg}`,
            }
          }
        }

        if (current.mediaKind === 'audio') {
          const audio = audioRef.current
          if (audio && !loadErrorRef.current) {
            await waitForMediaReady(audio, 1, 3000).catch(() => undefined)
          }
          const dur = audio && Number.isFinite(audio.duration) ? audio.duration : 0
          const cur = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0
          return {
            requestId: req.requestId,
            text: [
              ...headerLines,
              `Duration: ${formatTime(dur)} (${dur.toFixed(2)}s)`,
              `Position: ${formatTime(cur)} (${cur.toFixed(2)}s)`,
              `Playback: ${audio?.paused === false ? 'playing' : 'paused'} at ${audio?.playbackRate ?? 1}x`,
              ...(loadErrorRef.current
                ? ['Status: built-in audio decoder error (system player fallback available).']
                : []),
              'Hint: To transcribe or summarize the full spoken/audio content, call `media:analyze_media`.',
            ].join('\n'),
          }
        }

        const video = videoRef.current
        if (loadErrorRef.current || !video) {
          return {
            requestId: req.requestId,
            text: [
              ...headerLines,
              'Status: video codec is not supported by built-in Chromium player; user can open with system player.',
              'Hint: To analyze the full video file via AI media provider, call `media:analyze_media`.',
            ].join('\n'),
          }
        }
        try {
          if (
            typeof req.timestampSec === 'number' &&
            Number.isFinite(req.timestampSec) &&
            req.timestampSec >= 0
          ) {
            await seekVideoTo(video, req.timestampSec)
          } else {
            await waitForMediaReady(video, 2, 5000)
          }
          const dur = Number.isFinite(video.duration) ? video.duration : 0
          const cur = Number.isFinite(video.currentTime) ? video.currentTime : 0
          const vw = Math.max(video.videoWidth || 1, 1)
          const vh = Math.max(video.videoHeight || 1, 1)
          const canvas = renderElementToCanvas(video, vw, vh)
          const encoded = canvasToBase64(canvas, 'image/jpeg', 0.88)
          const lines = [
            ...headerLines,
            `Resolution: ${vw}x${vh} px`,
            `Duration: ${formatTime(dur)} (${dur.toFixed(2)}s)`,
            `Captured Frame At: ${formatTime(cur)} (${cur.toFixed(2)}s)`,
            `Playback: ${video.paused ? 'paused' : 'playing'} at ${video.playbackRate}x`,
          ]
          return {
            requestId: req.requestId,
            text: lines.join('\n'),
            ...(encoded ? { images: [encoded] } : {}),
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return {
            requestId: req.requestId,
            text: [
              ...headerLines,
              `Status: unable to capture video frame (${msg}).`,
              'Hint: To analyze the video content directly, call `media:analyze_media`.',
            ].join('\n'),
          }
        }
      }

      void run().then((reply) => {
        window.aiOffice.sendMediaReadSnapshotReply(reply)
      })
    })
    return unsubscribe
  }, [])

  const filteredItems = useMemo(
    () => filterPlaylistItems(items, folderFilter, searchQuery),
    [items, folderFilter, searchQuery],
  )

  const currentTrackIndex = useMemo(() => {
    if (!info) return -1
    const inFiltered = filteredItems.findIndex((item) => sameFile(item.filePath, info.filePath))
    if (inFiltered >= 0) return inFiltered
    return items.findIndex((item) => sameFile(item.filePath, info.filePath))
  }, [info, filteredItems, items])

  const navigationPool = useMemo(() => {
    if (!info) return filteredItems.length > 0 ? filteredItems : items
    if (filteredItems.some((item) => sameFile(item.filePath, info.filePath))) return filteredItems
    return items
  }, [info, filteredItems, items])

  const switchToTrack = useCallback(
    async (filePath: string): Promise<void> => {
      if (info && sameFile(info.filePath, filePath)) {
        const el = activeMediaElement()
        if (el) {
          if (el.ended) el.currentTime = 0
          if (el.paused) void el.play?.().catch(() => undefined)
        }
        return
      }
      flushPlaybackPosition()
      const seq = ++switchSeqRef.current
      if (typeof window.aiOffice?.mediaSwitchTrack !== 'function') return
      const res = await window.aiOffice.mediaSwitchTrack(filePath)
      if (seq !== switchSeqRef.current) return
      if (res.ok && res.state) {
        applyPlayerSnapshot(res.state, true)
      }
    },
    [info, activeMediaElement, flushPlaybackPosition, applyPlayerSnapshot],
  )

  const handleTrackStep = useCallback(
    (direction: 'next' | 'prev', reason: 'ended' | 'manual'): void => {
      if (navigationPool.length === 0) return
      const curIndex = info
        ? navigationPool.findIndex((item) => sameFile(item.filePath, info.filePath))
        : -1
      const targetIndex =
        direction === 'next'
          ? resolveNextTrackIndex({
              count: navigationPool.length,
              currentIndex: curIndex,
              mode: playModeRef.current,
              reason,
              shuffleOrder: shuffleOrderRef.current,
            })
          : resolvePrevTrackIndex({
              count: navigationPool.length,
              currentIndex: curIndex,
              mode: playModeRef.current,
              shuffleOrder: shuffleOrderRef.current,
            })
      if (targetIndex === null) return
      const target = navigationPool[targetIndex]
      if (!target) return
      if (info && sameFile(target.filePath, info.filePath) && reason === 'ended') {
        const el = activeMediaElement()
        if (el) {
          el.currentTime = 0
          void el.play?.().catch(() => undefined)
        }
        return
      }
      void switchToTrack(target.filePath)
    },
    [navigationPool, info, activeMediaElement, switchToTrack],
  )

  const handleMutationResponse = useCallback(
    (res: MediaStateMutationResult | undefined): void => {
      if (!res?.ok || !res.state) return
      const prevPath = infoRef.current?.filePath
      const nextPath = res.state.current?.filePath
      const trackChanged = Boolean(nextPath && (!prevPath || !sameFile(prevPath, nextPath)))
      if (trackChanged) {
        applyPlayerSnapshot(res.state, true)
      } else {
        setItems(res.state.items)
        setFolders(res.state.folders)
        setSubtitles(res.state.subtitles)
        setPlayerMode(res.state.playerMode)
        if (!res.state.current) {
          setInfo(null)
        }
      }
    },
    [applyPlayerSnapshot],
  )

  const handleAddFolder = async (): Promise<void> => {
    const res = await window.aiOffice?.mediaAddFolder?.()
    handleMutationResponse(res)
  }

  const handleAddFiles = async (): Promise<void> => {
    const res = await window.aiOffice?.mediaAddFiles?.()
    handleMutationResponse(res)
  }

  const handlePinFolder = async (dirPath: string): Promise<void> => {
    const res = await window.aiOffice?.mediaPinFolder?.(dirPath)
    handleMutationResponse(res)
  }

  const handleRemoveFolder = async (dirPath: string): Promise<void> => {
    const res = await window.aiOffice?.mediaRemoveFolder?.(dirPath)
    handleMutationResponse(res)
  }

  const handleRemovePinnedFile = async (filePath: string): Promise<void> => {
    const res = await window.aiOffice?.mediaRemovePinnedFile?.(filePath)
    handleMutationResponse(res)
  }

  function effectiveZoomBase(): number {
    if (!fitMode || !imgRef.current || !naturalSize) return zoom
    const rect = imgRef.current.getBoundingClientRect()
    const base = naturalSize.w > 0 ? rect.width / naturalSize.w : 1
    return Number.isFinite(base) && base > 0 ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, base)) : 1
  }

  function stepZoom(factor: number): void {
    const base = effectiveZoomBase()
    setFitMode(false)
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((base * factor).toFixed(2)))))
  }

  function resetToFit(): void {
    setFitMode(true)
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  function setActualSize(): void {
    setFitMode(false)
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  function onWheelStage(e: ReactWheelEvent<HTMLDivElement>): void {
    if (info?.mediaKind !== 'image') return
    e.preventDefault()
    stepZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15)
  }

  function onPointerDownImage(e: ReactPointerEvent<HTMLDivElement>): void {
    if (e.button !== 0 || info?.mediaKind !== 'image') return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    dragOriginRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
  }

  function onPointerMoveImage(e: ReactPointerEvent<HTMLDivElement>): void {
    if (!dragging || !dragOriginRef.current) return
    setPan({
      x: dragOriginRef.current.panX + (e.clientX - dragOriginRef.current.x),
      y: dragOriginRef.current.panY + (e.clientY - dragOriginRef.current.y),
    })
  }

  function onPointerUpImage(): void {
    setDragging(false)
    dragOriginRef.current = null
  }

  function togglePlay(): void {
    const el = activeMediaElement()
    if (!el) return
    if (el.paused) void el.play?.().catch(() => undefined)
    else el.pause()
  }

  function handleSeek(nextSec: number): void {
    const el = activeMediaElement()
    if (!el) return
    const clamped = duration > 0 ? Math.min(duration, Math.max(0, nextSec)) : Math.max(0, nextSec)
    el.currentTime = clamped
    setCurrentTime(clamped)
  }

  function handleSpeedChange(rate: number): void {
    const el = activeMediaElement()
    if (el) el.playbackRate = rate
    setPlaybackRate(rate)
    persistPrefs({ prefs: { playbackRate: rate } })
  }

  function handleVolumeChange(val: number): void {
    const clamped = Math.min(1, Math.max(0, Number(val.toFixed(2))))
    const el = activeMediaElement()
    if (el) {
      el.volume = clamped
      el.muted = clamped === 0
    }
    setVolume(clamped)
    setMuted(clamped === 0)
    persistPrefs({ prefs: { volume: clamped, muted: clamped === 0 } })
  }

  function toggleMute(): void {
    const el = activeMediaElement()
    const next = el ? !el.muted : !muted
    if (el) el.muted = next
    setMuted(next)
    persistPrefs({ prefs: { muted: next } })
  }

  function cyclePlayMode(): void {
    const next = nextPlayMode(playMode)
    setPlayMode(next)
    const el = activeMediaElement()
    if (el) el.loop = next === 'loop-one'
    if (next === 'shuffle') {
      shuffleOrderRef.current = buildShuffleOrder(navigationPool.length, currentTrackIndex)
    }
    persistPrefs({ prefs: { playMode: next } })
  }

  function selectVisualizerMode(mode: MediaVisualizerMode): void {
    setVisualizerMode(mode)
    persistPrefs({ prefs: { visualizerMode: mode } })
  }

  function togglePlaylistCollapsed(): void {
    setPlaylistCollapsed((prev) => {
      const next = !prev
      persistPrefs({ prefs: { playlistCollapsed: next } })
      return next
    })
  }

  function togglePictureInPicture(): void {
    const video = videoRef.current
    if (!video) return
    if (document.pictureInPictureElement === video) {
      void document.exitPictureInPicture().catch(() => undefined)
    } else if (document.pictureInPictureEnabled) {
      void video.requestPictureInPicture().catch(() => undefined)
    }
  }

  function toggleFullscreen(): void {
    const container = stageRef.current
    if (!container) return
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
    } else {
      void container.requestFullscreen().catch(() => undefined)
    }
  }

  function handleVideoClick(): void {
    wasPlayingBeforeDblClickRef.current = !videoRef.current?.paused
    togglePlay()
  }

  function handleVideoDoubleClick(): void {
    const video = videoRef.current
    if (video && wasPlayingBeforeDblClickRef.current !== null) {
      if (wasPlayingBeforeDblClickRef.current && video.paused) {
        void video.play?.().catch(() => undefined)
      } else if (!wasPlayingBeforeDblClickRef.current && !video.paused) {
        video.pause()
      }
      wasPlayingBeforeDblClickRef.current = null
    }
    toggleFullscreen()
  }

  function handleSeekMouseMove(e: ReactMouseEvent<HTMLInputElement>): void {
    if (duration <= 0) {
      setHoverSeek(null)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    setHoverSeek({ pct: pct * 100, sec: pct * duration })
  }

  function handleTimeUpdate(el: HTMLMediaElement): void {
    const nextTime = el.currentTime || 0
    const dur = Number.isFinite(el.duration) ? el.duration : 0
    setCurrentTime(nextTime)
    if (dur > 0 && dur !== duration) setDuration(dur)
    if (el.buffered && el.buffered.length > 0) {
      try {
        setBufferedEnd(el.buffered.end(el.buffered.length - 1))
      } catch {
        // Ignore stale TimeRanges.
      }
    }
    const now = Date.now()
    if (now - lastPositionSaveAtRef.current >= POSITION_SAVE_INTERVAL_MS && infoRef.current) {
      lastPositionSaveAtRef.current = now
      persistPrefs({
        position: {
          filePath: infoRef.current.filePath,
          sec: nextTime,
          ...(dur > 0 ? { durationSec: dur } : {}),
        },
      })
    }
  }

  function handleMediaEnded(): void {
    const cur = infoRef.current
    if (cur && playModeRef.current !== 'loop-one') {
      const dur = activeMediaElement()?.duration ?? duration
      persistPrefs({
        position: {
          filePath: cur.filePath,
          sec: dur > 0 ? dur : 0,
          ...(dur > 0 ? { durationSec: dur } : {}),
        },
      })
    }
    if (playModeRef.current === 'loop-one') {
      const el = activeMediaElement()
      if (el) {
        el.currentTime = 0
        void el.play?.().catch(() => undefined)
      }
      return
    }
    setPlaying(false)
    handleTrackStep('next', 'ended')
  }

  // System MediaSession integration (OS hardware media keys / taskbar controls)
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !info) return
    if (info.mediaKind !== 'audio' && info.mediaKind !== 'video') return
    try {
      if (typeof MediaMetadata !== 'undefined') {
        const metaTitle = audioMeta?.title || info.fileName
        const metaArtist =
          audioMeta?.artist || items.find((i) => sameFile(i.filePath, info.filePath))?.dirName || ''
        navigator.mediaSession.metadata = new MediaMetadata({
          title: metaTitle,
          artist: metaArtist,
          ...(audioMeta?.album ? { album: audioMeta.album } : {}),
          ...(audioMeta?.coverUrl ? { artwork: [{ src: audioMeta.coverUrl }] } : {}),
        })
      }
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
      navigator.mediaSession.setActionHandler('play', () => {
        void activeMediaElement()?.play?.().catch(() => undefined)
      })
      navigator.mediaSession.setActionHandler('pause', () => {
        activeMediaElement()?.pause()
      })
      navigator.mediaSession.setActionHandler('previoustrack', () => handleTrackStep('prev', 'manual'))
      navigator.mediaSession.setActionHandler('nexttrack', () => handleTrackStep('next', 'manual'))
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (typeof details.seekTime === 'number') handleSeek(details.seekTime)
      })
    } catch {
      // Ignore MediaSession errors in unsupported contexts.
    }
  }, [info, items, playing, audioMeta, activeMediaElement, handleTrackStep])

  // Keyboard shortcuts
  keyDownHandlerRef.current = (e: KeyboardEvent): void => {
    if (embeddedRef.current && !keyboardActiveRef.current) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const target = e.target as HTMLElement | null
    const tag = target?.tagName
    if (target && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable)) {
      return
    }
    const current = infoRef.current
    if (current?.mediaKind === 'image' && !playerModeRef.current) {
      if (loadErrorRef.current) return
      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        stepZoom(1.25)
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        stepZoom(1 / 1.25)
      } else if (e.key === '0') {
        e.preventDefault()
        resetToFit()
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        setRotation((r) => (r + 90) % 360)
      }
      return
    }

    if (e.key === 'b' || e.key === 'B') {
      e.preventDefault()
      togglePlaylistCollapsed()
      return
    }
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault()
      handleTrackStep('next', 'manual')
      return
    }
    if (e.key === 'p' || e.key === 'P') {
      e.preventDefault()
      handleTrackStep('prev', 'manual')
      return
    }

    const mediaEl = activeMediaElement()
    if (!mediaEl || loadErrorRef.current) return
    if (e.code === 'Space' || e.key === 'k' || e.key === 'K') {
      if (e.code === 'Space' && tag === 'BUTTON') return
      e.preventDefault()
      togglePlay()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      handleSeek(mediaEl.currentTime - 5)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      handleSeek(mediaEl.currentTime + 5)
    } else if (e.key === 'j' || e.key === 'J') {
      e.preventDefault()
      handleSeek(mediaEl.currentTime - 10)
    } else if (e.key === 'l' || e.key === 'L') {
      e.preventDefault()
      handleSeek(mediaEl.currentTime + 10)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      handleVolumeChange(volume + 0.05)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      handleVolumeChange(volume - 0.05)
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault()
      toggleMute()
    } else if ((e.key === 'f' || e.key === 'F') && current?.mediaKind === 'video') {
      e.preventDefault()
      toggleFullscreen()
    } else if (e.key === '[') {
      e.preventDefault()
      handleSpeedChange(stepPlaybackSpeed(playbackRate, -1))
    } else if (e.key === ']') {
      e.preventDefault()
      handleSpeedChange(stepPlaybackSpeed(playbackRate, 1))
    } else if ((e.key === 'c' || e.key === 'C') && subtitles.length > 0) {
      e.preventDefault()
      setSubtitlesEnabled((prev) => !prev)
    }
  }

  useEffect(() => {
    const listener = (e: KeyboardEvent): void => keyDownHandlerRef.current(e)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  async function handleAskAi(): Promise<void> {
    if (!info) return
    let text: string
    if (info.mediaKind === 'image') {
      text = t('mediaAskImagePrompt')
    } else if (info.mediaKind === 'audio') {
      text = t('mediaAskAudioPrompt')
    } else {
      const rawSec = videoRef.current?.currentTime ?? currentTime
      const clamped = Number.isFinite(rawSec) && rawSec >= 0 ? rawSec : 0
      text = t('mediaAskVideoPrompt', {
        time: formatTime(clamped),
        seconds: String(Math.round(clamped)),
      })
    }
    await window.aiOffice.setAiDock?.({ collapsed: false }).catch(() => undefined)
    await window.aiOffice
      .forwardAskQuery?.({
        text,
        seq: Date.now(),
        origin: 'deep-link',
      })
      .catch(() => undefined)
  }

  function captureVideoFrame(): void {
    const video = videoRef.current
    if (!video || !info || video.videoWidth <= 0) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => {
      if (!blob) return
      const stem = info.fileName.replace(/\.[^.]+$/, '')
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${stem}-frame-${Math.round(video.currentTime)}s.png`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        void navigator.clipboard
          .write([new ClipboardItem({ 'image/png': blob })])
          .catch(() => undefined)
      }
      setCaptureNotice(true)
      window.setTimeout(() => setCaptureNotice(false), 1800)
    }, 'image/png')
  }

  function onDragOverViewer(e: ReactDragEvent<HTMLDivElement>): void {
    if (!playerMode && info?.mediaKind === 'image') return
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  function onDragLeaveViewer(e: ReactDragEvent<HTMLDivElement>): void {
    if (!dropActive) return
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDropActive(false)
  }

  function onDropViewer(e: ReactDragEvent<HTMLDivElement>): void {
    if (!playerMode && info?.mediaKind === 'image') return
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    setDropActive(false)
    const dropped = extractDroppedPaths(e.dataTransfer.files)
    if (dropped.length === 0) return
    void window.aiOffice?.mediaImportDropped?.(dropped)?.then(handleMutationResponse)
  }

  const kindLabel = !info
    ? ps.playerTitle
    : info.mediaKind === 'audio'
      ? t('mediaTypeAudio')
      : t('mediaTypeVideo')
  const hasPlaylistNav = navigationPool.length > 1
  const currentItemMeta = info ? items.find((i) => sameFile(i.filePath, info.filePath)) : undefined
  const bufferedPct = duration > 0 ? Math.min(100, Math.max(0, (bufferedEnd / duration) * 100)) : 0
  const unpinnedSessionFolder = folders.find((f) => !f.persisted && !f.missing)

  const commandActionsRef = useRef({
    togglePlay,
    handleTrackStep,
    pause: () => activeMediaElement()?.pause(),
  })
  commandActionsRef.current = {
    togglePlay,
    handleTrackStep,
    pause: () => activeMediaElement()?.pause(),
  }

  useEffect(() => {
    if (!externalCommand || externalCommand.seq <= handledExternalCommandSeqRef.current) return
    handledExternalCommandSeqRef.current = externalCommand.seq
    if (externalCommand.type === 'toggle-play') commandActionsRef.current.togglePlay()
    else if (externalCommand.type === 'pause') commandActionsRef.current.pause()
    else if (externalCommand.type === 'next') commandActionsRef.current.handleTrackStep('next', 'manual')
    else if (externalCommand.type === 'prev') commandActionsRef.current.handleTrackStep('prev', 'manual')
  }, [externalCommand?.seq, externalCommand])

  const miniFallbackLabel = info ? inferTrackLabelFallback(info.fileName) : null
  const reportTitle =
    audioMeta?.title || miniFallbackLabel?.title || info?.fileName || ps.playerTitle
  const reportArtist =
    audioMeta?.artist || miniFallbackLabel?.artist || currentItemMeta?.dirName

  useEffect(() => {
    onPlaybackReport?.({
      playing,
      title: reportTitle,
      artist: reportArtist,
      mediaKind: info?.mediaKind,
      filePath: info?.filePath,
      coverUrl: audioMeta?.coverUrl,
      hasPrev: hasPlaylistNav,
      hasNext: hasPlaylistNav,
    })
  }, [
    onPlaybackReport,
    playing,
    reportTitle,
    reportArtist,
    info?.mediaKind,
    info?.filePath,
    audioMeta?.coverUrl,
    hasPlaylistNav,
  ])

  if (loading) {
    return (
      <div className={`media-viewer${embedded ? ' is-embedded' : ''}`} data-testid="media-viewer">
        <div className="media-stage">
          <div className="media-empty-card neutral">
            <p>{t('mediaLoading')}</p>
          </div>
        </div>
      </div>
    )
  }

  // Image mode: preserve existing single-image inspection UI with zero regressions
  if (info && info.mediaKind === 'image' && !playerMode) {
    const displayedZoomPct = fitMode ? t('mediaZoomFit') : `${Math.round(zoom * 100)}%`
    return (
      <div className="media-viewer" data-testid="media-viewer">
        <header className="media-header">
          <div className="media-header-meta">
            <span className="media-kind-badge">{t('mediaTypeImage')}</span>
            <h1 className="media-title" title={info.filePath}>
              {info.fileName}
            </h1>
            <span className="media-ext-pill">.{info.ext.toUpperCase()}</span>
            <span className="media-status-readout">{formatBytes(info.sizeBytes)}</span>
          </div>
          <div className="media-header-actions">
            <button
              type="button"
              className="media-btn primary"
              data-testid="media-ask-ai"
              onClick={() => void handleAskAi()}
            >
              {t('mediaAskAi')}
            </button>
            <button
              type="button"
              className="media-btn"
              onClick={() => void window.aiOffice.mediaOpenSystem()}
            >
              {t('mediaOpenSystem')}
            </button>
          </div>
        </header>

        <main
          ref={stageRef}
          className={`media-stage${checkerboard ? ' checkerboard' : ''}`}
          onWheel={onWheelStage}
        >
          {loadError ? (
            <div className="media-empty-card">
              <h2>{t('mediaUnsupportedTitle')}</h2>
              <p>{t('mediaUnsupportedHint')}</p>
              <button
                type="button"
                className="media-btn primary"
                onClick={() => void window.aiOffice.mediaOpenSystem()}
              >
                {t('mediaOpenSystem')}
              </button>
            </div>
          ) : (
            <div
              className={`media-stage-image-wrap${dragging ? ' dragging' : ''}`}
              onPointerDown={onPointerDownImage}
              onPointerMove={onPointerMoveImage}
              onPointerUp={onPointerUpImage}
              onPointerCancel={onPointerUpImage}
              onDoubleClick={() => (fitMode ? setActualSize() : resetToFit())}
            >
              <img
                ref={imgRef}
                className={`media-stage-img${fitMode ? ' fit' : ''}${dragging ? ' no-transition' : ''}`}
                crossOrigin="anonymous"
                src={info.streamUrl}
                alt={info.fileName}
                draggable={false}
                style={{
                  transform: fitMode
                    ? `translate(${pan.x}px, ${pan.y}px) rotate(${rotation}deg)`
                    : `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
                }}
                onLoad={(e) => {
                  const img = e.currentTarget
                  setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight })
                  setLoadError(false)
                }}
                onError={() => setLoadError(true)}
              />
            </div>
          )}
        </main>

        {!loadError && (
          <footer className="media-controls-bar">
            <div className="media-controls-group">
              <button type="button" className="media-btn" onClick={() => stepZoom(1 / 1.25)}>
                {t('mediaZoomOut')}
              </button>
              <button
                type="button"
                className={`media-btn${fitMode ? ' active' : ''}`}
                onClick={resetToFit}
              >
                {t('mediaZoomFit')}
              </button>
              <button
                type="button"
                className={`media-btn${!fitMode && zoom === 1 ? ' active' : ''}`}
                onClick={setActualSize}
              >
                {t('mediaZoomActual')}
              </button>
              <button type="button" className="media-btn" onClick={() => stepZoom(1.25)}>
                {t('mediaZoomIn')}
              </button>
              <button
                type="button"
                className="media-btn"
                onClick={() => setRotation((r) => (r - 90) % 360)}
              >
                {t('mediaRotateLeft')}
              </button>
              <button
                type="button"
                className="media-btn"
                onClick={() => setRotation((r) => (r + 90) % 360)}
              >
                {t('mediaRotateRight')}
              </button>
              <button
                type="button"
                className={`media-btn${checkerboard ? ' active' : ''}`}
                onClick={() => setCheckerboard((prev) => !prev)}
              >
                {t('mediaCheckerboard')}
              </button>
            </div>
            <div className="media-controls-group">
              <span className="media-status-readout">
                {naturalSize ? `${naturalSize.w} × ${naturalSize.h} px · ` : ''}
                {displayedZoomPct}
              </span>
            </div>
          </footer>
        )}
      </div>
    )
  }

  // Non-player image/empty fallback when standalone mode was not requested
  if (!info && !playerMode) {
    return (
      <div className={`media-viewer${embedded ? ' is-embedded' : ''}`} data-testid="media-viewer">
        <div className="media-stage">
          <div className="media-empty-card neutral">
            <h2>{t('mediaNoFile')}</h2>
          </div>
        </div>
      </div>
    )
  }

  const audioElementNode =
    info && !loadError && info.mediaKind === 'audio' ? (
      <audio
        key={info.token}
        ref={audioRef}
        className="media-audio-hidden"
        crossOrigin="anonymous"
        src={info.streamUrl}
        autoPlay={autoPlay}
        preload="metadata"
        onLoadedMetadata={(e) => initializeMediaElement(e.currentTarget)}
        onCanPlay={(e) => safeStartAutoPlay(e.currentTarget)}
        onTimeUpdate={(e) => handleTimeUpdate(e.currentTarget)}
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false)
          flushPlaybackPosition()
        }}
        onEnded={handleMediaEnded}
        onError={() => {
          setPlaying(false)
          setLoadError(true)
        }}
      />
    ) : null

  if (compactMini) {
    return (
      <div
        className={`media-viewer media-player-mode compact-mini${embedded ? ' is-embedded' : ''}${
          dropActive ? ' dragover' : ''
        }`}
        data-testid="media-viewer"
        onDragOver={onDragOverViewer}
        onDragLeave={onDragLeaveViewer}
        onDrop={onDropViewer}
      >
        {audioElementNode}
        <div
          className="media-mini-card"
          data-testid="media-mini-card"
          style={
            {
              '--stage-accent-1': stagePalette.primary,
              '--stage-accent-2': stagePalette.secondary,
              '--stage-glow': stagePalette.glow,
              '--stage-glow-soft': stagePalette.glowSoft,
            } as React.CSSProperties
          }
        >
          <div className="media-mini-main">
            <button
              type="button"
              className={`media-mini-disc${playing ? ' spinning' : ''}`}
              aria-label={playing ? t('mediaPause') : t('mediaPlay')}
              onClick={togglePlay}
            >
              {audioMeta?.coverUrl ? (
                <img src={audioMeta.coverUrl} alt={reportTitle} className="media-mini-cover" />
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M9 18V6l11-2v12"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle cx="6.5" cy="18.5" r="2.5" stroke="currentColor" strokeWidth="2" />
                  <circle cx="17.5" cy="16.5" r="2.5" stroke="currentColor" strokeWidth="2" />
                </svg>
              )}
              <span className="media-mini-disc-hole" aria-hidden="true" />
            </button>

            <div className="media-mini-info">
              <div className="media-mini-title-row">
                <span className="media-mini-title" title={info?.filePath ?? reportTitle}>
                  {reportTitle}
                </span>
                {playing && (
                  <span className="media-eq-bars" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </div>
              <div className="media-mini-sub">
                <span>{reportArtist || ps.playerTitle}</span>
                <span>
                  {formatTime(currentTime)} / {formatTime(duration)}
                </span>
              </div>
            </div>

            <div className="media-mini-controls" data-window-no-drag="true">
              <button
                type="button"
                className="media-mini-btn"
                data-testid="media-mini-prev"
                disabled={!hasPlaylistNav}
                aria-label={ps.prevTrack}
                title={ps.prevTrack}
                onClick={() => handleTrackStep('prev', 'manual')}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3.5 3.5v9M12.5 3.5 6 8l6.5 4.5v-9Z" fill="currentColor" />
                </svg>
              </button>
              <button
                type="button"
                className="media-mini-btn play"
                data-testid="media-mini-play"
                aria-label={playing ? t('mediaPause') : t('mediaPlay')}
                title={playing ? t('mediaPause') : t('mediaPlay')}
                onClick={togglePlay}
              >
                {playing ? (
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <rect x="3.8" y="3.2" width="3" height="9.6" rx="0.9" fill="currentColor" />
                    <rect x="9.2" y="3.2" width="3" height="9.6" rx="0.9" fill="currentColor" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M4.5 3.2 13 8l-8.5 4.8V3.2Z" fill="currentColor" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                className="media-mini-btn"
                data-testid="media-mini-next"
                disabled={!hasPlaylistNav}
                aria-label={ps.nextTrack}
                title={ps.nextTrack}
                onClick={() => handleTrackStep('next', 'manual')}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M12.5 3.5v9M3.5 3.5 10 8l-6.5 4.5v-9Z" fill="currentColor" />
                </svg>
              </button>
              {onExpandFromMini && (
                <button
                  type="button"
                  className="media-mini-btn"
                  data-testid="media-mini-expand"
                  aria-label={ps.expandMode}
                  title={ps.expandMode}
                  onClick={onExpandFromMini}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9.2 6.8M2.5 13.5l4.3-4.3"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
              {onMinimizeFromMini && (
                <button
                  type="button"
                  className="media-mini-btn"
                  data-testid="media-mini-minimize"
                  aria-label={ps.windowMinimize}
                  title={ps.windowMinimize}
                  onClick={onMinimizeFromMini}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              )}
              {onCloseFromMini && (
                <button
                  type="button"
                  className="media-mini-btn danger"
                  data-testid="media-mini-close"
                  aria-label={ps.windowClose}
                  title={ps.windowClose}
                  onClick={onCloseFromMini}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M4 4l8 8M12 4l-8 8"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              )}
            </div>
          </div>

          <div className="media-mini-seek-row" data-window-no-drag="true">
            <input
              type="range"
              className="media-seek-slider"
              aria-label={t('mediaSeek')}
              min={0}
              max={duration > 0 ? duration : 1}
              step={0.1}
              value={Math.min(currentTime, duration > 0 ? duration : 1)}
              onChange={(e) => handleSeek(Number(e.target.value))}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`media-viewer media-player-mode${embedded ? ' is-embedded' : ''}${
        dropActive ? ' dragover' : ''
      }`}
      data-testid="media-viewer"
      onDragOver={onDragOverViewer}
      onDragLeave={onDragLeaveViewer}
      onDrop={onDropViewer}
      onMouseMove={resetControlsIdle}
    >
      {audioElementNode}
      <header className="media-header">
        <div className="media-header-meta">
          <span className="media-kind-badge">{kindLabel}</span>
          <h1 className="media-title" title={info?.filePath ?? ps.playerTitle}>
            {info ? info.fileName : ps.playerTitle}
          </h1>
          {info && (
            <>
              <span className="media-ext-pill">.{info.ext.toUpperCase()}</span>
              <span className="media-status-readout">{formatBytes(info.sizeBytes)}</span>
            </>
          )}
        </div>
        <div className="media-header-actions">
          <button
            type="button"
            className={`media-btn${!playlistCollapsed ? ' active' : ''}`}
            data-testid="media-playlist-toggle"
            onClick={togglePlaylistCollapsed}
          >
            {ps.playlistToggle} ({items.length})
          </button>
          {info && (
            <>
              <button
                type="button"
                className="media-btn primary"
                data-testid="media-ask-ai"
                onClick={() => void handleAskAi()}
              >
                {t('mediaAskAi')}
              </button>
              <button
                type="button"
                className="media-btn"
                onClick={() => void window.aiOffice.mediaOpenSystem()}
              >
                {t('mediaOpenSystem')}
              </button>
            </>
          )}
        </div>
      </header>

      <div className="media-workspace">
        <div className="media-stage-column">
          <main
            ref={stageRef}
            className={`media-stage${info?.mediaKind === 'video' && controlsIdle ? ' controls-idle' : ''}`}
          >
            {captureNotice && <div className="media-toast">{t('mediaCaptureDone')}</div>}
            {resumedNoticeSec !== null && (
              <div className="media-toast resume" data-testid="media-resume-toast">
                <span>{ps.resumedFrom.replace('{time}', formatTime(resumedNoticeSec))}</span>
                <button
                  type="button"
                  className="media-toast-link"
                  onClick={() => {
                    handleSeek(0)
                    setResumedNoticeSec(null)
                  }}
                >
                  {ps.restartFromBeginning}
                </button>
              </div>
            )}

            {!info ? (
              <div className="media-empty-card neutral" data-testid="media-empty-library">
                <h2>{ps.emptyLibraryTitle}</h2>
                <p>{ps.emptyLibraryHint}</p>
                <div className="media-empty-actions">
                  <button
                    type="button"
                    className="media-btn primary"
                    data-testid="media-empty-add-folder"
                    onClick={() => void handleAddFolder()}
                  >
                    {ps.addFolder}
                  </button>
                  <button
                    type="button"
                    className="media-btn"
                    data-testid="media-empty-add-files"
                    onClick={() => void handleAddFiles()}
                  >
                    {ps.addFiles}
                  </button>
                </div>
              </div>
            ) : loadError ? (
              <div className="media-empty-card" data-testid="media-decode-error">
                <h2>{t('mediaUnsupportedTitle')}</h2>
                <p>{t('mediaUnsupportedHint')}</p>
                <div className="media-empty-actions">
                  <button
                    type="button"
                    className="media-btn primary"
                    onClick={() => void window.aiOffice.mediaOpenSystem()}
                  >
                    {t('mediaOpenSystem')}
                  </button>
                  {hasPlaylistNav && (
                    <button
                      type="button"
                      className="media-btn"
                      onClick={() => handleTrackStep('next', 'manual')}
                    >
                      {ps.playNextItem}
                    </button>
                  )}
                </div>
              </div>
            ) : info.mediaKind === 'audio' ? (() => {
              const fallbackLabel = inferTrackLabelFallback(info.fileName)
              const displayTitle = audioMeta?.title || fallbackLabel.title
              const displayArtist = audioMeta?.artist || fallbackLabel.artist
              const displayCollection = audioMeta?.album || currentItemMeta?.dirName
              const sampleSpec = audioMeta?.sampleRateHz
                ? `${audioMeta.bitDepth ? `${audioMeta.bitDepth}-bit / ` : ''}${(audioMeta.sampleRateHz / 1000).toFixed(1).replace(/\.0$/, '')} kHz`
                : null
              const isLossless = info.ext === 'flac' || info.ext === 'wav'
              const lyricLines = audioMeta?.lyrics ?? []
              const showLyrics = lyricLines.length > 0 && lyricsOpen
              const audioSubtitleNode = (
                <p className="media-audio-sub">
                  {displayArtist ? <strong>{displayArtist}</strong> : null}
                  {displayArtist && displayCollection ? ` · ${displayCollection}` : displayCollection || ''}
                  {displayArtist || displayCollection ? ' · ' : ''}
                  .{info.ext.toUpperCase()}
                  {sampleSpec ? ` · ${sampleSpec}` : ` · ${formatBytes(info.sizeBytes)}`}
                  {duration > 0 ? ` · ${formatTime(duration)}` : ''}
                  {isLossless && <span className="media-hires-badge">{ps.audioLossless}</span>}
                </p>
              )

              return (
                <section
                  ref={audioStageRef}
                  className={`media-audio-stage${playing ? ' is-playing' : ''}`}
                  data-testid="media-audio-stage"
                  data-viz-mode={visualizerMode}
                  style={
                    {
                      '--stage-accent-1': stagePalette.primary,
                      '--stage-accent-2': stagePalette.secondary,
                      '--stage-glow': stagePalette.glow,
                      '--stage-glow-soft': stagePalette.glowSoft,
                    } as React.CSSProperties
                  }
                >
                  <div className="media-stage-aurora" aria-hidden="true">
                    {audioMeta?.coverUrl && (
                      <div
                        className="media-stage-cover-wash"
                        style={{ backgroundImage: `url("${audioMeta.coverUrl}")` }}
                      />
                    )}
                    <div className="media-aurora-orb orb-a" />
                    <div className="media-aurora-orb orb-b" />
                  </div>

                  <div className="media-stage-topbar">
                    <div className="media-viz-switcher" role="tablist" aria-label={ps.playerTitle}>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={visualizerMode === 'vinyl'}
                        data-testid="media-viz-mode-vinyl"
                        className={`media-viz-tab${visualizerMode === 'vinyl' ? ' active' : ''}`}
                        onClick={() => selectVisualizerMode('vinyl')}
                      >
                        {ps.vizVinyl}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={visualizerMode === 'bars'}
                        data-testid="media-viz-mode-bars"
                        className={`media-viz-tab${visualizerMode === 'bars' ? ' active' : ''}`}
                        onClick={() => selectVisualizerMode('bars')}
                      >
                        {ps.vizBars}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={visualizerMode === 'wave'}
                        data-testid="media-viz-mode-wave"
                        className={`media-viz-tab${visualizerMode === 'wave' ? ' active' : ''}`}
                        onClick={() => selectVisualizerMode('wave')}
                      >
                        {ps.vizWave}
                      </button>
                    </div>
                    {lyricLines.length > 0 && (
                      <button
                        type="button"
                        data-testid="media-lyrics-toggle"
                        className={`media-btn${lyricsOpen ? ' active' : ''}`}
                        onClick={() => setLyricsOpen((prev) => !prev)}
                      >
                        {ps.lyricsToggle}
                      </button>
                    )}
                  </div>

                  <div className={`media-audio-body${showLyrics ? ' has-lyrics' : ''}`}>
                    {visualizerMode === 'vinyl' ? (
                      <div className="media-vinyl-unit">
                        <div className="media-vinyl-showcase">
                          <canvas
                            ref={spectrumCanvasRef}
                            className="media-audio-spectrum media-vinyl-halo-canvas"
                            width={680}
                            height={680}
                            aria-hidden="true"
                          />
                          <div
                            className={`media-vinyl-disc${playing ? ' spinning' : ''}`}
                            data-testid="media-vinyl-disc"
                            onClick={togglePlay}
                          >
                            <div className="media-vinyl-grooves" aria-hidden="true" />
                            <div className="media-vinyl-sheen" aria-hidden="true" />
                            <div className="media-vinyl-label">
                              {audioMeta?.coverUrl ? (
                                <img
                                  className="media-cover-img"
                                  data-testid="media-audio-cover"
                                  crossOrigin="anonymous"
                                  src={audioMeta.coverUrl}
                                  alt={displayTitle}
                                  onLoad={(e) => {
                                    const extracted = extractPaletteFromImage(e.currentTarget, isDarkTheme)
                                    if (extracted) setCoverPalette(extracted)
                                  }}
                                />
                              ) : (
                                <div className="media-vinyl-art-fallback" aria-hidden="true">
                                  <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
                                    <path
                                      d="M9 18V6l11-2v12"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                    <circle cx="6.5" cy="18.5" r="2.5" stroke="currentColor" strokeWidth="2" />
                                    <circle cx="17.5" cy="16.5" r="2.5" stroke="currentColor" strokeWidth="2" />
                                  </svg>
                                </div>
                              )}
                              <span className="media-vinyl-spindle" aria-hidden="true" />
                            </div>
                          </div>

                          <svg
                            className={`media-vinyl-arm${playing ? ' engaged' : ''}`}
                            data-testid="media-vinyl-arm"
                            viewBox="0 0 120 180"
                            fill="none"
                            aria-hidden="true"
                          >
                            <circle cx="84" cy="26" r="18" className="arm-pivot-ring" />
                            <circle cx="84" cy="26" r="9" className="arm-pivot-core" />
                            <path
                              d="M84 26 L80 96 Q78 122 60 144 L48 158"
                              className="arm-rod"
                              strokeWidth="5.5"
                              strokeLinecap="round"
                            />
                            <path
                              d="M84 26 L80 96 Q78 122 60 144 L48 158"
                              className="arm-rod-highlight"
                              strokeWidth="2"
                              strokeLinecap="round"
                            />
                            <rect
                              x="38"
                              y="151"
                              width="16"
                              height="22"
                              rx="3"
                              transform="rotate(34 46 162)"
                              className="arm-headshell"
                            />
                          </svg>
                        </div>

                        <div className="media-vinyl-caption">
                          <h2 className="media-audio-title" title={info.filePath}>
                            {displayTitle}
                          </h2>
                          {audioSubtitleNode}
                        </div>
                      </div>
                    ) : (
                      <div className="media-panorama-unit">
                        <div className="media-panorama-header">
                          <div className={`media-panorama-cover${playing ? ' playing' : ''}`}>
                            {audioMeta?.coverUrl ? (
                              <img
                                className="media-cover-img"
                                data-testid="media-audio-cover"
                                crossOrigin="anonymous"
                                src={audioMeta.coverUrl}
                                alt={displayTitle}
                                onLoad={(e) => {
                                  const extracted = extractPaletteFromImage(e.currentTarget, isDarkTheme)
                                  if (extracted) setCoverPalette(extracted)
                                }}
                              />
                            ) : (
                              <div className="media-vinyl-art-fallback" aria-hidden="true">
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                                  <path
                                    d="M9 18V6l11-2v12"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                  <circle cx="6.5" cy="18.5" r="2.5" stroke="currentColor" strokeWidth="2" />
                                  <circle cx="17.5" cy="16.5" r="2.5" stroke="currentColor" strokeWidth="2" />
                                </svg>
                              </div>
                            )}
                          </div>
                          <div className="media-audio-heading">
                            <h2 className="media-audio-title" title={info.filePath}>
                              {displayTitle}
                            </h2>
                            {audioSubtitleNode}
                          </div>
                        </div>

                        <div className="media-panorama-canvas-wrap">
                          <canvas
                            ref={spectrumCanvasRef}
                            className="media-audio-spectrum media-panorama-canvas"
                            width={960}
                            height={300}
                            aria-hidden="true"
                          />
                        </div>
                      </div>
                    )}

                    {showLyrics && (
                      <div className="media-lyrics-panel" data-testid="media-lyrics-panel">
                        <div className="media-lyrics-scroll">
                          {lyricLines.map((line, idx) => {
                            const active = idx === activeLyricIdx
                            return (
                              <button
                                key={`${line.timeSec}-${idx}`}
                                ref={active ? activeLyricRef : undefined}
                                type="button"
                                className={`media-lyric-line${active ? ' active' : ''}`}
                                data-testid="media-lyric-line"
                                title={ps.clickLyricSeek}
                                onClick={() => handleSeek(line.timeSec)}
                              >
                                {line.text}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              )
            })() : (
              <video
                key={info.token}
                ref={videoRef}
                className="media-stage-video"
                crossOrigin="anonymous"
                src={info.streamUrl}
                autoPlay={autoPlay}
                preload="metadata"
                playsInline
                onClick={handleVideoClick}
                onDoubleClick={handleVideoDoubleClick}
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget
                  initializeMediaElement(v)
                  if (v.videoWidth > 0 && v.videoHeight > 0) {
                    setVideoDims({ w: v.videoWidth, h: v.videoHeight })
                  }
                }}
                onCanPlay={(e) => safeStartAutoPlay(e.currentTarget)}
                onTimeUpdate={(e) => handleTimeUpdate(e.currentTarget)}
                onPlay={() => setPlaying(true)}
                onPause={() => {
                  setPlaying(false)
                  flushPlaybackPosition()
                }}
                onEnded={handleMediaEnded}
                onError={() => {
                  setPlaying(false)
                  setLoadError(true)
                }}
              >
                {subtitlesEnabled &&
                  subtitles.map((sub) => (
                    <track
                      key={sub.id}
                      kind="subtitles"
                      src={sub.url}
                      label={sub.label}
                      default={sub.id === selectedSubId}
                    />
                  ))}
              </video>
            )}
          </main>

          {info && !loadError && (
            <footer
              className={`media-controls-bar media-controls-player${
                info.mediaKind === 'video' && controlsIdle ? ' idle-dim' : ''
              }`}
            >
              <div className="media-seek-row">
                <span className="media-time-label">{formatTime(currentTime)}</span>
                <div className="media-seek-track-wrap">
                  <div className="media-seek-buffer" style={{ width: `${bufferedPct}%` }} />
                  {hoverSeek && (
                    <span className="media-seek-preview" style={{ left: `${hoverSeek.pct}%` }}>
                      {formatTime(hoverSeek.sec)}
                    </span>
                  )}
                  <input
                    type="range"
                    className="media-seek-slider"
                    aria-label={t('mediaSeek')}
                    min={0}
                    max={duration > 0 ? duration : 1}
                    step={0.1}
                    value={Math.min(currentTime, duration > 0 ? duration : 1)}
                    onMouseMove={handleSeekMouseMove}
                    onMouseLeave={() => setHoverSeek(null)}
                    onChange={(e) => handleSeek(Number(e.target.value))}
                  />
                </div>
                <span className="media-time-label">{formatTime(duration)}</span>
              </div>

              <div className="media-controls-row">
                <div className="media-controls-group">
                  <button
                    type="button"
                    className="media-btn"
                    data-testid="media-prev-btn"
                    disabled={!hasPlaylistNav}
                    title={ps.prevTrack}
                    onClick={() => handleTrackStep('prev', 'manual')}
                  >
                    {ps.prevTrack}
                  </button>
                  <button
                    type="button"
                    className="media-btn primary"
                    data-testid="media-play-btn"
                    onClick={togglePlay}
                  >
                    {playing ? t('mediaPause') : t('mediaPlay')}
                  </button>
                  <button
                    type="button"
                    className="media-btn"
                    data-testid="media-next-btn"
                    disabled={!hasPlaylistNav}
                    title={ps.nextTrack}
                    onClick={() => handleTrackStep('next', 'manual')}
                  >
                    {ps.nextTrack}
                  </button>
                  <button
                    type="button"
                    className={`media-btn${playMode !== 'list' ? ' active' : ''}`}
                    data-testid="media-playmode-btn"
                    onClick={cyclePlayMode}
                  >
                    {playModeLabel(ps, playMode)}
                  </button>
                  <select
                    className="media-select"
                    aria-label={t('mediaSpeed')}
                    value={playbackRate}
                    onChange={(e) => handleSpeedChange(Number(e.target.value))}
                  >
                    {SPEED_PRESETS.map((rate) => (
                      <option key={rate} value={rate}>
                        {rate}x
                      </option>
                    ))}
                  </select>
                  <button type="button" className="media-btn" onClick={toggleMute}>
                    {muted ? t('mediaUnmute') : t('mediaMute')}
                  </button>
                  <input
                    type="range"
                    className="media-volume-slider"
                    aria-label={t('mediaVolume')}
                    min={0}
                    max={1}
                    step={0.05}
                    value={muted ? 0 : volume}
                    onChange={(e) => handleVolumeChange(Number(e.target.value))}
                  />
                </div>

                {info.mediaKind === 'video' && (
                  <div className="media-controls-group">
                    {videoDims && (
                      <span className="media-status-readout">
                        {videoDims.w} × {videoDims.h}
                      </span>
                    )}
                    {subtitles.length > 0 && (
                      <button
                        type="button"
                        className={`media-btn${subtitlesEnabled ? ' active' : ''}`}
                        data-testid="media-subtitle-toggle"
                        onClick={() => setSubtitlesEnabled((prev) => !prev)}
                      >
                        {subtitlesEnabled ? ps.subtitlesOn : ps.subtitlesOff}
                      </button>
                    )}
                    <button type="button" className="media-btn" onClick={captureVideoFrame}>
                      {t('mediaCaptureFrame')}
                    </button>
                    <button type="button" className="media-btn" onClick={togglePictureInPicture}>
                      {t('mediaPip')}
                    </button>
                    <button type="button" className="media-btn" onClick={toggleFullscreen}>
                      {t('mediaFullscreen')}
                    </button>
                  </div>
                )}
              </div>
            </footer>
          )}
        </div>

        {!playlistCollapsed && (
          <aside className="media-playlist-aside" data-testid="media-playlist-aside">
            <div className="media-playlist-head">
              <div className="media-playlist-title-row">
                <span className="media-playlist-title">{ps.playlistTitle}</span>
                <span className="media-playlist-count">
                  {ps.playlistCount.replace('{n}', String(filteredItems.length))}
                </span>
              </div>
              <div className="media-playlist-actions">
                <button
                  type="button"
                  className="media-btn"
                  data-testid="media-add-folder"
                  onClick={() => void handleAddFolder()}
                >
                  {ps.addFolder}
                </button>
                <button
                  type="button"
                  className="media-btn"
                  data-testid="media-add-files"
                  onClick={() => void handleAddFiles()}
                >
                  {ps.addFiles}
                </button>
              </div>
            </div>

            {unpinnedSessionFolder && (
              <div className="media-playlist-pin-banner">
                <span className="media-playlist-pin-name" title={unpinnedSessionFolder.path}>
                  {unpinnedSessionFolder.name}
                </span>
                <button
                  type="button"
                  className="media-btn"
                  data-testid="media-pin-session-folder"
                  onClick={() => void handlePinFolder(unpinnedSessionFolder.path)}
                >
                  {ps.pinFolder}
                </button>
              </div>
            )}

            {folders.length > 0 && (
              <div className="media-folder-chips" role="tablist" aria-label={ps.playlistTitle}>
                <button
                  type="button"
                  className={`media-folder-chip${folderFilter === 'all' ? ' active' : ''}`}
                  onClick={() => setFolderFilter('all')}
                >
                  {ps.allFolders} ({items.length})
                </button>
                {folders.map((folder) => {
                  const selected = folderFilter !== 'all' && sameDir(folderFilter, folder.path)
                  return (
                    <span
                      key={folder.path}
                      className={`media-folder-chip-wrap${selected ? ' active' : ''}${
                        folder.missing ? ' missing' : ''
                      }`}
                    >
                      <button
                        type="button"
                        className={`media-folder-chip${selected ? ' active' : ''}`}
                        title={folder.missing ? `${folder.path} (${ps.missingFolder})` : folder.path}
                        onClick={() => setFolderFilter(folder.path)}
                      >
                        {folder.name} ({folder.count})
                      </button>
                      {folder.persisted && (
                        <button
                          type="button"
                          className="media-folder-remove"
                          title={ps.removeFolderTitle}
                          aria-label={ps.removeFolderTitle}
                          onClick={() => void handleRemoveFolder(folder.path)}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  )
                })}
              </div>
            )}

            <div className="media-playlist-search-wrap">
              <input
                type="search"
                className="media-playlist-search"
                data-testid="media-playlist-search"
                placeholder={ps.searchPlaceholder}
                aria-label={ps.searchPlaceholder}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div
              className="media-playlist-list"
              role="listbox"
              aria-label={ps.playlistTitle}
              title={ps.doubleClickHint}
            >
              {filteredItems.length === 0 ? (
                <div className="media-playlist-empty">
                  {items.length === 0 ? ps.emptyLibraryHint : ps.emptyFilterHint}
                </div>
              ) : (
                filteredItems.map((item, idx) => {
                  const isActive = Boolean(info && sameFile(info.filePath, item.filePath))
                  return (
                    <div
                      key={item.filePath}
                      className={`media-playlist-row${isActive ? ' active' : ''}`}
                    >
                      <button
                        ref={isActive ? activeItemRef : undefined}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        data-testid="media-playlist-item"
                        data-path={item.filePath}
                        className="media-playlist-item-btn"
                        title={item.filePath}
                        onDoubleClick={() => void switchToTrack(item.filePath)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void switchToTrack(item.filePath)
                          }
                        }}
                      >
                        <span className="media-playlist-index" aria-hidden="true">
                          {isActive && playing ? (
                            <span className="media-eq-bars">
                              <i />
                              <i />
                              <i />
                            </span>
                          ) : (
                            idx + 1
                          )}
                        </span>
                        <span className="media-playlist-item-main">
                          <span className="media-playlist-item-name">{item.fileName}</span>
                          <span className="media-playlist-item-meta">
                            {item.mediaKind === 'audio' ? ps.audioLabel : ps.videoLabel} · .
                            {item.ext.toUpperCase()} · {formatBytes(item.sizeBytes)}
                          </span>
                        </span>
                      </button>
                      {item.source === 'pinned' && (
                        <button
                          type="button"
                          className="media-playlist-row-remove"
                          title={ps.removePinnedTitle}
                          aria-label={ps.removePinnedTitle}
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleRemovePinnedFile(item.filePath)
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </aside>
        )}
      </div>

      {dropActive && (
        <div className="media-drop-overlay" aria-hidden="true">
          <div className="media-drop-card">{ps.dropOverlayText}</div>
        </div>
      )}
    </div>
  )
}
