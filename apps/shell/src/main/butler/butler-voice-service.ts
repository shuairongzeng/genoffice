import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { readAppSettings, writeAppSetting } from '../app-settings'
import { atomicWriteFile } from '../atomic-write'
import {
  BUTLER_VOICE_SETTINGS_KEY,
  DEFAULT_OMLX_STT_MODEL,
  DEFAULT_OMLX_TTS_MODEL,
  DEFAULT_OMLX_TTS_VOICE,
  PRESET_OMLX_VOICES,
  mergeButlerVoiceConfig,
  normalizeButlerVoiceConfig,
  sameButlerVoiceConfig,
  type ButlerSttTranscribeRequest,
  type ButlerSttTranscribeResult,
  type ButlerTtsStartRequest,
  type ButlerTtsStartResult,
  type ButlerTtsStreamEvent,
  type ButlerVoiceCloneState,
  type ButlerVoiceCloneUploadRequest,
  type ButlerVoiceConfig,
  type ButlerVoiceProbeRequest,
  type ButlerVoiceProbeResult,
} from '../../shared/butler-voice-api'

const WATCH_DEBOUNCE_MS = 100
const CLONE_STORE_FILENAME = 'butler-voice-clone.json'
const MAX_CLONE_AUDIO_BYTES = 10 * 1024 * 1024
const CLONE_FILE_NAME_MAX = 160
const PROBE_TIMEOUT_MS = 5000
const STT_TIMEOUT_MS = 20000
const TTS_FIRST_BYTE_TIMEOUT_MS = 8000
const TTS_TOTAL_TIMEOUT_MS = 45000

interface CloneAudioRecord {
  readonly audioBase64: string
  readonly fileName: string
  readonly byteLength: number
  readonly updatedAt: number
}

interface QueuedSttJob {
  readonly req: ButlerSttTranscribeRequest
  readonly purpose: 'command' | 'wake'
  readonly resolve: (result: ButlerSttTranscribeResult) => void
}

interface ActiveTtsRun {
  readonly requestId: string
  readonly controller: AbortController
  abortReason: 'caller' | 'first-byte-timeout' | 'total-timeout' | null
}

function isTtsCallerAborted(run: ActiveTtsRun): boolean {
  return run.abortReason === 'caller'
}

export interface ButlerVoiceServiceDeps {
  settingsPath: () => string
  cloneStorePath: () => string
  fetchImpl?: typeof fetch
  now?: () => number
}

export interface ButlerVoiceService {
  getConfig(): ButlerVoiceConfig
  setConfig(patch: unknown): ButlerVoiceConfig
  getCloneState(): ButlerVoiceCloneState
  setCloneAudio(req: ButlerVoiceCloneUploadRequest): Promise<ButlerVoiceConfig>
  clearCloneAudio(): Promise<ButlerVoiceConfig>
  probe(req?: ButlerVoiceProbeRequest): Promise<ButlerVoiceProbeResult>
  transcribe(req: ButlerSttTranscribeRequest): Promise<ButlerSttTranscribeResult>
  startTts(
    req: ButlerTtsStartRequest,
    emitEvent: (event: ButlerTtsStreamEvent) => void,
  ): Promise<ButlerTtsStartResult>
  stopTts(requestId?: string): void
  dispose(): void
}

/** Resolve the dedicated reference-voice clone JSON store path inside `userDataDir`. */
export function butlerVoiceClonePath(userDataDir: string): string {
  return join(userDataDir, CLONE_STORE_FILENAME)
}

/** Read normalized `butlerVoice` config from `app-settings.json`. */
export function readButlerVoiceConfig(settingsPath: string): ButlerVoiceConfig {
  return normalizeButlerVoiceConfig(readAppSettings(settingsPath)[BUTLER_VOICE_SETTINGS_KEY])
}

