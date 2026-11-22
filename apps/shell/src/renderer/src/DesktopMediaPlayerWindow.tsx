import { useCallback, useState } from 'react'
import type { DragEvent as ReactDragEvent, ReactElement } from 'react'
import type { Lang } from '@genoffice/i18n'
import { PlayerGlyph } from './app-glyphs'
import { DesktopWindow } from './DesktopWindow'
import {
  clampWindowRect,
  defaultWindowRect,
  readWindowPrefs,
  writeWindowPrefs,
  type DesktopWindowMode,
  type DesktopWindowSnap,
  type StageBounds,
  type WindowRect,
} from './desktop-window-geometry'
import { getMediaPlayerStrings } from './media-player-strings'
import {
  MediaViewer,
  type MediaExternalCommand,
  type MediaExternalLoadRequest,
  type MediaPlaybackReport,
} from './MediaViewer'

const PLAYER_WINDOW_PREFS_KEY = 'desktop.media-player-window.v1'
const PLAYER_MINI_POS_KEY = 'desktop.media-mini-pos.v1'

interface MiniPos {
  readonly x: number
  readonly y: number
}

function readMiniPos(): MiniPos | undefined {
  try {
    const raw = JSON.parse(localStorage.getItem(PLAYER_MINI_POS_KEY) ?? 'null') as Partial<MiniPos> | null
    if (!raw || typeof raw.x !== 'number' || typeof raw.y !== 'number') return undefined
    if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return undefined
    return { x: raw.x, y: raw.y }
  } catch {
    return undefined
  }
}

function writeMiniPos(pos: MiniPos): void {
  try {
    localStorage.setItem(PLAYER_MINI_POS_KEY, JSON.stringify(pos))
  } catch {
    // Ignore storage errors.
  }
}

export interface DesktopMediaPlayerWindowProps {
  readonly lang: Lang
  readonly visible: boolean
  readonly focused: boolean
  readonly stage: StageBounds
  readonly mode: DesktopWindowMode
  readonly autoHideHeaderOnMaximize?: boolean
  readonly loadRequest: MediaExternalLoadRequest | null
  readonly command: MediaExternalCommand | null
  readonly onFocus: () => void
  readonly onModeChange: (mode: DesktopWindowMode) => void
  readonly onClose: () => void
  readonly onOpenInTab: (filePath?: string) => void
  readonly onPlaybackChange: (report: MediaPlaybackReport) => void
}

export function DesktopMediaPlayerWindow({
  lang,
  visible,
  focused,
  stage,
  mode,
  autoHideHeaderOnMaximize = true,
  loadRequest,
  command,
  onFocus,
  onModeChange,
  onClose,
  onOpenInTab,
  onPlaybackChange,
}: DesktopMediaPlayerWindowProps): ReactElement {
  const ps = getMediaPlayerStrings(lang)

  const [savedInit] = useState(() => readWindowPrefs(PLAYER_WINDOW_PREFS_KEY))
  const [rect, setRect] = useState<WindowRect>(() =>
    savedInit?.rect
      ? clampWindowRect(savedInit.rect, stage)
      : defaultWindowRect(stage, { width: 880, height: 560 }),
  )
  const [snap, setSnap] = useState<DesktopWindowSnap>(() => savedInit?.snap ?? 'none')
  const [miniPos, setMiniPos] = useState<MiniPos | undefined>(() => readMiniPos())
  const [playback, setPlayback] = useState<MediaPlaybackReport>({
    playing: false,
    title: ps.playerTitle,
    hasPrev: false,
    hasNext: false,
  })

  const handleRectChange = useCallback(
    (nextRect: WindowRect, nextSnap: DesktopWindowSnap = 'none'): void => {
      setRect(nextRect)
      setSnap(nextSnap)
      writeWindowPrefs(PLAYER_WINDOW_PREFS_KEY, { rect: nextRect, mode, snap: nextSnap })
    },
    [mode],
  )

  const handleModeChange = useCallback(
    (nextMode: DesktopWindowMode, nextSnap?: DesktopWindowSnap): void => {
      const resolvedSnap = nextSnap ?? snap
      setSnap(resolvedSnap)
      onModeChange(nextMode)
      writeWindowPrefs(PLAYER_WINDOW_PREFS_KEY, { rect, mode: nextMode, snap: resolvedSnap })
    },
    [onModeChange, rect, snap],
  )

  const handleMiniPosChange = useCallback((nextPos: { x: number; y: number }): void => {
    setMiniPos(nextPos)
    writeMiniPos(nextPos)
  }, [])

  const handlePlaybackReport = useCallback(
    (next: MediaPlaybackReport): void => {
      setPlayback(next)
      onPlaybackChange(next)
    },
    [onPlaybackChange],
  )

  const titleText =
    playback.title && playback.title !== ps.playerTitle
      ? `${ps.playerTitle} — ${playback.title}`
      : ps.playerTitle

  const stopFileDropBubble = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.stopPropagation()
    }
  }

  return (
    <div
      className="desktop-player-host"
      onDragEnter={stopFileDropBubble}
      onDragOver={stopFileDropBubble}
      onDrop={stopFileDropBubble}
    >
      <DesktopWindow
        testId="desktop-media-window"
        title={titleText}
        icon={<PlayerGlyph />}
        mode={mode}
        snap={snap}
        rect={rect}
        miniPos={miniPos}
        stage={stage}
        focused={focused}
        autoHideHeaderOnMaximize={autoHideHeaderOnMaximize}
        visualHidden={!visible}
        minWidth={520}
        minHeight={360}
        labels={{
          minimize: ps.windowMinimize,
          maximize: ps.windowMaximize,
          restore: ps.windowRestore,
          close: ps.windowClose,
        }}
        headerActions={
          <>
            <button
              type="button"
              className="desktop-window-action-btn"
              data-testid="desktop-player-mini-btn"
              title={ps.miniMode}
              onClick={() => handleModeChange('mini', 'none')}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="2" y="3" width="12" height="10" rx="2.2" stroke="currentColor" strokeWidth="1.3" />
                <rect x="7.5" y="7.5" width="5" height="4" rx="1" fill="currentColor" />
              </svg>
              <span>{ps.miniMode}</span>
            </button>
            <button
              type="button"
              className="desktop-window-action-btn"
              data-testid="desktop-player-open-tab-btn"
              title={ps.openInTab}
              onClick={() => onOpenInTab(playback.filePath)}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M6.5 3.5H3.8a1.3 1.3 0 0 0-1.3 1.3v7.4a1.3 1.3 0 0 0 1.3 1.3h7.4a1.3 1.3 0 0 0 1.3-1.3V9.5M9.5 2.5h4v4M13.5 2.5 8 8"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>{ps.openInTab}</span>
            </button>
          </>
        }
        onFocus={onFocus}
        onRectChange={handleRectChange}
        onMiniPosChange={handleMiniPosChange}
        onModeChange={handleModeChange}
        onClose={onClose}
      >
        <MediaViewer
          embedded
          keyboardActive={visible && focused && mode !== 'minimized'}
          visualHidden={!visible || mode === 'minimized'}
          compactMini={mode === 'mini'}
          externalLoadRequest={loadRequest}
          externalCommand={command}
          onPlaybackReport={handlePlaybackReport}
          onExpandFromMini={() => handleModeChange('normal', snap)}
          onMinimizeFromMini={() => handleModeChange('minimized', snap)}
          onCloseFromMini={onClose}
        />
      </DesktopWindow>
    </div>
  )
}
