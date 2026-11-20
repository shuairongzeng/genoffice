import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from './locale'
import type { TFunc } from './locale'
import { useConfirm } from './ConfirmDialog'
import {
  GENOFFICE_PI_SYSTEM_PROMPT,
  MAX_PI_SYSTEM_PROMPT_CHARS,
  mergePiAgentPrefs,
  normalizePiAgentPrefs,
  normalizePiSystemPrompt,
  type PiAgentPrefs,
  type PiAgentPrefsPatch,
} from '../../shared/pi-agent-prefs'
import type {
  PiDiagnosticReport,
  PiEcosystemOverview,
  PiMagicMemoryEntry,
  PiPackageActionResult,
} from '../../shared/pi-agent-api'
import { getPiEcosystemStrings } from './pi-ecosystem-strings'
import './pi-ecosystem-settings.css'

type InventoryTab = 'extensions' | 'skills' | 'commands'
type BannerState = { readonly kind: 'success' | 'error'; readonly text: string } | null

/** Extract sorted unique non-empty categories from stored Magic Context memories. */
export function collectMemoryCategories(memories: readonly PiMagicMemoryEntry[]): string[] {
  const seen = new Set<string>()
  for (const item of memories) {
    const cat = item.category.trim()
    if (cat) seen.add(cat)
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b))
}

/** Filter Magic Context memories by category (`'all'` returns the full list). */
export function filterMagicMemories(
  memories: readonly PiMagicMemoryEntry[],
  category: string,
): readonly PiMagicMemoryEntry[] {
  if (!category || category === 'all') return memories
  return memories.filter((item) => item.category === category)
}

/** Format an ISO or SQLite timestamp into a compact readable string. */
export function formatMemoryDate(raw: string | undefined): string {
  if (!raw) return '—'
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return raw
  return date.toLocaleString()
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onToggle,
}: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div className="set-field set-field-top">
      <div className="set-field-text">
        <div className="set-field-stack">
          <div className="set-field-label">{label}</div>
          <div className="set-field-desc">{description}</div>
        </div>
        <button
          type="button"
          className="set-switch"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          disabled={disabled}
          onClick={onToggle}
        />
      </div>
    </div>
  )
}