/** Merge a partial patch into stored `butlerVoice` config, persist, and return normalized config. */
export function writeButlerVoiceConfig(settingsPath: string, patch: unknown): ButlerVoiceConfig {
  mkdirSync(dirname(settingsPath), { recursive: true })
  const current = readButlerVoiceConfig(settingsPath)
  const next = mergeButlerVoiceConfig(current, patch)
  writeAppSetting(settingsPath, BUTLER_VOICE_SETTINGS_KEY, next)
  return next
}

/**
 * Watch `app-settings.json` for `butlerVoice` changes and invoke `onChange` only
 * when the normalized configuration actually differs from the previous snapshot.
 */
export function watchButlerVoiceConfig(
  settingsPath: string,
  onChange: (config: ButlerVoiceConfig) => void,
): () => void {
  let last = readButlerVoiceConfig(settingsPath)
  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null

  const close = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    watcher?.close()
    watcher = null
  }

  const changed = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const next = readButlerVoiceConfig(settingsPath)
      if (sameButlerVoiceConfig(next, last)) return
      last = next
      onChange(next)
    }, WATCH_DEBOUNCE_MS)
  }

  try {
    watcher = watch(dirname(settingsPath), { persistent: false }, (_event, filename) => {
      const name = filename?.toString() ?? ''
      if (name === '' || name.startsWith(basename(settingsPath))) changed()
    })
    watcher.on('error', () => close())
  } catch {
    watcher = null
  }

  return close
}

function stripDataUriPrefix(raw: string): string {
  return raw.replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '')
}

function hasValidRiffWaveHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  )
}

function decodeAndValidateWavBase64(rawBase64: string): { audioBase64: string; bytes: Buffer } {
  const stripped = stripDataUriPrefix(rawBase64)
  if (!stripped || stripped.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) {
    throw new Error('Invalid base64 encoding in reference audio')
  }
  const bytes = Buffer.from(stripped, 'base64')
  if (bytes.byteLength === 0) {
    throw new Error('Reference audio cannot be empty')
  }
  if (bytes.byteLength > MAX_CLONE_AUDIO_BYTES) {
    throw new Error('Reference audio exceeds 10MB limit')
  }
  if (!hasValidRiffWaveHeader(bytes)) {
    throw new Error('Reference audio must be a valid RIFF/WAVE file')
  }
  return {
    audioBase64: bytes.toString('base64'),
    bytes,
  }
}

function sanitizeCloneFileName(fileName: string): string {
  const base = basename(fileName.trim())
    .replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CLONE_FILE_NAME_MAX)
  return base || 'reference.wav'
}

