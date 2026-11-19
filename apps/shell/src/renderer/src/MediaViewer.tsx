import { useEffect, useRef, useState } from 'react'
import type { WheelEvent as ReactWheelEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { MediaInfo, MediaSnapshotReply, MediaSnapshotRequest } from '../../shared/home-api'
import { useI18n } from './locale'
import './media-viewer.css'

const MAX_AI_EDGE_PX = 1600
const MAX_PNG_BASE64_BYTES = 2_400_000
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const
const MIN_ZOOM = 0.1
const MAX_ZOOM = 8

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

export function MediaViewer(): React.JSX.Element {
  const { t } = useI18n()
  const [info, setInfo] = useState<MediaInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

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
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [loop, setLoop] = useState(false)
  const [videoDims, setVideoDims] = useState<{ w: number; h: number } | null>(null)
  const [captureNotice, setCaptureNotice] = useState(false)

  const imgRef = useRef<HTMLImageElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const dragOriginRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const handledRequestsRef = useRef<Set<string>>(new Set())

  const infoRef = useRef(info)
  infoRef.current = info
  const loadErrorRef = useRef(loadError)
  loadErrorRef.current = loadError

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token') ?? ''
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
    if (!token) {
      setInfo(null)
      setLoading(false)
      return
    }
    void window.aiOffice
      .mediaGetInfo(token)
      .then((res) => {
        if (cancelled) return
        setInfo(res)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setInfo(null)
        setLoading(false)
        setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

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

        // Video snapshot
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
          if (typeof req.timestampSec === 'number' && Number.isFinite(req.timestampSec) && req.timestampSec >= 0) {
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

  // Keyboard shortcuts for audio/video playback
  useEffect(() => {
    if (!info || info.mediaKind === 'image') return
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)) {
        return
      }
      const mediaEl = info.mediaKind === 'video' ? videoRef.current : audioRef.current
      if (!mediaEl) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (mediaEl.paused) void mediaEl.play().catch(() => undefined)
        else mediaEl.pause()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        mediaEl.currentTime = Math.max(0, mediaEl.currentTime - 10)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        const maxDur = Number.isFinite(mediaEl.duration) ? mediaEl.duration : mediaEl.currentTime + 10
        mediaEl.currentTime = Math.min(maxDur, mediaEl.currentTime + 10)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [info])

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

  function activeMediaElement(): HTMLMediaElement | null {
    return info?.mediaKind === 'video' ? videoRef.current : audioRef.current
  }

  function togglePlay(): void {
    const el = activeMediaElement()
    if (!el) return
    if (el.paused) void el.play().catch(() => undefined)
    else el.pause()
  }

  function handleSeek(nextSec: number): void {
    const el = activeMediaElement()
    if (!el) return
    el.currentTime = nextSec
    setCurrentTime(nextSec)
  }

  function handleSpeedChange(rate: number): void {
    const el = activeMediaElement()
    if (el) el.playbackRate = rate
    setPlaybackRate(rate)
  }

  function handleVolumeChange(val: number): void {
    const el = activeMediaElement()
    if (el) {
      el.volume = val
      el.muted = val === 0
    }
    setVolume(val)
    setMuted(val === 0)
  }

  function toggleMute(): void {
    const el = activeMediaElement()
    if (!el) return
    const next = !el.muted
    el.muted = next
    setMuted(next)
  }

  function toggleLoop(): void {
    const el = activeMediaElement()
    if (!el) return
    const next = !el.loop
    el.loop = next
    setLoop(next)
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

  if (loading) {
    return (
      <div className="media-viewer">
        <div className="media-stage">
          <div className="media-empty-card neutral">
            <p>{t('mediaLoading')}</p>
          </div>
        </div>
      </div>
    )
  }

  if (!info) {
    return (
      <div className="media-viewer">
        <div className="media-stage">
          <div className="media-empty-card neutral">
            <h2>{t('mediaNoFile')}</h2>
          </div>
        </div>
      </div>
    )
  }

  const kindLabel =
    info.mediaKind === 'image'
      ? t('mediaTypeImage')
      : info.mediaKind === 'audio'
        ? t('mediaTypeAudio')
        : t('mediaTypeVideo')

  const displayedZoomPct = fitMode ? t('mediaZoomFit') : `${Math.round(zoom * 100)}%`

  return (
    <div className="media-viewer">
      <header className="media-header">
        <div className="media-header-meta">
          <span className="media-kind-badge">{kindLabel}</span>
          <h1 className="media-title" title={info.filePath}>
            {info.fileName}
          </h1>
          <span className="media-ext-pill">.{info.ext.toUpperCase()}</span>
          <span className="media-status-readout">{formatBytes(info.sizeBytes)}</span>
        </div>
        <div className="media-header-actions">
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
        className={`media-stage${info.mediaKind === 'image' && checkerboard ? ' checkerboard' : ''}`}
        onWheel={onWheelStage}
      >
        {captureNotice && <div className="media-toast">{t('mediaCaptureDone')}</div>}

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
        ) : info.mediaKind === 'image' ? (
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
        ) : info.mediaKind === 'audio' ? (
          <section className="media-audio-card">
            <div className="media-audio-hero">
              <div className="media-audio-disc" aria-hidden="true">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
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
              <div>
                <h2 className="media-audio-title">{info.fileName}</h2>
                <p className="media-audio-sub">
                  .{info.ext.toUpperCase()} · {formatBytes(info.sizeBytes)}
                  {duration > 0 ? ` · ${formatTime(duration)}` : ''}
                </p>
              </div>
            </div>

            <audio
              ref={audioRef}
              src={info.streamUrl}
              preload="metadata"
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime || 0)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onError={() => setLoadError(true)}
            />

            <div className="media-seek-row">
              <span className="media-time-label">{formatTime(currentTime)}</span>
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
              <span className="media-time-label">{formatTime(duration)}</span>
            </div>

            <div className="media-controls-group">
              <button type="button" className="media-btn primary" onClick={togglePlay}>
                {playing ? t('mediaPause') : t('mediaPlay')}
              </button>
              <button
                type="button"
                className={`media-btn${loop ? ' active' : ''}`}
                onClick={toggleLoop}
              >
                {t('mediaLoop')}
              </button>
              <select
                className="media-select"
                aria-label={t('mediaSpeed')}
                value={playbackRate}
                onChange={(e) => handleSpeedChange(Number(e.target.value))}
              >
                {SPEED_OPTIONS.map((rate) => (
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
          </section>
        ) : (
          <video
            ref={videoRef}
            className="media-stage-video"
            crossOrigin="anonymous"
            src={info.streamUrl}
            preload="metadata"
            playsInline
            onClick={togglePlay}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget
              setDuration(v.duration || 0)
              if (v.videoWidth > 0 && v.videoHeight > 0) {
                setVideoDims({ w: v.videoWidth, h: v.videoHeight })
              }
            }}
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime || 0)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={() => setLoadError(true)}
          />
        )}
      </main>

      {info.mediaKind === 'image' && !loadError && (
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

      {info.mediaKind === 'video' && !loadError && (
        <footer className="media-controls-bar">
          <div className="media-seek-row">
            <span className="media-time-label">{formatTime(currentTime)}</span>
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
            <span className="media-time-label">{formatTime(duration)}</span>
          </div>
          <div className="media-controls-group">
            <button type="button" className="media-btn primary" onClick={togglePlay}>
              {playing ? t('mediaPause') : t('mediaPlay')}
            </button>
            <select
              className="media-select"
              aria-label={t('mediaSpeed')}
              value={playbackRate}
              onChange={(e) => handleSpeedChange(Number(e.target.value))}
            >
              {SPEED_OPTIONS.map((rate) => (
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
          <div className="media-controls-group">
            {videoDims && (
              <span className="media-status-readout">
                {videoDims.w} × {videoDims.h}
              </span>
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
        </footer>
      )}
    </div>
  )
}
