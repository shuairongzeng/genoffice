import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { DesktopPrefs, DesktopRecentsMode, HomeApi } from '../../shared/home-api'
import { Dropdown } from '@genoffice/ui'
import {
  ANIMATED_WALLPAPERS,
  DesktopWallpaperEditor,
  STATIC_WALLPAPERS,
} from './DesktopWallpaperCenter'
import { desktopStrings } from './desktop-strings'
import { useI18n } from './locale'
import './desktop.css'

const DEFAULT_DESKTOP_PREFS: DesktopPrefs = {
  wallpaper: 'default',
  carouselMinutes: 0,
  iconSize: 'md',
  sortMode: 'custom',
  wallpaperFit: 'cover',
  labelColor: '',
  recentsMode: 'stack',
  useStacks: true,
  hiddenRecentPaths: [],
}

/**
 * SettingsModal -> Desktop & Wallpaper pane.
 *
 * Reads and persists the exact same `<userData>/desktop-prefs.json` store as
 * the Home desktop context menu (`desktopPrefs` / `desktopPrefsSave`),
 * subscribing to `onDesktopPrefsChanged` so changes made on either surface
 * reflect live without reopening.
 */
export function DesktopSettingsPane(): ReactElement {
  const { lang, t } = useI18n()
  const s = useMemo(() => desktopStrings(lang), [lang])

  const [prefs, setPrefs] = useState<DesktopPrefs>(DEFAULT_DESKTOP_PREFS)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  const [wallpaperImages, setWallpaperImages] = useState<Record<string, string>>({})
  const wallpaperImagesRef = useRef(wallpaperImages)
  wallpaperImagesRef.current = wallpaperImages
  const pendingIdsRef = useRef(new Set<string>())

  useEffect(() => {
    let alive = true
    const api = window.aiOffice as Partial<HomeApi> | undefined
    const pull = () => {
      api?.desktopPrefs?.().then(
        (loaded) => {
          if (alive) setPrefs(loaded)
        },
        () => undefined,
      )
    }
    pull()
    const off = api?.onDesktopPrefsChanged?.((next) => {
      if (alive && next) {
        prefsRef.current = next
        setPrefs(next)
      } else if (alive) {
        pull()
      }
    })
    return () => {
      alive = false
      off?.()
    }
  }, [])

  const neededWallpaperIds = useMemo(() => {
    const ids = new Set<string>()
    if (prefs.wallpaper !== '' && prefs.wallpaper !== 'default') {
      ids.add(prefs.wallpaper)
    }
    for (const id of ANIMATED_WALLPAPERS) {
      if (id !== 'default') ids.add(id)
    }
    for (const id of STATIC_WALLPAPERS) {
      ids.add(id)
    }
    return [...ids]
  }, [prefs.wallpaper])

  useEffect(() => {
    const api = window.aiOffice as Partial<HomeApi> | undefined
    if (!api?.wallpaperImage) return
    let alive = true
    for (const id of neededWallpaperIds) {
      if (wallpaperImagesRef.current[id] !== undefined) continue
      if (pendingIdsRef.current.has(id)) continue
      pendingIdsRef.current.add(id)
      void api.wallpaperImage(id).then(
        (url) => {
          pendingIdsRef.current.delete(id)
          if (alive && url !== '') {
            setWallpaperImages((prev) => (id in prev ? prev : { ...prev, [id]: url }))
          }
        },
        () => {
          pendingIdsRef.current.delete(id)
        },
      )
    }
    return () => {
      alive = false
    }
  }, [neededWallpaperIds])

  const applyPrefs = useCallback((patch: Partial<DesktopPrefs>) => {
    const next: DesktopPrefs = { ...prefsRef.current, ...patch }
    prefsRef.current = next
    setPrefs(next)
    const save = (window.aiOffice as Partial<HomeApi> | undefined)?.desktopPrefsSave
    if (save) void save(next).then(undefined, () => undefined)
  }, [])

  const applyWallpaper = useCallback(
    (id: string) => {
      applyPrefs({
        wallpaper: id,
        ...(prefsRef.current.carouselMinutes > 0 ? { carouselMinutes: 0 } : {}),
      })
    },
    [applyPrefs],
  )

  const effectiveWallpaper =
    prefs.carouselMinutes > 0 ? STATIC_WALLPAPERS[0]! : prefs.wallpaper
  const fitApplies = effectiveWallpaper !== 'default'
  const useStacks = prefs.useStacks !== false
  const recentsMode: DesktopRecentsMode = prefs.recentsMode ?? 'stack'
  const hiddenCount = prefs.hiddenRecentPaths?.length ?? 0

  return (
    <div className="desktop-settings-pane" data-testid="desktop-settings-pane">
      <h3 className="set-pane-title">{t('setSecDesktop')}</h3>

      <h4 className="desktop-settings-subtitle">{s.desktopSettingsLayout}</h4>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-label">{s.iconSizeLabel}</div>
        </div>
        <Dropdown
          className="set-dd"
          value={prefs.iconSize}
          ariaLabel={s.iconSizeLabel}
          options={[
            { value: 'sm', label: s.sizeSm },
            { value: 'md', label: s.sizeMd },
            { value: 'lg', label: s.sizeLg },
          ]}
          onPick={(value) => applyPrefs({ iconSize: value as DesktopPrefs['iconSize'] })}
        />
      </div>

      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-label">{s.menuSort}</div>
        </div>
        <Dropdown
          className="set-dd"
          value={prefs.sortMode}
          ariaLabel={s.menuSort}
          options={[
            { value: 'custom', label: s.sortCustom },
            { value: 'name', label: s.sortName },
            { value: 'kind', label: s.sortKind },
            { value: 'mtime', label: s.sortMtime },
          ]}
          onPick={(value) => applyPrefs({ sortMode: value as DesktopPrefs['sortMode'] })}
        />
      </div>

      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-label">{s.viewUseStacks}</div>
        </div>
        <button
          type="button"
          className="set-switch"
          role="switch"
          aria-checked={useStacks}
          aria-label={s.viewUseStacks}
          onClick={() => applyPrefs({ useStacks: !useStacks })}
        />
      </div>

      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-label">{s.viewRecentsLabel}</div>
        </div>
        <Dropdown
          className="set-dd"
          value={recentsMode}
          ariaLabel={s.viewRecentsLabel}
          options={[
            { value: 'stack', label: s.recentsStack },
            { value: 'spread', label: s.recentsSpread },
            { value: 'off', label: s.recentsOff },
          ]}
          onPick={(value) => applyPrefs({ recentsMode: value as DesktopRecentsMode })}
        />
      </div>

      {hiddenCount > 0 && (
        <div className="set-field">
          <div className="set-field-text">
            <div className="set-field-label">
              {s.dpHiddenRecentsRestore.replace('{n}', String(hiddenCount))}
            </div>
          </div>
          <button
            type="button"
            className="set-btn"
            onClick={() => applyPrefs({ hiddenRecentPaths: [] })}
          >
            {s.dpHiddenRecentsRestore.replace('{n}', String(hiddenCount))}
          </button>
        </div>
      )}

      <h4 className="desktop-settings-subtitle">{s.desktopSettingsAppearance}</h4>
      <DesktopWallpaperEditor
        embedded
        strings={s}
        prefs={prefs}
        applyPrefs={applyPrefs}
        applyWallpaper={applyWallpaper}
        wallpaperImages={wallpaperImages}
        fitApplies={fitApplies}
      />
    </div>
  )
}