function readCloneRecord(cloneStorePath: string): CloneAudioRecord | null {
  if (!existsSync(cloneStorePath)) return null
  try {
    const raw = JSON.parse(readFileSync(cloneStorePath, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const rec = raw as Record<string, unknown>
    if (typeof rec.audioBase64 !== 'string' || rec.audioBase64.trim().length === 0) return null
    const decoded = decodeAndValidateWavBase64(rec.audioBase64)
    const fileName =
      typeof rec.fileName === 'string' ? sanitizeCloneFileName(rec.fileName) : 'reference.wav'
    const updatedAt =
      typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0
    return {
      audioBase64: decoded.audioBase64,
      fileName,
      byteLength: decoded.bytes.byteLength,
      updatedAt,
    }
  } catch {
    return null
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message
  const text = String(err ?? '').trim()
  return text || 'Unknown error'
}

function normalizeHttpBaseUrl(rawUrl: string): string | null {
  const cleaned = rawUrl.trim().replace(/\/+$/, '')
  if (!cleaned) return null
  try {
    const parsed = new URL(cleaned)
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0) {
      return cleaned
    }
  } catch {
    return null
  }
  return null
}

function parseModelsPayload(raw: unknown): { sttModels: string[]; ttsModels: string[] } {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(obj?.data)
      ? obj.data
      : Array.isArray(obj?.models)
        ? obj.models
        : []

  const sttModels: string[] = []
  const ttsModels: string[] = []
  const seenStt = new Set<string>()
  const seenTts = new Set<string>()

  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const id = typeof rec.id === 'string' ? rec.id.trim() : ''
    if (!id) continue
    const modelType = typeof rec.model_type === 'string' ? rec.model_type.trim().toLowerCase() : ''

    const isStt =
      modelType === 'audio_stt' ||
      (!modelType && /(asr|stt|whisper|transcrib|voxtral)/i.test(id))
    const isTts =
      modelType === 'audio_tts' ||
      (!modelType && /(tts|speech|customvoice|kokoro|cosyvoice)/i.test(id))

    if (isStt && !seenStt.has(id)) {
      seenStt.add(id)
      sttModels.push(id)
    }
    if (isTts && !seenTts.has(id)) {
      seenTts.add(id)
      ttsModels.push(id)
    }
  }

  return { sttModels, ttsModels }
}

function parseVoicesPayload(raw: unknown): string[] {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(obj?.voices)
      ? obj.voices
      : Array.isArray(obj?.data)
        ? obj.data
        : []

  const remote: string[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    let name = ''
    if (typeof entry === 'string') {
      name = entry.trim()
    } else if (entry && typeof entry === 'object') {
      const rec = entry as Record<string, unknown>
      if (typeof rec.id === 'string') name = rec.id.trim()
      else if (typeof rec.name === 'string') name = rec.name.trim()
    }
    if (name && !seen.has(name)) {
      seen.add(name)
      remote.push(name)
    }
  }

  for (const preset of PRESET_OMLX_VOICES) {
    if (!seen.has(preset)) {
      seen.add(preset)
      remote.push(preset)
    }
  }
  return remote
}

function toArrayBufferBackedUint8Array(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength)
  out.set(bytes)
  return out
}

function extractWavBytesFromSttRequest(req: ButlerSttTranscribeRequest): Uint8Array<ArrayBuffer> | null {
  if (req.wavBytes instanceof Uint8Array && req.wavBytes.byteLength > 0) {
    return toArrayBufferBackedUint8Array(req.wavBytes)
  }
  if (typeof req.wavBase64 === 'string' && req.wavBase64.trim().length > 0) {
    const stripped = stripDataUriPrefix(req.wavBase64)
    if (!stripped) return null
    const buf = Buffer.from(stripped, 'base64')
    if (buf.byteLength === 0) return null
    return toArrayBufferBackedUint8Array(buf)
  }
  return null
}

async function readErrorBodySnippet(resp: Response): Promise<string> {
  try {
    const text = (await resp.text()).replace(/\s+/g, ' ').trim()
    return text ? text.slice(0, 200) : ''
  } catch {
    return ''
  }
}

/**
 * Create the main-process Butler voice gateway handling config persistence,
 * validated WAV clone storage, oMLX probing, serialized STT queuing, and
 * single-active streaming TTS with clone-safety guards.
 */
