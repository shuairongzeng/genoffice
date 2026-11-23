import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type {
  ButlerArtifactRef,
  ButlerConversationEntry,
  ButlerDecisionItem,
  ButlerDecisionKind,
  ButlerDecisionOption,
  ButlerDeskSnapshot,
  ButlerMission,
  ButlerMissionReport,
  ButlerMissionStatus,
  ButlerOpenDeskPayload,
  ButlerSubTask,
  ButlerSubTaskStatus,
  ButlerWorkerRole,
} from '../../shared/butler-orchestrator-api'
import { BUTLER_CHIEF_SESSION_KEY } from '../../shared/butler-orchestrator-api'
import type { HomeApi } from '../../shared/home-api'
import { stepLabelKey } from './butler-hud-model'
import { FileBadge } from './file-badge'
import { useI18n, type StringKey } from './locale'
import './butler-desk.css'

export interface ButlerDeskViewProps {
  readonly focusTarget?: ButlerOpenDeskPayload | null
  readonly onPreviewFile?: (filePath: string) => void
  readonly onOpenFile?: (filePath: string) => void
}

const MAX_RECENT_RESOLVED = 5

const EMPTY_SNAPSHOT: ButlerDeskSnapshot = {
  chiefSessionKey: BUTLER_CHIEF_SESSION_KEY,
  chiefBusy: false,
  missions: [],
  tasks: [],
  decisions: [],
  feed: [],
  concurrency: { running: 0, maxConcurrent: 3, queued: 0 },
}

const ACTIVE_MISSION_STATUSES = new Set<ButlerMissionStatus>([
  'planning',
  'running',
  'waiting_human',
  'synthesizing',
])

const ACTIVE_SUBTASK_STATUSES = new Set<ButlerSubTaskStatus>(['queued', 'running', 'waiting_human'])

const STEERABLE_SUBTASK_STATUSES = new Set<ButlerSubTaskStatus>([
  'queued',
  'running',
  'waiting_human',
  'interrupted',
  'failed',
])

const DECISION_KIND_LABEL_KEYS: Record<ButlerDecisionKind, StringKey> = {
  permission: 'butlerDecisionKindPermission',
  choice: 'butlerDecisionKindChoice',
  recovery: 'butlerDecisionKindRecovery',
}

const ROLE_LABEL_KEYS: Record<ButlerWorkerRole, StringKey> = {
  general: 'butlerRoleGeneral',
  research: 'butlerRoleResearch',
  docs: 'butlerRoleDocs',
  sheets: 'butlerRoleSheets',
  slides: 'butlerRoleSlides',
  browser: 'butlerRoleBrowser',
}

const SUBTASK_STATUS_LABEL_KEYS: Record<ButlerSubTaskStatus, StringKey> = {
  queued: 'butlerTaskStatusQueued',
  running: 'butlerTaskStatusRunning',
  waiting_human: 'butlerTaskStatusWaitingHuman',
  done: 'butlerTaskStatusDone',
  failed: 'butlerTaskStatusFailed',
  cancelled: 'butlerTaskStatusCancelled',
  interrupted: 'butlerTaskStatusInterrupted',
}

const MISSION_STATUS_LABEL_KEYS: Record<ButlerMissionStatus, StringKey> = {
  planning: 'butlerDeskSending',
  running: 'butlerTaskStatusRunning',
  waiting_human: 'butlerTaskStatusWaitingHuman',
  synthesizing: 'butlerDeskChiefBusy',
  done: 'butlerTaskStatusDone',
  failed: 'butlerTaskStatusFailed',
  cancelled: 'butlerTaskStatusCancelled',
  interrupted: 'butlerTaskStatusInterrupted',
}

/** Return true when a mission has not yet reached a terminal state. */
export function isMissionActive(status: ButlerMissionStatus): boolean {
  return ACTIVE_MISSION_STATUSES.has(status)
}

/** Return true when a background subtask is queued, running, or waiting for approval. */
export function isSubTaskActive(status: ButlerSubTaskStatus): boolean {
  return ACTIVE_SUBTASK_STATUSES.has(status)
}

/** Return true when a subtask can still receive steering guidance. */
export function canSteerSubTask(status: ButlerSubTaskStatus): boolean {
  return STEERABLE_SUBTASK_STATUSES.has(status)
}

/** Map a decision item kind to its localized badge key. */
export function decisionKindLabelKey(kind: ButlerDecisionKind): StringKey {
  return DECISION_KIND_LABEL_KEYS[kind] ?? 'butlerDecisionKindChoice'
}

/** Map a specialist worker role to its localized badge key. */
export function workerRoleLabelKey(role: ButlerWorkerRole): StringKey {
  return ROLE_LABEL_KEYS[role] ?? 'butlerRoleGeneral'
}

/** Map a subtask status to its localized badge key. */
export function subTaskStatusLabelKey(status: ButlerSubTaskStatus): StringKey {
  return SUBTASK_STATUS_LABEL_KEYS[status] ?? 'butlerTaskStatusInterrupted'
}

