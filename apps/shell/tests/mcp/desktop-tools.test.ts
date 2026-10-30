import { z } from 'zod'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The in-app MCP `desktop` tool: schema shape (the action enum an agent picks
 * from) and the action→store mapping, backed by the same desktop-control core
 * the CLI's control socket uses.
 */

vi.mock('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  ipcMain: { handle: vi.fn() },
  dialog: {},
  BrowserWindow: { fromWebContents: () => null },
}))

import { createDesktopTools } from '../../src/main/mcp/tools/desktop-tools'
import { DESKTOP_ACTION_NAMES } from '@genoffice/cli/control-protocol'

let userData: string
let wallpapers: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'genoffice-mcp-desktop-'))
  wallpapers = join(userData, 'builtin-wallpapers')
  mkdirSync(wallpapers, { recursive: true })
  writeFileSync(
    join(wallpapers, 'wallpapers.json'),
    JSON.stringify([{ id: 'teal-deep', nameKey: 'k', filename: 'teal-deep.png' }]),
  )
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

const deps = () => ({
  userDataDir: () => userData,
  wallpapersDir: () => wallpapers,
  customWallpapersDir: () => join(userData, 'wallpapers'),
  listWindows: () => [{ id: 'home', kind: 'home', title: 'GenOffice', active: true }],
})

describe('the desktop MCP tool', () => {
  it('exposes one tool with the action enum', () => {
    const [tool] = createDesktopTools(deps())
    expect(tool!.name).toBe('desktop')
    const action = tool!.inputSchema!.action
    expect(JSON.stringify(action)).toContain('get-state')
    expect(JSON.stringify(action)).toContain('set-wallpaper')
    expect(JSON.stringify(action)).toContain('arrange')
    expect(JSON.stringify(action)).toContain('todo-add')
    expect(JSON.stringify(action)).toContain('windows-list')
  })

  it('derives its action list, parameters and description from the protocol table', () => {
    // the same DESKTOP_ACTIONS table feeds the standalone genoffice mcp
    // server's desktop_* tools; this surface must name every action in its
    // description (an agent reads the description to learn the vocabulary)
    // and carry exactly the argument keys the table declares
    const [tool] = createDesktopTools(deps())
    expect(Object.keys(tool!.inputSchema!).sort()).toEqual(['action', 'mode', 'text', 'wallpaper'])
    for (const name of DESKTOP_ACTION_NAMES) expect(tool!.description).toContain(`"${name}"`)
    // the SDK validates raw tool calls against this shape before the handler
    // runs — so the arrange mode must really be the table's choices enum, not
    // a plain string that silently accepts anything and pushes the rejection
    // to the far-side store
    const schema = z.object(tool!.inputSchema!)
    expect(schema.safeParse({ action: 'arrange', mode: 'name' }).success).toBe(true)
    expect(schema.safeParse({ action: 'arrange', mode: 'color' }).success).toBe(false)
  })

  it('runs get-state against the live stores', async () => {
    writeFileSync(
      join(userData, 'todos.json'),
      JSON.stringify([{ id: 't1', text: 'milk', done: false }]),
    )
    const [tool] = createDesktopTools(deps())
    const result = (await tool!.handler({ action: 'get-state' })) as {
      todos: unknown[]
      windows: unknown[]
    }
    expect(result.todos).toHaveLength(1)
    expect(result.windows).toHaveLength(1)
  })

  it('maps set-wallpaper and todo-add, and rejects a missing argument', async () => {
    const [tool] = createDesktopTools(deps())
    const wallpaper = (await tool!.handler({
      action: 'set-wallpaper',
      wallpaper: 'teal-deep',
    })) as { wallpaper: string }
    expect(wallpaper.wallpaper).toBe('builtin:teal-deep')
    await expect(tool!.handler({ action: 'set-wallpaper' })).rejects.toThrow(/wallpaper/)
    await expect(tool!.handler({ action: 'todo-add' })).rejects.toThrow(/text/)
    await expect(tool!.handler({ action: 'nuke' })).rejects.toThrow(/unknown action/)
    const added = (await tool!.handler({ action: 'todo-add', text: 'buy milk' })) as {
      todos: unknown[]
    }
    expect(added.todos).toHaveLength(1)
  })

  it('maps arrange onto the same prefs store the surface menu writes', async () => {
    const [tool] = createDesktopTools(deps())
    const result = (await tool!.handler({ action: 'arrange', mode: 'name' })) as {
      sortMode: string
    }
    expect(result.sortMode).toBe('name')
    // the schema's enum plus the handler's argument check, then the store's
    // own vocabulary check on the far side
    await expect(tool!.handler({ action: 'arrange' })).rejects.toThrow(/mode/)
    await expect(tool!.handler({ action: 'arrange', mode: 'color' })).rejects.toThrow(
      /unknown arrangement/,
    )
  })
})