export function createButlerVoiceService(deps: ButlerVoiceServiceDeps): ButlerVoiceService {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const nowFn = deps.now ?? (() => Date.now())

  let disposed = false
  const sttQueue: QueuedSttJob[] = []
  let sttRunning = false
  let activeSttController: AbortController | null = null
  let activeTts: ActiveTtsRun | null = null

  const stopActiveTts = (requestId?: string): void => {
    if (!activeTts) return
    if (requestId !== undefined && activeTts.requestId !== requestId) return
    const target = activeTts
    activeTts = null
    target.abortReason = 'caller'
    target.controller.abort()
  }

  const executeStt = async (req: ButlerSttTranscribeRequest): Promise<ButlerSttTranscribeResult> => {
    const startedAt = nowFn()
    const wavBytes = extractWavBytesFromSttRequest(req)
    if (!wavBytes) {
      return { ok: false, text: '', latencyMs: 0, error: 'Empty audio input' }
    }

    const cfg = readButlerVoiceConfig(deps.settingsPath())
    const baseUrl = normalizeHttpBaseUrl(cfg.baseUrl)
    if (!baseUrl) {
      return {
        ok: false,
        text: '',
        latencyMs: Math.max(0, Math.round(nowFn() - startedAt)),
        error: 'Invalid or empty oMLX base URL',
      }
    }

    const form = new FormData()
    const blob = new Blob([wavBytes], { type: 'audio/wav' })
    form.append('file', blob, 'speech.wav')
    form.append('model', cfg.sttModel || DEFAULT_OMLX_STT_MODEL)

    const lang = (req.language ?? cfg.sttLanguage).trim()
    if (lang && lang !== 'auto') {
      form.append('language', lang)
    }
    if (typeof req.prompt === 'string' && req.prompt.trim().length > 0) {
      form.append('prompt', req.prompt.trim())
    }

    const controller = new AbortController()
    activeSttController = controller
    const timer = setTimeout(() => controller.abort(), STT_TIMEOUT_MS)

    try {
      const resp = await fetchImpl(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: form,
        signal: controller.signal,
      })
      const latencyMs = Math.max(0, Math.round(nowFn() - startedAt))

      if (!resp.ok) {
        const detail = await readErrorBodySnippet(resp)
        return {
          ok: false,
          text: '',
          latencyMs,
          error: detail ? `HTTP ${resp.status}: ${detail}` : `HTTP ${resp.status}`,
        }
      }

      const data = (await resp.json()) as Record<string, unknown>
      const text = typeof data.text === 'string' ? data.text.trim() : ''
      const language = typeof data.language === 'string' ? data.language : undefined
      const duration =
        typeof data.duration === 'number' && Number.isFinite(data.duration)
          ? data.duration
          : undefined

      return {
        ok: true,
        text,
        ...(language !== undefined ? { language } : {}),
        ...(duration !== undefined ? { duration } : {}),
        latencyMs,
      }
    } catch (err) {
      const latencyMs = Math.max(0, Math.round(nowFn() - startedAt))
      return {
        ok: false,
        text: '',
        latencyMs,
        error: controller.signal.aborted ? 'STT request timed out or aborted' : formatError(err),
      }
    } finally {
      clearTimeout(timer)
      if (activeSttController === controller) {
        activeSttController = null
      }
    }
  }

  const pumpSttQueue = async (): Promise<void> => {
    if (sttRunning || disposed) return
    const next = sttQueue.shift()
    if (!next) return
    sttRunning = true
    try {
      const res = await executeStt(next.req)
      next.resolve(res)
    } catch (err) {
      next.resolve({ ok: false, text: '', latencyMs: 0, error: formatError(err) })
    } finally {
      sttRunning = false
      void pumpSttQueue()
    }
  }

  const pumpTtsStream = async (
    run: ActiveTtsRun,
    baseUrl: string,
    apiKey: string,
    payload: Record<string, unknown>,
    fallbackToSystem: boolean,
    emitEvent: (event: ButlerTtsStreamEvent) => void,
  ): Promise<void> => {
    // Yield one microtask so `startTts` returns its initial result before emitting chunks.
    await Promise.resolve()
    if (disposed || isTtsCallerAborted(run) || activeTts !== run) {
      return
    }

    let gotFirstByte = false
    const firstByteTimer = setTimeout(() => {
      if (run.abortReason === null && !gotFirstByte) {
        run.abortReason = 'first-byte-timeout'
        run.controller.abort()
      }
    }, TTS_FIRST_BYTE_TIMEOUT_MS)

    const totalTimer = setTimeout(() => {
      if (run.abortReason === null) {
        run.abortReason = 'total-timeout'
        run.controller.abort()
      }
    }, TTS_TOTAL_TIMEOUT_MS)

    try {
      const resp = await fetchImpl(`${baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: run.controller.signal,
      })

      if (disposed || isTtsCallerAborted(run)) return

      if (!resp.ok) {
        const detail = await readErrorBodySnippet(resp)
        throw new Error(detail ? `HTTP ${resp.status}: ${detail}` : `HTTP ${resp.status}`)
      }

      if (resp.body) {
        const reader = resp.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (disposed || isTtsCallerAborted(run)) {
            await reader.cancel().catch(() => undefined)
            return
          }
          if (done) break
          if (value && value.byteLength > 0) {
            if (!gotFirstByte) {
              gotFirstByte = true
              clearTimeout(firstByteTimer)
            }
            emitEvent({
              requestId: run.requestId,
              type: 'chunk',
              chunk: new Uint8Array(value),
            })
          }
        }
      } else {
        const raw = new Uint8Array(await resp.arrayBuffer())
        if (disposed || isTtsCallerAborted(run)) return
        if (raw.byteLength > 0) {
          gotFirstByte = true
          clearTimeout(firstByteTimer)
          emitEvent({
            requestId: run.requestId,
            type: 'chunk',
            chunk: raw,
          })
        }
      }

      if (disposed || isTtsCallerAborted(run)) return
      emitEvent({ requestId: run.requestId, type: 'done' })
    } catch (err) {
      if (disposed || isTtsCallerAborted(run)) return
      const errorMessage =
        run.abortReason === 'first-byte-timeout'
          ? 'TTS first-byte timeout'
          : run.abortReason === 'total-timeout'
            ? 'TTS total stream timeout'
            : formatError(err)
      emitEvent({
        requestId: run.requestId,
        type: 'error',
        fallbackSystem: fallbackToSystem,
        error: errorMessage,
      })
    } finally {
      clearTimeout(firstByteTimer)
      clearTimeout(totalTimer)
      if (activeTts === run) {
        activeTts = null
      }
    }
  }

  return {
    getConfig(): ButlerVoiceConfig {
      return readButlerVoiceConfig(deps.settingsPath())
    },

    setConfig(patch: unknown): ButlerVoiceConfig {
      return writeButlerVoiceConfig(deps.settingsPath(), patch)
    },

    getCloneState(): ButlerVoiceCloneState {
      const rec = readCloneRecord(deps.cloneStorePath())
      if (!rec) {
        return {
          hasAudio: false,
          fileName: '',
          byteLength: 0,
          updatedAt: null,
        }
      }
      return {
        hasAudio: true,
        fileName: rec.fileName,
        byteLength: rec.byteLength,
        updatedAt: rec.updatedAt,
      }
    },

    async setCloneAudio(req: ButlerVoiceCloneUploadRequest): Promise<ButlerVoiceConfig> {
      if (!req || typeof req !== 'object' || typeof req.audioBase64 !== 'string') {
        throw new Error('Invalid clone audio upload request')
      }
      const { audioBase64, bytes } = decodeAndValidateWavBase64(req.audioBase64)
      const safeFileName = sanitizeCloneFileName(
        typeof req.fileName === 'string' ? req.fileName : 'reference.wav',
      )
      const record: CloneAudioRecord = {
        audioBase64,
        fileName: safeFileName,
        byteLength: bytes.byteLength,
        updatedAt: nowFn(),
      }
      const targetPath = deps.cloneStorePath()
      mkdirSync(dirname(targetPath), { recursive: true })
      await atomicWriteFile(targetPath, Buffer.from(JSON.stringify(record, null, 2), 'utf8'))

      return writeButlerVoiceConfig(deps.settingsPath(), {
        cloneHasAudio: true,
        cloneAudioName: safeFileName,
        ...(req.refText !== undefined ? { cloneRefText: req.refText } : {}),
      })
    },

    async clearCloneAudio(): Promise<ButlerVoiceConfig> {
      await rm(deps.cloneStorePath(), { force: true })
      return writeButlerVoiceConfig(deps.settingsPath(), {
        cloneHasAudio: false,
        cloneAudioName: '',
        cloneEnabled: false,
      })
    },

    async probe(req?: ButlerVoiceProbeRequest): Promise<ButlerVoiceProbeResult> {
      const startedAt = nowFn()
      const cfg = readButlerVoiceConfig(deps.settingsPath())
      const rawUrl =
        req?.baseUrl !== undefined && req.baseUrl.trim().length > 0 ? req.baseUrl : cfg.baseUrl
      const baseUrl = normalizeHttpBaseUrl(rawUrl)
      if (!baseUrl) {
        return {
          ok: false,
          latencyMs: Math.max(0, Math.round(nowFn() - startedAt)),
          sttModels: [],
          ttsModels: [],
          voices: [...PRESET_OMLX_VOICES],
          error: 'Invalid or empty base URL',
        }
      }

      const apiKey = req?.apiKey !== undefined ? req.apiKey.trim() : cfg.apiKey
      const ttsModel = (req?.ttsModel?.trim()) || cfg.ttsModel || DEFAULT_OMLX_TTS_MODEL
      const headers = { Authorization: `Bearer ${apiKey}` }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

      try {
        const modelsPromise = fetchImpl(`${baseUrl}/models`, {
          method: 'GET',
          headers,
          signal: controller.signal,
        })
        const voicesPromise = fetchImpl(
          `${baseUrl}/audio/voices?model=${encodeURIComponent(ttsModel)}`,
          {
            method: 'GET',
            headers,
            signal: controller.signal,
          },
        )

        const [modelsSettled, voicesSettled] = await Promise.allSettled([
          modelsPromise,
          voicesPromise,
        ])
        const latencyMs = Math.max(0, Math.round(nowFn() - startedAt))

        if (modelsSettled.status === 'rejected') {
          return {
            ok: false,
            latencyMs,
            sttModels: [],
            ttsModels: [],
            voices: [...PRESET_OMLX_VOICES],
            error: controller.signal.aborted ? 'Connection timed out' : formatError(modelsSettled.reason),
          }
        }

        const modelsResp = modelsSettled.value
        if (!modelsResp.ok) {
          const detail = await readErrorBodySnippet(modelsResp)
          return {
            ok: false,
            latencyMs,
            sttModels: [],
            ttsModels: [],
            voices: [...PRESET_OMLX_VOICES],
            error: detail ? `HTTP ${modelsResp.status}: ${detail}` : `HTTP ${modelsResp.status}`,
          }
        }

        const modelsJson = (await modelsResp.json()) as unknown
        const { sttModels, ttsModels } = parseModelsPayload(modelsJson)

        let voices: string[] = [...PRESET_OMLX_VOICES]
        if (voicesSettled.status === 'fulfilled' && voicesSettled.value.ok) {
          try {
            const voicesJson = (await voicesSettled.value.json()) as unknown
            voices = parseVoicesPayload(voicesJson)
          } catch {
            voices = [...PRESET_OMLX_VOICES]
          }
        }

        return {
          ok: true,
          latencyMs,
          sttModels,
          ttsModels,
          voices,
        }
      } catch (err) {
        return {
          ok: false,
          latencyMs: Math.max(0, Math.round(nowFn() - startedAt)),
          sttModels: [],
          ttsModels: [],
          voices: [...PRESET_OMLX_VOICES],
          error: controller.signal.aborted ? 'Connection timed out' : formatError(err),
        }
      } finally {
        clearTimeout(timer)
      }
    },

    transcribe(req: ButlerSttTranscribeRequest): Promise<ButlerSttTranscribeResult> {
      if (disposed) {
        return Promise.resolve({
          ok: false,
          text: '',
          latencyMs: 0,
          error: 'Voice service is disposed',
        })
      }

      const purpose: 'command' | 'wake' = req.purpose === 'wake' ? 'wake' : 'command'

      // Drop older queued wake segments when a fresher wake turn arrives.
      if (purpose === 'wake') {
        for (let i = sttQueue.length - 1; i >= 0; i -= 1) {
          if (sttQueue[i]!.purpose === 'wake') {
            const [dropped] = sttQueue.splice(i, 1)
            dropped?.resolve({
              ok: false,
              text: '',
              latencyMs: 0,
              error: 'Superseded by newer wake segment',
            })
          }
        }
      }

      return new Promise<ButlerSttTranscribeResult>((resolve) => {
        const job: QueuedSttJob = { req, purpose, resolve }
        if (purpose === 'command') {
          const firstWakeIndex = sttQueue.findIndex((item) => item.purpose === 'wake')
          if (firstWakeIndex >= 0) {
            sttQueue.splice(firstWakeIndex, 0, job)
          } else {
            sttQueue.push(job)
          }
        } else {
          sttQueue.push(job)
        }
        void pumpSttQueue()
      })
    },

    async startTts(
      req: ButlerTtsStartRequest,
      emitEvent: (event: ButlerTtsStreamEvent) => void,
    ): Promise<ButlerTtsStartResult> {
      const requestId = typeof req.requestId === 'string' ? req.requestId.trim() : ''
      if (!requestId) {
        return { ok: false, requestId: '', error: 'Missing requestId' }
      }

      // Abort any active TTS stream immediately before validating or starting the new one.
      stopActiveTts()

      if (disposed) {
        return { ok: false, requestId, error: 'Voice service is disposed' }
      }

      const stored = readButlerVoiceConfig(deps.settingsPath())
      const cfg = req.configOverride ? mergeButlerVoiceConfig(stored, req.configOverride) : stored
      const baseUrl = normalizeHttpBaseUrl(cfg.baseUrl)
      if (cfg.provider === 'system' || !baseUrl) {
        return { ok: false, requestId, fallbackSystem: true }
      }

      const text = typeof req.text === 'string' ? req.text.trim() : ''
      if (!text) {
        return { ok: false, requestId, error: 'TTS text must not be empty' }
      }

      // Voice clone guard: never omit `voice` and attach ref_audio/ref_text only when both are valid.
      const voice = req.voice?.trim() || cfg.ttsVoice.trim() || DEFAULT_OMLX_TTS_VOICE
      const trimmedRefText = cfg.cloneRefText.trim()
      const cloneRecord =
        cfg.cloneEnabled && trimmedRefText.length > 0
          ? readCloneRecord(deps.cloneStorePath())
          : null

      const payload: Record<string, unknown> = {
        model: cfg.ttsModel || DEFAULT_OMLX_TTS_MODEL,
        input: text,
        voice,
        stream: true,
        response_format: 'wav',
        streaming_interval: 0.3,
      }
      if (typeof req.speed === 'number' && Number.isFinite(req.speed) && req.speed > 0) {
        payload.speed = req.speed
      }
      const instructions =
        req.instructions !== undefined ? req.instructions.trim() : cfg.ttsInstructions.trim()
      if (instructions.length > 0) {
        payload.instructions = instructions
      }
      if (cloneRecord && trimmedRefText.length > 0) {
        payload.ref_audio = cloneRecord.audioBase64
        payload.ref_text = trimmedRefText
      }

      const run: ActiveTtsRun = {
        requestId,
        controller: new AbortController(),
        abortReason: null,
      }
      activeTts = run
      void pumpTtsStream(run, baseUrl, cfg.apiKey, payload, cfg.fallbackToSystem, emitEvent)
      return { ok: true, requestId }
    },

    stopTts(requestId?: string): void {
      stopActiveTts(requestId)
    },

    dispose(): void {
      disposed = true
      stopActiveTts()
      activeSttController?.abort()
      activeSttController = null
      while (sttQueue.length > 0) {
        const dropped = sttQueue.shift()
        dropped?.resolve({
          ok: false,
          text: '',
          latencyMs: 0,
          error: 'Voice service is disposed',
        })
      }
    },
  }
}