/** Map a mission status to its localized badge key. */
export function missionStatusLabelKey(status: ButlerMissionStatus): StringKey {
  return MISSION_STATUS_LABEL_KEYS[status] ?? 'butlerTaskStatusInterrupted'
}

/**
 * Split decision items into FIFO-ordered pending items awaiting human action
 * and a capped list of recently resolved/closed items (newest first).
 */
export function splitDecisionsForInbox(decisions: readonly ButlerDecisionItem[]): {
  readonly pending: readonly ButlerDecisionItem[]
  readonly recentResolved: readonly ButlerDecisionItem[]
} {
  const pending: ButlerDecisionItem[] = []
  const resolved: ButlerDecisionItem[] = []

  for (const item of decisions) {
    if (item.status === 'pending') {
      pending.push(item)
    } else {
      resolved.push(item)
    }
  }

  pending.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  resolved.sort((a, b) => {
    const timeA = a.resolution?.resolvedAt ?? a.createdAt
    const timeB = b.resolution?.resolvedAt ?? b.createdAt
    return timeB - timeA || a.id.localeCompare(b.id)
  })

  return {
    pending,
    recentResolved: resolved.slice(0, MAX_RECENT_RESOLVED),
  }
}

/**
 * Map built-in permission option IDs (`allow`, `allow-once`, `allow-session`,
 * `deny`) to localized labels while preserving custom choice/recovery labels.
 */
export function formatDecisionOptionLabel(
  _decision: ButlerDecisionItem,
  option: ButlerDecisionOption,
  t: ReturnType<typeof useI18n>['t'],
): string {
  switch (option.id) {
    case 'allow':
    case 'allow-once':
    case 'allow_once':
      return t('butlerDecisionAllowOnce')
    case 'allow-session':
    case 'allow_session':
      return t('butlerDecisionAllowSession')
    case 'deny':
      return t('butlerDecisionDeny')
    default:
      return option.label.trim() || option.id
  }
}

/** Count done, active, and total subtasks belonging to a mission. */
export function missionTaskProgress(
  mission: ButlerMission,
  tasksById: ReadonlyMap<string, ButlerSubTask>,
): { readonly done: number; readonly total: number; readonly active: number } {
  let done = 0
  let active = 0

  for (const taskId of mission.taskIds) {
    const task = tasksById.get(taskId)
    if (!task) continue
    if (task.status === 'done') done += 1
    else if (isSubTaskActive(task.status)) active += 1
  }

  return {
    done,
    total: mission.taskIds.length,
    active,
  }
}

function getAiOfficeApi(): Partial<HomeApi> | undefined {
  if (typeof window === 'undefined') return undefined
  return window.aiOffice as Partial<HomeApi> | undefined
}

function extractFileExt(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? ''
  const dotIdx = base.lastIndexOf('.')
  return dotIdx > 0 ? base.slice(dotIdx + 1).toLowerCase() : ''
}

function formatClock(ts: number, dateLocale: string): string {
  try {
    return new Intl.DateTimeFormat(dateLocale, {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ts))
  } catch {
    return ''
  }
}

function formatSubTaskLiveNote(task: ButlerSubTask, t: ReturnType<typeof useI18n>['t']): string {
  const stepText = task.step
    ? `${t(stepLabelKey(task.step.kind))}${task.step.tool ? ` · ${task.step.tool}` : ''}`
    : ''
  const note = task.progressNote?.trim() ?? ''
  if (note && stepText) return `${stepText} — ${note}`
  if (note) return note
  if (stepText) return stepText
  return task.outputSummary?.trim() ?? ''
}

function sortMissionsForDesk(missions: readonly ButlerMission[]): ButlerMission[] {
  return [...missions].sort((a, b) => {
    const activeA = isMissionActive(a.status) ? 0 : 1
    const activeB = isMissionActive(b.status) ? 0 : 1
    if (activeA !== activeB) return activeA - activeB
    const timeA = a.updatedAt || a.createdAt
    const timeB = b.updatedAt || b.createdAt
    return timeB - timeA || a.id.localeCompare(b.id)
  })
}

function errorMessageFrom(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message
  if (typeof err === 'string' && err.trim()) return err
  return 'Request failed'
}

function isImeComposing(e: ReactKeyboardEvent<HTMLElement>, composingFlag: boolean): boolean {
  return composingFlag || e.nativeEvent.isComposing || e.keyCode === 229
}

function ReactorGlyph({ busy }: { readonly busy: boolean }): React.JSX.Element {
  return (
    <span className={`butler-desk-reactor${busy ? ' is-busy' : ''}`} aria-hidden="true">
      <svg className="butler-desk-reactor-svg" viewBox="0 0 24 24" fill="none">
        <circle
          cx="12"
          cy="12"
          r="9.25"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeOpacity="0.32"
        />
        <g className="butler-desk-reactor-arc">
          <path
            d="M12 2.75A9.25 9.25 0 0 1 20 7.4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M12 21.25A9.25 9.25 0 0 1 4 16.6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </g>
        <circle
          cx="12"
          cy="12"
          r="4.8"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeOpacity="0.7"
        />
        <circle cx="12" cy="12" r="2.1" fill="currentColor" />
      </svg>
    </span>
  )
}

