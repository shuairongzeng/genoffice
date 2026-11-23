import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  TerminalCommandSnippet,
  TerminalSaveSnippetInput,
  TerminalWorkspaceProfile,
} from '../../shared/terminal-api'

const PROFILES_FILE = 'terminal-profiles.json'
const SNIPPETS_FILE = 'terminal-snippets.json'

function buildDefaultSnippets(now: number): TerminalCommandSnippet[] {
  const isWin = process.platform === 'win32'
  return [
    {
      id: 'snip-default-pi',
      title: 'Launch Pi CLI',
      command: 'pi',
      sendEnter: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'snip-default-git',
      title: 'Git Status Summary',
      command: 'git status -sb',
      sendEnter: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'snip-default-ports',
      title: 'List Listening Ports',
      command: isWin ? 'netstat -ano | findstr LISTENING' : 'lsof -i -P -n | grep LISTEN',
      sendEnter: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'snip-default-venv',
      title: 'Activate Python .venv',
      command: isWin ? '.\\.venv\\Scripts\\Activate.ps1' : 'source .venv/bin/activate',
      sendEnter: false,
      createdAt: now,
      updatedAt: now,
    },
  ]
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const json = `${JSON.stringify(payload, null, 2)}\n`
  const tempPath = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tempPath, json, 'utf8')
    fs.renameSync(tempPath, filePath)
  } catch {
    try {
      fs.unlinkSync(tempPath)
    } catch {
      // Ignore cleanup failure for aborted temp write.
    }
    fs.writeFileSync(filePath, json, 'utf8')
  }
}

/**
 * JSON-backed persistence for saved terminal workspace profiles and command snippets.
 */
export class TerminalPersistence {
  private readonly profilesPath: string
  private readonly snippetsPath: string

  constructor(storageDir: string) {
    this.profilesPath = path.join(storageDir, PROFILES_FILE)
    this.snippetsPath = path.join(storageDir, SNIPPETS_FILE)
  }

  listProfiles(): TerminalWorkspaceProfile[] {
    try {
      if (!fs.existsSync(this.profilesPath)) return []
      const raw = JSON.parse(fs.readFileSync(this.profilesPath, 'utf8'))
      return Array.isArray(raw) ? (raw as TerminalWorkspaceProfile[]) : []
    } catch {
      return []
    }
  }

  saveProfile(profile: TerminalWorkspaceProfile): TerminalWorkspaceProfile {
    const existing = this.listProfiles()
    const next = [...existing.filter((item) => item.id !== profile.id), profile]
    writeJsonAtomic(this.profilesPath, next)
    return profile
  }

  deleteProfile(profileId: string): void {
    const existing = this.listProfiles()
    const next = existing.filter((item) => item.id !== profileId)
    if (next.length !== existing.length) {
      writeJsonAtomic(this.profilesPath, next)
    }
  }

  listSnippets(): TerminalCommandSnippet[] {
    if (!fs.existsSync(this.snippetsPath)) {
      const seeds = buildDefaultSnippets(Date.now())
      try {
        writeJsonAtomic(this.snippetsPath, seeds)
      } catch {
        // Ignore read-only directory errors while still serving defaults in memory.
      }
      return seeds
    }

    try {
      const raw = JSON.parse(fs.readFileSync(this.snippetsPath, 'utf8'))
      return Array.isArray(raw) ? (raw as TerminalCommandSnippet[]) : []
    } catch {
      return []
    }
  }

  saveSnippet(input: TerminalSaveSnippetInput): TerminalCommandSnippet {
    const title = input.title.trim()
    const command = input.command.trim()
    if (!title || !command) {
      throw new Error('Snippet title and command are required')
    }
    const now = Date.now()
    const list = this.listSnippets()
    const existing = input.id ? list.find((s) => s.id === input.id) : undefined

    const snippet: TerminalCommandSnippet = {
      id: existing?.id ?? `snip-${crypto.randomBytes(4).toString('hex')}`,
      title,
      command,
      sendEnter: Boolean(input.sendEnter),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }

    const next = existing
      ? list.map((item) => (item.id === snippet.id ? snippet : item))
      : [...list, snippet]
    writeJsonAtomic(this.snippetsPath, next)
    return snippet
  }

  deleteSnippet(snippetId: string): void {
    const list = this.listSnippets()
    const next = list.filter((item) => item.id !== snippetId)
    if (next.length !== list.length) {
      writeJsonAtomic(this.snippetsPath, next)
    }
  }
}
