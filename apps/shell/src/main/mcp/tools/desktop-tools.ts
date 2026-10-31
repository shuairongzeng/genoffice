import { z } from 'zod'
import {
  DESKTOP_ACTIONS,
  DESKTOP_ACTION_NAMES,
  type DesktopControlRequest,
} from '@genoffice/cli/control-protocol'
import type { McpToolDefinition } from '../mcp-server'
import { runDesktopAction, type DesktopControlDeps } from '../../desktop-control'

/**
 * The desktop domain as an in-app MCP tool: the same actions the genoffice
 * CLI reaches over the control socket (`genoffice desktop …`), backed by the
 * same live stores, so the shell agent and an external script never disagree
 * about the desktop's state. The action enum, the parameters and the
 * description all derive from the protocol's DESKTOP_ACTIONS table — the
 * same table the standalone `genoffice mcp` server's `desktop_*` tools
 * derive from, so the two MCP surfaces speak one vocabulary by construction.
 */
export function createDesktopTools(control: DesktopControlDeps): McpToolDefinition[] {
  // one schema parameter per distinct argument key, described by the action
  // that takes it (each key belongs to exactly one action today)
  const argEntries = DESKTOP_ACTIONS.flatMap((a) => {
    if (!a.arg) return []
    const base = a.arg.choices
      ? // the choices tuple is a const literal list (the arrange modes); the
        // descriptor's wider readonly type needs the tuple shape back for zod
        z.enum(a.arg.choices as [string, ...string[]])
      : z.string()
    const param = base.optional().describe(`"${a.action}" only: ${a.arg.description}`)
    return [[a.arg.key, param] as const]
  })
  return [
    {
      name: 'desktop',
      description:
        'Read and drive the GenOffice Home desktop. Actions: ' +
        DESKTOP_ACTIONS.map((a) =>
          a.arg
            ? `"${a.action}" (${a.arg.key}: ${a.arg.description}) ${a.description}`
            : `"${a.action}" ${a.description}`,
        ).join('; ') +
        '.',
      inputSchema: {
        action: z.enum(DESKTOP_ACTION_NAMES).describe('what to do'),
        ...Object.fromEntries(argEntries),
      },
      handler: async (rawArgs) => {
        const action = String(rawArgs.action ?? '')
        const spec = DESKTOP_ACTIONS.find((a) => a.action === action)
        if (!spec) {
          const known = DESKTOP_ACTION_NAMES.map((name) => `"${name}"`).join(', ')
          throw new Error(`unknown action "${action}" — use ${known}`)
        }
        const payload: Record<string, unknown> = { cmd: 'desktop', action: spec.action }
        if (spec.arg) {
          const raw = rawArgs[spec.arg.key]
          const value = typeof raw === 'string' ? raw.trim() : ''
          if (!value) throw new Error(`"${spec.action}" needs a ${spec.arg.key} argument`)
          payload[spec.arg.key] = value
        }
        // the table's arg key is the protocol variant's own field name (the
        // tuple and the request union are locked together in control-protocol)
        // — and the store re-validates the value whatever a raw caller sends
        return runDesktopAction(control, payload as DesktopControlRequest)
      },
    },
  ]
}