function ArtifactRow({
  artifact,
  onPreviewFile,
  onOpenFile,
}: {
  readonly artifact: ButlerArtifactRef
  readonly onPreviewFile?: (filePath: string) => void
  readonly onOpenFile?: (filePath: string) => void
}): React.JSX.Element {
  const { t } = useI18n()

  const handleOpen = useCallback(() => {
    if (onOpenFile) {
      onOpenFile(artifact.path)
      return
    }
    void getAiOfficeApi()?.openPath?.(artifact.path)
  }, [artifact.path, onOpenFile])

  return (
    <div
      className={`butler-artifact-row${artifact.existsOnDisk ? '' : ' is-missing'}`}
      data-testid="butler-artifact-row"
      data-exists={String(artifact.existsOnDisk)}
    >
      <div className="butler-artifact-info">
        <FileBadge ext={extractFileExt(artifact.path)} size={20} />
        <div className="butler-artifact-text">
          <span className="butler-artifact-label">{artifact.label}</span>
          <span className="butler-artifact-path" title={artifact.path}>
            {artifact.path}
          </span>
        </div>
      </div>

      <div className="butler-artifact-actions">
        {artifact.existsOnDisk ? (
          <>
            <button
              type="button"
              className="butler-btn is-compact"
              data-testid="butler-artifact-preview-btn"
              onClick={() => onPreviewFile?.(artifact.path)}
            >
              {t('butlerReportPreview')}
            </button>
            <button
              type="button"
              className="butler-btn is-compact is-primary"
              data-testid="butler-artifact-open-btn"
              onClick={handleOpen}
            >
              {t('butlerReportOpenFile')}
            </button>
          </>
        ) : (
          <span className="butler-artifact-missing-pill" data-testid="butler-artifact-missing">
            {t('butlerReportMissingFile')}
          </span>
        )}
      </div>
    </div>
  )
}

function ReportCard({
  report,
  onPreviewFile,
  onOpenFile,
}: {
  readonly report: ButlerMissionReport
  readonly onPreviewFile?: (filePath: string) => void
  readonly onOpenFile?: (filePath: string) => void
}): React.JSX.Element {
  const { t } = useI18n()

  return (
    <section className="butler-report-card" data-testid="butler-report-card">
      <div className="butler-report-head">
        <span className="butler-report-kicker">{t('butlerReportTitle')}</span>
        <h3 className="butler-report-headline">{report.headline}</h3>
      </div>

      <p className="butler-report-summary">{report.summary}</p>

      {report.risks.length > 0 && (
        <div className="butler-report-section">
          <h4 className="butler-report-section-title">{t('butlerReportRisks')}</h4>
          <ul className="butler-report-risks">
            {report.risks.map((risk, idx) => (
              <li key={`${idx}-${risk}`}>{risk}</li>
            ))}
          </ul>
        </div>
      )}

      {report.artifacts.length > 0 && (
        <div className="butler-report-section">
          <h4 className="butler-report-section-title">{t('butlerReportArtifacts')}</h4>
          <div className="butler-report-artifacts">
            {report.artifacts.map((artifact) => (
              <ArtifactRow
                key={`${artifact.path}:${artifact.label}`}
                artifact={artifact}
                onPreviewFile={onPreviewFile}
                onOpenFile={onOpenFile}
              />
            ))}
          </div>
        </div>
      )}

      {report.nextSuggestion && (
        <div className="butler-report-next">
          <span className="butler-report-next-label">{t('butlerReportNext')}</span>
          <span>{report.nextSuggestion}</span>
        </div>
      )}
    </section>
  )
}