export function PiEcosystemSettingsPane({ t }: { t: TFunc }): React.JSX.Element {
  const { lang } = useI18n()
  const copy = useMemo(() => getPiEcosystemStrings(lang), [lang])
  const { confirm: confirmBox, dialog: confirmDialog } = useConfirm(t('ok'))

  const [prefs, setPrefs] = useState<PiAgentPrefs>(() => normalizePiAgentPrefs(undefined))
  const prefsRef = useRef<PiAgentPrefs>(prefs)
  prefsRef.current = prefs
  const hydratedOrMutatedRef = useRef(false)

  const [historianDraft, setHistorianDraft] = useState('')
  const [dreamerDraft, setDreamerDraft] = useState('')
  const [promptDraft, setPromptDraft] = useState(GENOFFICE_PI_SYSTEM_PROMPT)
  const [packageInput, setPackageInput] = useState('')
  const [overview, setOverview] = useState<PiEcosystemOverview | null>(null)
  const [memories, setMemories] = useState<PiMagicMemoryEntry[]>([])
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [inventoryTab, setInventoryTab] = useState<InventoryTab>('extensions')
  const [diagnostics, setDiagnostics] = useState<PiDiagnosticReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<BannerState>(null)

  const syncModelDrafts = useCallback((next: PiAgentPrefs) => {
    setHistorianDraft(next.historianModel)
    setDreamerDraft(next.dreamerModel)
    setPromptDraft(next.systemPrompt || GENOFFICE_PI_SYSTEM_PROMPT)
  }, [])

  const loadData = useCallback(async () => {
    const api = typeof window !== 'undefined' ? window.aiOffice : undefined
    if (!api) return
    const [ov, mems] = await Promise.all([
      api.piAgentEcosystemOverview?.().catch(() => null),
      api.piAgentMemoriesList?.({ limit: 200 }).catch(() => []),
    ])
    if (ov) setOverview(ov)
    if (Array.isArray(mems)) setMemories(mems)
  }, [])

  useEffect(() => {
    let alive = true
    const api = typeof window !== 'undefined' ? window.aiOffice : undefined
    if (!api) return
    void api
      .piAgentPrefsGet?.()
      .then((loaded) => {
        if (!alive || hydratedOrMutatedRef.current) return
        const next = normalizePiAgentPrefs(loaded)
        prefsRef.current = next
        setPrefs(next)
        syncModelDrafts(next)
      })
      .catch(() => undefined)
    const off = api.onPiAgentPrefsChanged?.((incoming) => {
      if (!alive) return
      hydratedOrMutatedRef.current = true
      const next = normalizePiAgentPrefs(incoming)
      prefsRef.current = next
      setPrefs(next)
      syncModelDrafts(next)
    })
    void loadData()
    return () => {
      alive = false
      off?.()
    }
  }, [loadData, syncModelDrafts])

  const commitPrefs = useCallback(
    async (patch: PiAgentPrefsPatch): Promise<boolean> => {
      const api = typeof window !== 'undefined' ? window.aiOffice : undefined
      hydratedOrMutatedRef.current = true
      const optimistic = mergePiAgentPrefs(prefsRef.current, patch)
      prefsRef.current = optimistic
      setPrefs(optimistic)
      if (!api?.piAgentPrefsSet) return true
      try {
        const persisted = normalizePiAgentPrefs(await api.piAgentPrefsSet(patch))
        prefsRef.current = persisted
        setPrefs(persisted)
        syncModelDrafts(persisted)
        await loadData()
        return true
      } catch (err) {
        setBanner({
          kind: 'error',
          text: `${copy.actionFailedPrefix}: ${err instanceof Error ? err.message : String(err)}`,
        })
        return false
      }
    },
    [copy.actionFailedPrefix, loadData, syncModelDrafts],
  )

  const handlePackageResult = useCallback(
    async (res: PiPackageActionResult | undefined) => {
      if (!res) return
      if (res.ok) {
        setBanner({ kind: 'success', text: res.message || copy.actionSuccess })
        await loadData()
      } else {
        setBanner({
          kind: 'error',
          text: `${copy.actionFailedPrefix}: ${res.error || copy.actionFailedPrefix}`,
        })
      }
    },
    [copy.actionFailedPrefix, copy.actionSuccess, loadData],
  )

  const runAction = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setBanner(null)
    try {
      await fn()
    } catch (err) {
      setBanner({
        kind: 'error',
        text: `${copy.actionFailedPrefix}: ${err instanceof Error ? err.message : String(err)}`,
      })
    } finally {
      setBusy(false)
    }
  }

  const handleInstallPackage = () => {
    const source = packageInput.trim()
    if (!source) return
    void runAction(async () => {
      const res = await window.aiOffice?.piAgentPackageInstall?.(source)
      if (res?.ok) setPackageInput('')
      await handlePackageResult(res)
    })
  }

  const handleUpdatePackages = (source?: string) => {
    void runAction(async () => {
      const res = await window.aiOffice?.piAgentPackageUpdate?.(source)
      await handlePackageResult(res)
    })
  }

  const handleRemovePackage = async (source: string) => {
    if (busy) return
    const ok = await confirmBox({
      body: <p>{copy.removePackageConfirm.replace('{source}', source)}</p>,
      confirmLabel: t('delete'),
      cancelLabel: t('cancel'),
      danger: true,
    })
    if (!ok) return
    await runAction(async () => {
      const res = await window.aiOffice?.piAgentPackageRemove?.(source)
      await handlePackageResult(res)
    })
  }

  const handleDeleteMemory = async (id: number) => {
    if (busy) return
    const ok = await confirmBox({
      body: <p>{copy.deleteMemoryConfirm}</p>,
      confirmLabel: t('delete'),
      cancelLabel: t('cancel'),
      danger: true,
    })
    if (!ok) return
    await runAction(async () => {
      const res = await window.aiOffice?.piAgentMemoryDelete?.(id)
      if (res?.ok) {
        setMemories((prev) => prev.filter((item) => item.id !== id))
        setBanner({ kind: 'success', text: copy.actionSuccess })
        await loadData()
      } else {
        setBanner({ kind: 'error', text: copy.actionFailedPrefix })
      }
    })
  }

  const handleReload = () => {
    void runAction(async () => {
      await window.aiOffice?.piAgentReload?.()
      await loadData()
      setBanner({ kind: 'success', text: copy.actionSuccess })
    })
  }

  const handleRunDiagnostics = () => {
    void runAction(async () => {
      const report = await window.aiOffice?.piAgentRunDiagnostics?.()
      if (report) {
        setDiagnostics(report)
        setBanner({
          kind: report.ok ? 'success' : 'error',
          text: report.ok ? copy.diagnosticsAllOk : copy.diagnosticsHasIssues,
        })
      }
    })
  }

  const categories = useMemo(() => collectMemoryCategories(memories), [memories])
  const visibleMemories = useMemo(
    () => filterMagicMemories(memories, categoryFilter),
    [memories, categoryFilter],
  )
  const diagItems = diagnostics?.items ?? overview?.diagnostics ?? []

  const isCustomPrompt = prefs.systemPrompt.trim().length > 0
  const normalizedPromptDraft = normalizePiSystemPrompt(promptDraft)
  const hasPromptChanges = normalizedPromptDraft !== prefs.systemPrompt
  const canResetPrompt =
    isCustomPrompt || promptDraft.trim() !== GENOFFICE_PI_SYSTEM_PROMPT.trim()

  const handleSavePrompt = () => {
    void runAction(async () => {
      const saved = await commitPrefs({ systemPrompt: promptDraft })
      if (saved) {
        setBanner({
          kind: 'success',
          text: normalizedPromptDraft ? copy.promptSavedMsg : copy.promptResetMsg,
        })
      }
    })
  }

  const handleResetPrompt = () => {
    void runAction(async () => {
      const reset = await commitPrefs({ systemPrompt: '' })
      if (reset) {
        setPromptDraft(GENOFFICE_PI_SYSTEM_PROMPT)
        setBanner({ kind: 'success', text: copy.promptResetMsg })
      }
    })
  }

  return (
    <div className="pi-eco-pane" data-testid="pi-ecosystem-settings-pane">
      <div className="pi-eco-header">
        <div>
          <h3 className="set-pane-title">{copy.title}</h3>
          <div className="set-field-desc">{copy.subtitle}</div>
        </div>
        <div className="pi-eco-header-actions">
          <button type="button" className="set-btn" disabled={busy} onClick={() => void loadData()}>
            {copy.refreshBtn}
          </button>
          <button
            type="button"
            className="set-btn primary"
            disabled={busy}
            onClick={handleReload}
          >
            {copy.reloadBtn}
          </button>
        </div>
      </div>

      {overview?.envOverrideLegacy && (
        <div className="pi-eco-banner" data-kind="error" role="status">
          {copy.envOverrideBanner}
        </div>
      )}

      {banner && (
        <div className="pi-eco-banner" data-kind={banner.kind} role="status">
          {banner.text}
        </div>
      )}

      {overview ? (
        <div className="pi-eco-summary-grid">
          <div className="pi-eco-stat-card">
            <span className="pi-eco-stat-label">{copy.versionPiLabel}</span>
            <span className="pi-eco-stat-value">{overview.piCodingAgentVersion ?? '—'}</span>
          </div>
          <div className="pi-eco-stat-card">
            <span className="pi-eco-stat-label">{copy.versionMcLabel}</span>
            <span className="pi-eco-stat-value">
              {overview.magicContextVersion
                ? `${overview.magicContextVersion}${overview.magicContextLoaded ? '' : ' (idle)'}`
                : '—'}
            </span>
          </div>
          <div className="pi-eco-stat-card">
            <span className="pi-eco-stat-label">{copy.memoriesStatsPrefix}</span>
            <span className="pi-eco-stat-value">
              {overview.memoryCount} / {overview.compartmentCount} compartments
            </span>
          </div>
          <div className="pi-eco-stat-card">
            <span className="pi-eco-stat-label">{copy.tabSkills}</span>
            <span className="pi-eco-stat-value">
              {overview.skills.length} · {overview.commands.length} {copy.tabCommands}
            </span>
          </div>
        </div>
      ) : (
        <div className="set-field-desc">{copy.loading}</div>
      )}

      <section className="pi-eco-section">
        <h4 className="pi-eco-section-title">{copy.secRuntimeTitle}</h4>

        <div className="set-field set-field-top">
          <div className="set-field-text">
            <div className="set-field-stack">
              <div className="set-field-label">{copy.engineLabel}</div>
              <div className="set-field-desc">{copy.engineDesc}</div>
            </div>
            <div className="pi-eco-seg" role="radiogroup" aria-label={copy.engineLabel}>
              <button
                type="button"
                className={`pi-eco-seg-btn${prefs.engine === 'pi' ? ' active' : ''}`}
                disabled={busy || Boolean(overview?.envOverrideLegacy)}
                onClick={() => void commitPrefs({ engine: 'pi' })}
              >
                {copy.enginePi}
              </button>
              <button
                type="button"
                className={`pi-eco-seg-btn${prefs.engine === 'legacy' ? ' active' : ''}`}
                disabled={busy || Boolean(overview?.envOverrideLegacy)}
                onClick={() => void commitPrefs({ engine: 'legacy' })}
              >
                {copy.engineLegacy}
              </button>
            </div>
          </div>
        </div>

        <ToggleRow
          label={copy.mcEnabledLabel}
          description={copy.mcEnabledDesc}
          checked={prefs.magicContextEnabled}
          disabled={busy}
          onToggle={() =>
            void commitPrefs({ magicContextEnabled: !prefsRef.current.magicContextEnabled })
          }
        />

        <div className="set-field set-field-top">
          <div className="set-field-text">
            <div className="set-field-stack">
              <div className="set-field-label">{copy.storageModeLabel}</div>
              <div className="set-field-desc">{copy.storageModeDesc}</div>
            </div>
            <div className="pi-eco-seg" role="radiogroup" aria-label={copy.storageModeLabel}>
              <button
                type="button"
                className={`pi-eco-seg-btn${
                  prefs.magicContextStorageMode === 'isolated' ? ' active' : ''
                }`}
                disabled={busy}
                onClick={() => void commitPrefs({ magicContextStorageMode: 'isolated' })}
              >
                {copy.storageIsolated}
              </button>
              <button
                type="button"
                className={`pi-eco-seg-btn${
                  prefs.magicContextStorageMode === 'shared' ? ' active' : ''
                }`}
                disabled={busy}
                onClick={() => void commitPrefs({ magicContextStorageMode: 'shared' })}
              >
                {copy.storageShared}
              </button>
            </div>
          </div>
        </div>

        <div className="set-field set-field-top">
          <div className="set-field-text">
            <div className="set-field-stack">
              <div className="set-field-label">{copy.embeddingLabel}</div>
              <div className="set-field-desc">{copy.embeddingDesc}</div>
            </div>
            <div className="pi-eco-seg" role="radiogroup" aria-label={copy.embeddingLabel}>
              <button
                type="button"
                className={`pi-eco-seg-btn${prefs.embeddingMode === 'off' ? ' active' : ''}`}
                disabled={busy}
                onClick={() => void commitPrefs({ embeddingMode: 'off' })}
              >
                {copy.embeddingOff}
              </button>
              <button
                type="button"
                className={`pi-eco-seg-btn${prefs.embeddingMode === 'local' ? ' active' : ''}`}
                disabled={busy}
                onClick={() => void commitPrefs({ embeddingMode: 'local' })}
              >
                {copy.embeddingLocal}
              </button>
            </div>
          </div>
        </div>

        <ToggleRow
          label={copy.dreamerLabel}
          description={copy.dreamerDesc}
          checked={prefs.dreamerEnabled}
          disabled={busy}
          onToggle={() => void commitPrefs({ dreamerEnabled: !prefsRef.current.dreamerEnabled })}
        />

        <div className="set-field set-field-top">
          <div className="set-field-text">
            <div className="set-field-stack">
              <div className="set-field-label">{copy.historianModelLabel}</div>
              <div className="set-field-desc">{copy.historianModelDesc}</div>
            </div>
            <div className="pi-eco-inline-input">
              <input
                type="text"
                className="set-input"
                value={historianDraft}
                placeholder={copy.modelPlaceholder}
                aria-label={copy.historianModelLabel}
                onChange={(e) => setHistorianDraft(e.target.value)}
                onBlur={() => {
                  const trimmed = historianDraft.trim()
                  if (trimmed !== prefsRef.current.historianModel) {
                    void commitPrefs({ historianModel: trimmed })
                  }
                }}
              />
              <button
                type="button"
                className="set-btn"
                disabled={busy}
                onClick={() => void commitPrefs({ historianModel: historianDraft.trim() })}
              >
                {copy.saveModelBtn}
              </button>
            </div>
          </div>
        </div>

        <div className="set-field set-field-top">
          <div className="set-field-text">
            <div className="set-field-stack">
              <div className="set-field-label">{copy.dreamerModelLabel}</div>
              <div className="set-field-desc">{copy.dreamerModelDesc}</div>
            </div>
            <div className="pi-eco-inline-input">
              <input
                type="text"
                className="set-input"
                value={dreamerDraft}
                placeholder={copy.modelPlaceholder}
                aria-label={copy.dreamerModelLabel}
                onChange={(e) => setDreamerDraft(e.target.value)}
                onBlur={() => {
                  const trimmed = dreamerDraft.trim()
                  if (trimmed !== prefsRef.current.dreamerModel) {
                    void commitPrefs({ dreamerModel: trimmed })
                  }
                }}
              />
              <button
                type="button"
                className="set-btn"
                disabled={busy}
                onClick={() => void commitPrefs({ dreamerModel: dreamerDraft.trim() })}
              >
                {copy.saveModelBtn}
              </button>
            </div>
          </div>
        </div>

        <ToggleRow
          label={copy.readToolsLabel}
          description={copy.readToolsDesc}
          checked={prefs.enablePiReadTools}
          disabled={busy}
          onToggle={() =>
            void commitPrefs({ enablePiReadTools: !prefsRef.current.enablePiReadTools })
          }
        />

        <ToggleRow
          label={copy.writeToolsLabel}
          description={copy.writeToolsDesc}
          checked={prefs.enablePiWriteTools}
          disabled={busy}
          onToggle={() =>
            void commitPrefs({ enablePiWriteTools: !prefsRef.current.enablePiWriteTools })
          }
        />

        <ToggleRow
          label={copy.temporalLabel}
          description={copy.temporalDesc}
          checked={prefs.temporalAwareness}
          disabled={busy}
          onToggle={() =>
            void commitPrefs({ temporalAwareness: !prefsRef.current.temporalAwareness })
          }
        />

        <ToggleRow
          label={copy.autoHintsLabel}
          description={copy.autoHintsDesc}
          checked={prefs.autoSearchHints}
          disabled={busy}
          onToggle={() =>
            void commitPrefs({ autoSearchHints: !prefsRef.current.autoSearchHints })
          }
        />
      </section>

      <section className="pi-eco-section" data-testid="pi-system-prompt-section">
        <div className="pi-eco-section-head">
          <h4 className="pi-eco-section-title">{copy.secSystemPromptTitle}</h4>
          <div className="pi-eco-prompt-meta">
            <span
              className="pi-eco-prompt-badge"
              data-custom={isCustomPrompt ? 'true' : 'false'}
              data-testid="pi-system-prompt-badge"
            >
              {isCustomPrompt ? copy.systemPromptBadgeCustom : copy.systemPromptBadgeDefault}
            </span>
            <span className="pi-eco-prompt-count">
              {promptDraft.length} / {MAX_PI_SYSTEM_PROMPT_CHARS}
            </span>
          </div>
        </div>
        <div className="set-field-desc">{copy.systemPromptDesc}</div>
        <textarea
          className="pi-eco-prompt-textarea"
          data-testid="pi-system-prompt-textarea"
          aria-label={copy.secSystemPromptTitle}
          value={promptDraft}
          maxLength={MAX_PI_SYSTEM_PROMPT_CHARS}
          placeholder={copy.systemPromptPlaceholder}
          disabled={busy}
          onChange={(e) => setPromptDraft(e.target.value)}
        />
        <div className="pi-eco-prompt-actions">
          <button
            type="button"
            className="set-btn primary"
            data-testid="pi-system-prompt-save"
            disabled={busy || !hasPromptChanges}
            onClick={handleSavePrompt}
          >
            {copy.savePromptBtn}
          </button>
          <button
            type="button"
            className="set-btn"
            data-testid="pi-system-prompt-reset"
            disabled={busy || !canResetPrompt}
            onClick={handleResetPrompt}
          >
            {copy.resetPromptBtn}
          </button>
        </div>
      </section>

      <section className="pi-eco-section">
        <div className="pi-eco-section-head">
          <h4 className="pi-eco-section-title">{copy.secPackagesTitle}</h4>
          <button
            type="button"
            className="set-btn"
            disabled={busy || !overview || overview.packages.length === 0}
            onClick={() => handleUpdatePackages()}
          >
            {copy.updateAllBtn}
          </button>
        </div>
        <div className="set-field-desc">{copy.packagesDesc}</div>
        <div className="pi-eco-inline-input">
          <input
            type="text"
            className="set-input"
            value={packageInput}
            placeholder={copy.packagePlaceholder}
            aria-label={copy.secPackagesTitle}
            onChange={(e) => setPackageInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleInstallPackage()
            }}
          />
          <button
            type="button"
            className="set-btn primary"
            disabled={busy || packageInput.trim().length === 0}
            onClick={handleInstallPackage}
          >
            {copy.installBtn}
          </button>
        </div>

        {overview && overview.extensionErrors.length > 0 && (
          <div className="pi-eco-banner" data-kind="error">
            <strong>{copy.extensionErrorsTitle}:</strong>{' '}
            {overview.extensionErrors.map((err) => `${err.path}: ${err.error}`).join(' | ')}
          </div>
        )}

        {overview && overview.packages.length === 0 ? (
          <div className="set-field-desc">{copy.packagesEmpty}</div>
        ) : (
          <div className="pi-eco-card-list">
            {(overview?.packages ?? []).map((pkg) => (
              <div key={`${pkg.scope}:${pkg.source}`} className="pi-eco-card">
                <div className="pi-eco-card-row">
                  <div className="pi-eco-card-main">
                    <div className="pi-eco-card-title">{pkg.source}</div>
                    <div className="pi-eco-card-meta">
                      {pkg.scope}
                      {pkg.filtered ? ` · ${copy.packageFilteredTag}` : ''}
                      {pkg.installedPath ? ` · ${pkg.installedPath}` : ''}
                    </div>
                  </div>
                  <div className="pi-eco-card-actions">
                    <button
                      type="button"
                      className="set-btn"
                      disabled={busy}
                      onClick={() => handleUpdatePackages(pkg.source)}
                    >
                      {copy.updateBtn}
                    </button>
                    <button
                      type="button"
                      className="set-btn danger"
                      disabled={busy}
                      onClick={() => void handleRemovePackage(pkg.source)}
                    >
                      {copy.removeBtn}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="pi-eco-section">
        <div className="pi-eco-section-head">
          <h4 className="pi-eco-section-title">{copy.secInventoryTitle}</h4>
          <div className="pi-eco-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={inventoryTab === 'extensions'}
              className={`pi-eco-tab${inventoryTab === 'extensions' ? ' active' : ''}`}
              onClick={() => setInventoryTab('extensions')}
            >
              {copy.tabExtensions} ({overview?.extensions.length ?? 0})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={inventoryTab === 'skills'}
              className={`pi-eco-tab${inventoryTab === 'skills' ? ' active' : ''}`}
              onClick={() => setInventoryTab('skills')}
            >
              {copy.tabSkills} ({overview?.skills.length ?? 0})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={inventoryTab === 'commands'}
              className={`pi-eco-tab${inventoryTab === 'commands' ? ' active' : ''}`}
              onClick={() => setInventoryTab('commands')}
            >
              {copy.tabCommands} ({overview?.commands.length ?? 0})
            </button>
          </div>
        </div>

        <div className="pi-eco-card-list">
          {inventoryTab === 'extensions' &&
            (overview?.extensions.length ? (
              overview.extensions.map((ext) => (
                <div key={ext.path} className="pi-eco-card">
                  <div className="pi-eco-card-title">{ext.source}</div>
                  <div className="pi-eco-card-meta">{ext.path}</div>
                  <div className="pi-eco-card-meta">
                    {copy.toolsPrefix}: {ext.toolNames.join(', ') || '—'} · {copy.commandsPrefix}:{' '}
                    {ext.commandNames.join(', ') || '—'}
                  </div>
                </div>
              ))
            ) : (
              <div className="set-field-desc">{copy.inventoryEmpty}</div>
            ))}

          {inventoryTab === 'skills' &&
            (overview?.skills.length ? (
              overview.skills.map((skill) => (
                <div key={`${skill.name}:${skill.filePath}`} className="pi-eco-card">
                  <div className="pi-eco-card-row">
                    <div className="pi-eco-card-main">
                      <div className="pi-eco-card-title">{skill.name}</div>
                      {skill.description && (
                        <div className="pi-eco-card-body">{skill.description}</div>
                      )}
                      <div className="pi-eco-card-meta">{skill.filePath}</div>
                    </div>
                    <span className="pi-eco-pill">{skill.sourceKind}</span>
                  </div>
                </div>
              ))
            ) : (
              <div className="set-field-desc">{copy.inventoryEmpty}</div>
            ))}

          {inventoryTab === 'commands' &&
            (overview?.commands.length ? (
              overview.commands.map((cmd) => (
                <div key={`${cmd.name}:${cmd.source}`} className="pi-eco-card">
                  <div className="pi-eco-card-row">
                    <div className="pi-eco-card-main">
                      <div className="pi-eco-card-title">/{cmd.name}</div>
                      {cmd.description && (
                        <div className="pi-eco-card-body">{cmd.description}</div>
                      )}
                    </div>
                    <span className="pi-eco-pill">{cmd.source}</span>
                  </div>
                </div>
              ))
            ) : (
              <div className="set-field-desc">{copy.inventoryEmpty}</div>
            ))}
        </div>
      </section>

      <section className="pi-eco-section">
        <div className="pi-eco-section-head">
          <h4 className="pi-eco-section-title">{copy.secMemoriesTitle}</h4>
          <select
            className="pi-eco-select"
            aria-label={copy.secMemoriesTitle}
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          >
            <option value="all">{copy.memoriesFilterAll}</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
        </div>

        {overview && !overview.nodeSqliteSupported && (
          <div className="pi-eco-banner" data-kind="error">
            {copy.memoriesSqliteUnsupported}
          </div>
        )}

        {visibleMemories.length === 0 ? (
          <div className="set-field-desc">{copy.memoriesEmpty}</div>
        ) : (
          <div className="pi-eco-card-list">
            {visibleMemories.map((mem) => (
              <div key={mem.id} className="pi-eco-card">
                <div className="pi-eco-card-row">
                  <div className="pi-eco-card-main">
                    <div className="pi-eco-card-meta">
                      <span className="pi-eco-pill">{mem.category}</span> · {mem.projectIdentity}
                      {mem.importance !== undefined
                        ? ` · ${copy.importanceLabel} ${mem.importance}`
                        : ''}{' '}
                      · {formatMemoryDate(mem.updatedAt ?? mem.createdAt)}
                    </div>
                    <div className="pi-eco-card-body">{mem.content}</div>
                  </div>
                  <button
                    type="button"
                    className="set-btn danger"
                    disabled={busy}
                    onClick={() => void handleDeleteMemory(mem.id)}
                  >
                    {copy.deleteMemoryBtn}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="pi-eco-section">
        <div className="pi-eco-section-head">
          <h4 className="pi-eco-section-title">{copy.secDiagnosticsTitle}</h4>
          <button
            type="button"
            className="set-btn"
            disabled={busy}
            onClick={handleRunDiagnostics}
          >
            {copy.runDiagnosticsBtn}
          </button>
        </div>
        <div className="set-field-desc">{copy.diagnosticsDesc}</div>

        {overview && (
          <div className="pi-eco-paths">
            <div>agentDir: {overview.agentDir}</div>
            <div>storageDir: {overview.storageDir}</div>
            <div>shimPath: {overview.shimPath}</div>
          </div>
        )}

        {diagItems.length > 0 && (
          <div className="pi-eco-card-list">
            {diagItems.map((item) => (
              <div key={item.id} className="pi-eco-card">
                <div className="pi-eco-card-row">
                  <div className="pi-eco-card-main">
                    <div className="pi-eco-card-title">{item.label}</div>
                    <div className="pi-eco-card-meta">{item.detail}</div>
                  </div>
                  <span className="pi-eco-badge" data-ok={item.ok ? 'true' : 'false'}>
                    {item.ok ? copy.badgeOk : copy.badgeFail}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {confirmDialog}
    </div>
  )
}