function DecisionCard({
  decision,
  focused,
  note,
  submitting,
  error,
  onNoteChange,
  onResolve,
}: {
  readonly decision: ButlerDecisionItem
  readonly focused: boolean
  readonly note: string
  readonly submitting: boolean
  readonly error?: string
  readonly onNoteChange: (decisionId: string, nextNote: string) => void
  readonly onResolve: (decisionId: string, optionId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()

  return (
    <article
      className={`butler-decision-card${focused ? ' is-focused' : ''}`}
      data-testid="butler-decision-card"
      data-decision-id={decision.id}
    >
      <div className="butler-decision-card-head">
        <span className="butler-decision-kind-badge" data-kind={decision.kind}>
          {t(decisionKindLabelKey(decision.kind))}
        </span>
        {decision.toolName && (
          <span className="butler-decision-tool" title={decision.toolName}>
            {decision.toolName}
          </span>
        )}
      </div>

      <h3 className="butler-decision-title">{decision.title}</h3>
      <p className="butler-decision-summary">{decision.summary}</p>

      {decision.detail && <pre className="butler-decision-detail">{decision.detail}</pre>}

      <input
        type="text"
        className="butler-decision-note"
        data-testid="butler-decision-note"
        value={note}
        disabled={submitting}
        placeholder={t('butlerDecisionNotePlaceholder')}
        onChange={(e) => onNoteChange(decision.id, e.target.value)}
      />

      {error && <div className="butler-subtask-error">{error}</div>}

      <div className="butler-decision-options">
        {decision.options.map((option) => {
          const styleClass =
            option.style === 'primary'
              ? ' is-primary'
              : option.style === 'danger'
                ? ' is-danger'
                : ''
          return (
            <button
              key={option.id}
              type="button"
              className={`butler-btn${styleClass}`}
              data-testid={`butler-decision-opt-${option.id}`}
              title={option.description}
              disabled={submitting}
              onClick={() => onResolve(decision.id, option.id)}
            >
              {submitting
                ? t('butlerDecisionSubmitting')
                : formatDecisionOptionLabel(decision, option, t)}
            </button>
          )
        })}
      </div>
    </article>
  )
}

function SubTaskRow({
  task,
  tasksById,
  cancelling,
  steering,
  steerOpen,
  steerDraft,
  steerError,
  onToggleSteer,
  onSteerDraftChange,
  onSubmitSteer,
  onCancelTask,
}: {
  readonly task: ButlerSubTask
  readonly tasksById: ReadonlyMap<string, ButlerSubTask>
  readonly cancelling: boolean
  readonly steering: boolean
  readonly steerOpen: boolean
  readonly steerDraft: string
  readonly steerError?: string
  readonly onToggleSteer: (taskId: string) => void
  readonly onSteerDraftChange: (taskId: string, value: string) => void
  readonly onSubmitSteer: (taskId: string) => void
  readonly onCancelTask: (taskId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const composingRef = useRef(false)
  const liveNote = formatSubTaskLiveNote(task, t)
  const depLabels = task.dependsOn.map((depId) => tasksById.get(depId)?.title ?? depId)

  return (
    <div className="butler-subtask-row" data-task-id={task.id}>
      <div className="butler-subtask-head">
        <div className="butler-subtask-badges">
          <span className="butler-role-badge">{t(workerRoleLabelKey(task.role))}</span>
          <span className="butler-status-badge" data-status={task.status}>
            {t(subTaskStatusLabelKey(task.status))}
          </span>
        </div>
      </div>

      <p className="butler-subtask-title">{task.title}</p>

      {liveNote && <p className="butler-subtask-note">{liveNote}</p>}

      {depLabels.length > 0 && (
        <p className="butler-subtask-deps">
          {t('butlerTaskDependsOn', { deps: depLabels.join(', ') })}
        </p>
      )}

      {task.error && <p className="butler-subtask-error">{task.error}</p>}

      <div className="butler-subtask-foot">
        {task.artifacts.length > 0 && (
          <span className="butler-subtask-artifacts-count">
            {t('butlerReportArtifacts')}: {task.artifacts.length}
          </span>
        )}
        <div className="butler-subtask-actions">
          {canSteerSubTask(task.status) && (
            <button
              type="button"
              className="butler-btn is-compact"
              onClick={() => onToggleSteer(task.id)}
            >
              {t('butlerTaskSteer')}
            </button>
          )}
          {isSubTaskActive(task.status) && (
            <button
              type="button"
              className="butler-btn is-compact is-danger"
              disabled={cancelling}
              onClick={() => onCancelTask(task.id)}
            >
              {t('butlerTaskCancel')}
            </button>
          )}
        </div>
      </div>

      {steerOpen && (
        <>
          <div className="butler-steer-row">
            <input
              type="text"
              className="butler-steer-input"
              data-testid="butler-steer-input"
              value={steerDraft}
              disabled={steering}
              placeholder={t('butlerTaskSteerPlaceholder')}
              onCompositionStart={() => {
                composingRef.current = true
              }}
              onCompositionEnd={() => {
                composingRef.current = false
              }}
              onChange={(e) => onSteerDraftChange(task.id, e.target.value)}
              onKeyDown={(e) => {
                if (isImeComposing(e, composingRef.current)) return
                if (e.key === 'Enter' && steerDraft.trim()) {
                  e.preventDefault()
                  onSubmitSteer(task.id)
                } else if (e.key === 'Escape') {
                  onToggleSteer(task.id)
                }
              }}
            />
            <button
              type="button"
              className="butler-btn is-compact is-primary"
              data-testid="butler-steer-submit"
              disabled={steering || steerDraft.trim().length === 0}
              onClick={() => onSubmitSteer(task.id)}
            >
              {t('butlerTaskSteer')}
            </button>
          </div>
          {steerError && <p className="butler-subtask-error">{steerError}</p>}
        </>
      )}
    </div>
  )
}

function MissionCard({
  mission,
  tasksById,
  expanded,
  focused,
  cancellingMission,
  cancellingTasks,
  steeringTasks,
  openSteerTaskIds,
  steerDrafts,
  steerErrors,
  onToggleExpand,
  onCancelMission,
  onToggleSteer,
  onSteerDraftChange,
  onSubmitSteer,
  onCancelTask,
}: {
  readonly mission: ButlerMission
  readonly tasksById: ReadonlyMap<string, ButlerSubTask>
  readonly expanded: boolean
  readonly focused: boolean
  readonly cancellingMission: boolean
  readonly cancellingTasks: ReadonlySet<string>
  readonly steeringTasks: ReadonlySet<string>
  readonly openSteerTaskIds: ReadonlySet<string>
  readonly steerDrafts: Readonly<Record<string, string>>
  readonly steerErrors: Readonly<Record<string, string>>
  readonly onToggleExpand: (missionId: string, currentExpanded: boolean) => void
  readonly onCancelMission: (missionId: string) => void
  readonly onToggleSteer: (taskId: string) => void
  readonly onSteerDraftChange: (taskId: string, value: string) => void
  readonly onSubmitSteer: (taskId: string) => void
  readonly onCancelTask: (taskId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const progress = missionTaskProgress(mission, tasksById)
  const subtasks = mission.taskIds
    .map((id) => tasksById.get(id))
    .filter((item): item is ButlerSubTask => item !== undefined)

  return (
    <article
      className={`butler-mission-card${focused ? ' is-focused' : ''}`}
      data-mission-id={mission.id}
    >
      <div className="butler-mission-head">
        <div className="butler-mission-top-row">
          <div className="butler-mission-title-wrap">
            <h3 className="butler-mission-title">{mission.title || mission.goal}</h3>
            <div className="butler-mission-meta">
              <span className="butler-status-badge" data-status={mission.status}>
                {t(missionStatusLabelKey(mission.status))}
              </span>
              <span>
                {progress.done}/{progress.total}
              </span>
            </div>
          </div>

          <div className="butler-mission-controls">
            {isMissionActive(mission.status) && (
              <button
                type="button"
                className="butler-btn is-compact is-danger"
                disabled={cancellingMission}
                onClick={() => onCancelMission(mission.id)}
              >
                {t('butlerMissionCancel')}
              </button>
            )}
            <button
              type="button"
              className="butler-btn is-compact"
              aria-expanded={expanded}
              onClick={() => onToggleExpand(mission.id, expanded)}
            >
              {expanded ? t('butlerMissionsToggleCollapse') : t('butlerMissionsToggleExpand')}
            </button>
          </div>
        </div>

        {mission.error && <p className="butler-subtask-error">{mission.error}</p>}
      </div>

      {expanded && subtasks.length > 0 && (
        <div className="butler-mission-subtasks">
          {subtasks.map((task) => (
            <SubTaskRow
              key={task.id}
              task={task}
              tasksById={tasksById}
              cancelling={cancellingTasks.has(task.id)}
              steering={steeringTasks.has(task.id)}
              steerOpen={openSteerTaskIds.has(task.id)}
              steerDraft={steerDrafts[task.id] ?? ''}
              steerError={steerErrors[task.id]}
              onToggleSteer={onToggleSteer}
              onSteerDraftChange={onSteerDraftChange}
              onSubmitSteer={onSubmitSteer}
              onCancelTask={onCancelTask}
            />
          ))}
        </div>
      )}
    </article>
  )
}

function FeedEntryRow({
  entry,
  dateLocale,
  onPreviewFile,
  onOpenFile,
}: {
  readonly entry: ButlerConversationEntry
  readonly dateLocale: string
  readonly onPreviewFile?: (filePath: string) => void
  readonly onOpenFile?: (filePath: string) => void
}): React.JSX.Element {
  const timeText = formatClock(entry.createdAt, dateLocale)
  const roleClass =
    entry.role === 'user' ? 'is-user' : entry.role === 'system' ? 'is-system' : 'is-butler'

  return (
    <div className={`butler-desk-entry ${roleClass}`} data-entry-role={entry.role}>
      {entry.text && <div className="butler-desk-bubble">{entry.text}</div>}
      {entry.report && (
        <ReportCard report={entry.report} onPreviewFile={onPreviewFile} onOpenFile={onOpenFile} />
      )}
      {timeText && <span className="butler-desk-entry-meta">{timeText}</span>}
    </div>
  )
}

/**
 * Chief Butler Dark Cockpit workbench: single-point executive dialogue +
 * report stream on the left, unified Decision Inbox and collapsible mission
 * supervisor board on the right.
 */
export function ButlerDeskView({
  focusTarget,
  onPreviewFile,
  onOpenFile,
}: ButlerDeskViewProps): React.JSX.Element {
  const { t, dateLocale } = useI18n()

  const [snapshot, setSnapshot] = useState<ButlerDeskSnapshot>(EMPTY_SNAPSHOT)
  const [goalInput, setGoalInput] = useState('')
  const [delegating, setDelegating] = useState(false)
  const [delegateError, setDelegateError] = useState<string | null>(null)
  const [missionActionError, setMissionActionError] = useState<string | null>(null)

  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({})
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(() => new Set())
  const [decisionErrors, setDecisionErrors] = useState<Record<string, string>>({})

  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({})
  const [cancellingMissionIds, setCancellingMissionIds] = useState<Set<string>>(() => new Set())
  const [cancellingTaskIds, setCancellingTaskIds] = useState<Set<string>>(() => new Set())
  const [openSteerTaskIds, setOpenSteerTaskIds] = useState<Set<string>>(() => new Set())
  const [steeringTaskIds, setSteeringTaskIds] = useState<Set<string>>(() => new Set())
  const [steerDrafts, setSteerDrafts] = useState<Record<string, string>>({})
  const [steerErrors, setSteerErrors] = useState<Record<string, string>>({})

  const rootRef = useRef<HTMLDivElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const composingGoalRef = useRef(false)

  useEffect(() => {
    const api = getAiOfficeApi()
    let alive = true
    let receivedPush = false

    const unsubscribe = api?.onButlerDeskUpdated?.((next) => {
      if (!alive) return
      receivedPush = true
      setSnapshot(next)
    })

    if (typeof api?.butlerDeskState === 'function') {
      void api
        .butlerDeskState()
        .then((initial) => {
          if (!alive || receivedPush || !initial) return
          setSnapshot(initial)
        })
        .catch((err: unknown) => {
          if (!alive) return
          setDelegateError(errorMessageFrom(err))
        })
    }

    return () => {
      alive = false
      unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    const container = feedRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, [snapshot.feed.length])

  useEffect(() => {
    if (!focusTarget) return
    const container = rootRef.current
    if (!container) return

    if (focusTarget.missionId) {
      setExpandedOverrides((prev) => ({
        ...prev,
        [focusTarget.missionId!]: true,
      }))
      const missionEl = [...container.querySelectorAll<HTMLElement>('[data-mission-id]')].find(
        (el) => el.dataset.missionId === focusTarget.missionId,
      )
      missionEl?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    }

    if (focusTarget.decisionId) {
      const decisionEl = [...container.querySelectorAll<HTMLElement>('[data-decision-id]')].find(
        (el) => el.dataset.decisionId === focusTarget.decisionId,
      )
      decisionEl?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    }
  }, [focusTarget])

  const tasksById = useMemo(() => {
    const map = new Map<string, ButlerSubTask>()
    for (const task of snapshot.tasks) {
      map.set(task.id, task)
    }
    return map
  }, [snapshot.tasks])

  const { pending: pendingDecisions, recentResolved } = useMemo(
    () => splitDecisionsForInbox(snapshot.decisions),
    [snapshot.decisions],
  )

  const sortedMissions = useMemo(() => sortMissionsForDesk(snapshot.missions), [snapshot.missions])

  const handleDelegate = useCallback(async () => {
    const trimmed = goalInput.trim()
    if (!trimmed || delegating) return

    const api = getAiOfficeApi()
    if (typeof api?.butlerDelegate !== 'function') {
      setDelegateError(t('butlerErrDisabled'))
      return
    }

    const draft = goalInput
    setDelegating(true)
    setDelegateError(null)
    setGoalInput('')

    try {
      const result = await api.butlerDelegate(trimmed)
      if (!result?.ok) {
        setGoalInput(draft)
        setDelegateError(result?.error || t('butlerErrFailed', { message: 'unknown' }))
      }
    } catch (err: unknown) {
      setGoalInput(draft)
      setDelegateError(errorMessageFrom(err))
    } finally {
      setDelegating(false)
    }
  }, [delegating, goalInput, t])

  const handleResolveDecision = useCallback(
    async (decisionId: string, optionId: string) => {
      if (resolvingIds.has(decisionId)) return
      const api = getAiOfficeApi()
      if (typeof api?.butlerResolveDecision !== 'function') return

      setResolvingIds((prev) => new Set(prev).add(decisionId))
      setDecisionErrors((prev) => {
        const next = { ...prev }
        delete next[decisionId]
        return next
      })

      const trimmedNote = decisionNotes[decisionId]?.trim()
      try {
        const res = await api.butlerResolveDecision({
          decisionId,
          optionId,
          ...(trimmedNote ? { note: trimmedNote } : {}),
        })
        if (!res?.ok) {
          setDecisionErrors((prev) => ({
            ...prev,
            [decisionId]: res?.error || 'Failed to apply decision',
          }))
        } else {
          setDecisionNotes((prev) => {
            const next = { ...prev }
            delete next[decisionId]
            return next
          })
        }
      } catch (err: unknown) {
        setDecisionErrors((prev) => ({
          ...prev,
          [decisionId]: errorMessageFrom(err),
        }))
      } finally {
        setResolvingIds((prev) => {
          const next = new Set(prev)
          next.delete(decisionId)
          return next
        })
      }
    },
    [decisionNotes, resolvingIds],
  )

  const handleCancelMission = useCallback(async (missionId: string) => {
    const api = getAiOfficeApi()
    if (typeof api?.butlerCancelMission !== 'function') return

    setMissionActionError(null)
    setCancellingMissionIds((prev) => new Set(prev).add(missionId))
    try {
      const res = await api.butlerCancelMission(missionId)
      if (!res?.ok) {
        setMissionActionError(res?.error || 'Failed to cancel mission')
      }
    } catch (err: unknown) {
      setMissionActionError(errorMessageFrom(err))
    } finally {
      setCancellingMissionIds((prev) => {
        const next = new Set(prev)
        next.delete(missionId)
        return next
      })
    }
  }, [])

  const handleCancelTask = useCallback(async (taskId: string) => {
    const api = getAiOfficeApi()
    if (typeof api?.butlerCancelTask !== 'function') return

    setMissionActionError(null)
    setCancellingTaskIds((prev) => new Set(prev).add(taskId))
    try {
      const res = await api.butlerCancelTask(taskId)
      if (!res?.ok) {
        setMissionActionError(res?.error || 'Failed to cancel subtask')
      }
    } catch (err: unknown) {
      setMissionActionError(errorMessageFrom(err))
    } finally {
      setCancellingTaskIds((prev) => {
        const next = new Set(prev)
        next.delete(taskId)
        return next
      })
    }
  }, [])

  const handleToggleSteer = useCallback((taskId: string) => {
    setOpenSteerTaskIds((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }, [])

  const handleSubmitSteer = useCallback(
    async (taskId: string) => {
      const instruction = steerDrafts[taskId]?.trim()
      if (!instruction || steeringTaskIds.has(taskId)) return

      const api = getAiOfficeApi()
      if (typeof api?.butlerSteerTask !== 'function') return

      setSteeringTaskIds((prev) => new Set(prev).add(taskId))
      setSteerErrors((prev) => {
        const next = { ...prev }
        delete next[taskId]
        return next
      })

      try {
        const res = await api.butlerSteerTask({ taskId, instruction })
        if (!res?.ok) {
          setSteerErrors((prev) => ({
            ...prev,
            [taskId]: res?.error || 'Failed to steer task',
          }))
        } else {
          setSteerDrafts((prev) => {
            const next = { ...prev }
            delete next[taskId]
            return next
          })
          setOpenSteerTaskIds((prev) => {
            const next = new Set(prev)
            next.delete(taskId)
            return next
          })
        }
      } catch (err: unknown) {
        setSteerErrors((prev) => ({
          ...prev,
          [taskId]: errorMessageFrom(err),
        }))
      } finally {
        setSteeringTaskIds((prev) => {
          const next = new Set(prev)
          next.delete(taskId)
          return next
        })
      }
    },
    [steerDrafts, steeringTaskIds],
  )

  return (
    <div className="butler-desk" ref={rootRef} data-testid="butler-desk-view">
      <header className="butler-desk-header">
        <div className="butler-desk-header-brand">
          <ReactorGlyph busy={snapshot.chiefBusy} />
          <div className="butler-desk-title-group">
            <h1 className="butler-desk-title">{t('butlerDeskTitle')}</h1>
            <p className="butler-desk-subtitle">{t('butlerDeskSubtitle')}</p>
          </div>
        </div>

        <div className="butler-desk-header-telemetry">
          <span className={`butler-desk-status-pill${snapshot.chiefBusy ? ' is-busy' : ''}`}>
            <span className="butler-desk-status-dot" aria-hidden="true" />
            {snapshot.chiefBusy ? t('butlerDeskChiefBusy') : t('butlerDeskChiefIdle')}
          </span>
          <span className="butler-desk-concurrency-pill" data-testid="butler-concurrency-pill">
            {t('butlerDeskConcurrency', {
              running: snapshot.concurrency.running,
              max: snapshot.concurrency.maxConcurrent,
              queued: snapshot.concurrency.queued,
            })}
          </span>
        </div>
      </header>

      <div className="butler-desk-body">
        <main className="butler-desk-main">
          <div className="butler-desk-feed" ref={feedRef} data-testid="butler-desk-feed">
            {snapshot.feed.length === 0 ? (
              <div className="butler-desk-empty">
                <div className="butler-desk-empty-icon" aria-hidden="true">
                  <ReactorGlyph busy={false} />
                </div>
                <h2 className="butler-desk-empty-title">{t('butlerDeskEmptyTitle')}</h2>
                <p className="butler-desk-empty-hint">{t('butlerDeskEmptyHint')}</p>
              </div>
            ) : (
              snapshot.feed.map((entry) => (
                <FeedEntryRow
                  key={entry.id}
                  entry={entry}
                  dateLocale={dateLocale}
                  onPreviewFile={onPreviewFile}
                  onOpenFile={onOpenFile}
                />
              ))
            )}
          </div>

          <div className="butler-desk-composer">
            {delegateError && (
              <div className="butler-desk-error-banner" role="alert">
                <span>{delegateError}</span>
              </div>
            )}
            <div className="butler-desk-composer-row">
              <textarea
                className="butler-desk-input"
                data-testid="butler-desk-input"
                rows={2}
                value={goalInput}
                disabled={delegating}
                placeholder={t('butlerDeskInputPlaceholder')}
                onCompositionStart={() => {
                  composingGoalRef.current = true
                }}
                onCompositionEnd={() => {
                  composingGoalRef.current = false
                }}
                onChange={(e) => setGoalInput(e.target.value)}
                onKeyDown={(e) => {
                  if (isImeComposing(e, composingGoalRef.current)) return
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void handleDelegate()
                  }
                }}
              />
              <button
                type="button"
                className="butler-desk-send-btn"
                data-testid="butler-desk-send-btn"
                disabled={delegating || goalInput.trim().length === 0}
                onClick={() => void handleDelegate()}
              >
                {delegating ? t('butlerDeskSending') : t('butlerDeskSend')}
              </button>
            </div>
          </div>
        </main>

        <aside className="butler-desk-aside">
          <section
            className={`butler-cockpit-panel${pendingDecisions.length > 0 ? ' has-pending' : ''}`}
            data-testid="butler-decision-inbox"
          >
            <div className="butler-cockpit-panel-head">
              <h2 className="butler-cockpit-panel-title">
                <span>{t('butlerDecisionInboxTitle')}</span>
                {pendingDecisions.length > 0 && (
                  <span className="butler-cockpit-count-badge">{pendingDecisions.length}</span>
                )}
              </h2>
            </div>

            {pendingDecisions.length === 0 ? (
              <p className="butler-cockpit-quiet">{t('butlerDecisionEmpty')}</p>
            ) : (
              <div className="butler-decision-list">
                {pendingDecisions.map((decision) => (
                  <DecisionCard
                    key={decision.id}
                    decision={decision}
                    focused={focusTarget?.decisionId === decision.id}
                    note={decisionNotes[decision.id] ?? ''}
                    submitting={resolvingIds.has(decision.id)}
                    error={decisionErrors[decision.id]}
                    onNoteChange={(id, value) =>
                      setDecisionNotes((prev) => ({ ...prev, [id]: value }))
                    }
                    onResolve={(id, optionId) => void handleResolveDecision(id, optionId)}
                  />
                ))}
              </div>
            )}

            {recentResolved.length > 0 && (
              <div className="butler-decision-resolved-strip">
                {recentResolved.map((item) => {
                  const chosenOpt = item.options.find((opt) => opt.id === item.resolution?.optionId)
                  const outcomeLabel = chosenOpt
                    ? formatDecisionOptionLabel(item, chosenOpt, t)
                    : (item.resolution?.optionId ?? item.status)
                  return (
                    <div key={item.id} className="butler-decision-resolved-row">
                      <span className="butler-decision-resolved-title">{item.title}</span>
                      <span>{outcomeLabel}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section className="butler-cockpit-panel" data-testid="butler-missions-panel">
            <div className="butler-cockpit-panel-head">
              <h2 className="butler-cockpit-panel-title">{t('butlerMissionsTitle')}</h2>
            </div>

            {missionActionError && (
              <div className="butler-desk-error-banner" role="alert">
                <span>{missionActionError}</span>
              </div>
            )}

            {sortedMissions.length === 0 ? (
              <p className="butler-cockpit-quiet">{t('butlerMissionsEmpty')}</p>
            ) : (
              <div className="butler-mission-list">
                {sortedMissions.map((mission) => {
                  const defaultExpanded =
                    isMissionActive(mission.status) || focusTarget?.missionId === mission.id
                  const expanded = expandedOverrides[mission.id] ?? defaultExpanded

                  return (
                    <MissionCard
                      key={mission.id}
                      mission={mission}
                      tasksById={tasksById}
                      expanded={expanded}
                      focused={focusTarget?.missionId === mission.id}
                      cancellingMission={cancellingMissionIds.has(mission.id)}
                      cancellingTasks={cancellingTaskIds}
                      steeringTasks={steeringTaskIds}
                      openSteerTaskIds={openSteerTaskIds}
                      steerDrafts={steerDrafts}
                      steerErrors={steerErrors}
                      onToggleExpand={(id, cur) =>
                        setExpandedOverrides((prev) => ({ ...prev, [id]: !cur }))
                      }
                      onCancelMission={(id) => void handleCancelMission(id)}
                      onToggleSteer={handleToggleSteer}
                      onSteerDraftChange={(id, val) =>
                        setSteerDrafts((prev) => ({ ...prev, [id]: val }))
                      }
                      onSubmitSteer={(id) => void handleSubmitSteer(id)}
                      onCancelTask={(id) => void handleCancelTask(id)}
                    />
                  )
                })}
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
