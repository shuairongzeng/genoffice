import { BlockList, isIP } from 'node:net'
import { Agent, Dispatcher, EnvHttpProxyAgent } from 'undici'

const LOCAL_HOST_SUFFIXES = ['.localhost', '.local', '.lan'] as const

const LOCAL_OR_PRIVATE_RANGES = (() => {
  const list = new BlockList()
  list.addSubnet('127.0.0.0', 8) // IPv4 loopback
  list.addSubnet('10.0.0.0', 8) // RFC 1918 private
  list.addSubnet('172.16.0.0', 12) // RFC 1918 private (172.16.0.0 - 172.31.255.255)
  list.addSubnet('192.168.0.0', 16) // RFC 1918 private
  list.addSubnet('169.254.0.0', 16) // IPv4 link-local
  list.addAddress('::1', 'ipv6') // IPv6 loopback
  list.addSubnet('fc00::', 7, 'ipv6') // IPv6 unique local
  list.addSubnet('fe80::', 10, 'ipv6') // IPv6 link-local
  return list
})()

function extractHostname(hostOrOrigin: string): string {
  const trimmed = hostOrOrigin.trim()
  if (!trimmed) return ''

  let host: string
  if (trimmed.includes('://')) {
    try {
      host = new URL(trimmed).hostname
    } catch {
      return ''
    }
  } else {
    const authority = trimmed.split(/[/?#]/, 1)[0] ?? ''
    if (authority.startsWith('[')) {
      const closeBracket = authority.indexOf(']')
      if (closeBracket === -1) return ''
      const rest = authority.slice(closeBracket + 1)
      if (rest !== '' && !/^:\d*$/.test(rest)) return ''
      host = authority.slice(1, closeBracket)
      if (!host.includes(':')) return ''
    } else {
      const firstColon = authority.indexOf(':')
      const lastColon = authority.lastIndexOf(':')
      if (firstColon !== -1 && firstColon === lastColon) {
        const port = authority.slice(firstColon + 1)
        if (!/^\d*$/.test(port)) return ''
        host = authority.slice(0, firstColon)
      } else {
        host = authority
      }
    }
  }

  return host
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase()
}

/**
 * Returns true when `hostOrOrigin` resolves syntactically to localhost, a
 * `.localhost`/`.local`/`.lan` hostname, or a loopback / RFC 1918 / link-local /
 * ULA IP address (including IPv4-mapped IPv6 `::ffff:<ipv4>`).
 */
export function isLocalOrPrivateHost(hostOrOrigin: string): boolean {
  const hostname = extractHostname(hostOrOrigin)
  if (!hostname) return false

  if (
    hostname === 'localhost' ||
    (!hostname.startsWith('.') && LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)))
  ) {
    return true
  }

  // Strip IPv6 zone identifier (e.g. fe80::1%eth0) before checking IP ranges.
  const ipCandidate = hostname.includes(':') ? hostname.replace(/%.*$/, '') : hostname
  const family = isIP(ipCandidate)
  if (family === 4) return LOCAL_OR_PRIVATE_RANGES.check(ipCandidate, 'ipv4')
  if (family === 6) return LOCAL_OR_PRIVATE_RANGES.check(ipCandidate, 'ipv6')
  return false
}

/**
 * The NO_PROXY list the main-process dispatcher ships with: the caller's own
 * entries first, then loopback. undici matches entries exactly (or by `*.` or
 * leading-dot suffix), and the URL host of IPv6 loopback keeps its brackets.
 */
export function mergeNoProxy(userNoProxy: string | undefined): string {
  return [userNoProxy, 'localhost', '127.0.0.1', '[::1]'].filter((v) => !!v).join(',')
}

/**
 * Dispatcher subclass that bypasses the configured HTTP proxy for loopback and
 * private/local-network origins (where undici's NO_PROXY string matcher cannot
 * express IPv4/IPv6 CIDR ranges) while forwarding everything else through
 * EnvHttpProxyAgent.
 */
class MainProcessProxyDispatcher extends Dispatcher {
  private readonly direct: Agent
  private readonly proxied: EnvHttpProxyAgent

  constructor(proxyUrl: string) {
    super()
    this.direct = new Agent()
    this.proxied = new EnvHttpProxyAgent({
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
      noProxy: mergeNoProxy(process.env.no_proxy ?? process.env.NO_PROXY),
    })
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandlers,
  ): boolean {
    const origin = String(options?.origin ?? '')
    const target = isLocalOrPrivateHost(origin) ? this.direct : this.proxied
    return target.dispatch(options, handler)
  }

  override close(): Promise<void>
  override close(callback: () => void): void
  override close(callback?: () => void): Promise<void> | void {
    const done = Promise.all([this.direct.close(), this.proxied.close()]).then(() => undefined)
    if (callback) {
      void done.then(callback, callback)
      return
    }
    return done
  }

  override destroy(): Promise<void>
  override destroy(err: Error | null): Promise<void>
  override destroy(callback: () => void): void
  override destroy(err: Error | null, callback: () => void): void
  override destroy(
    errOrCallback?: Error | null | (() => void),
    callback?: () => void,
  ): Promise<void> | void {
    const err = typeof errOrCallback === 'function' ? null : (errOrCallback ?? null)
    const cb = typeof errOrCallback === 'function' ? errOrCallback : callback
    const done = Promise.all([this.direct.destroy(err), this.proxied.destroy(err)]).then(
      () => undefined,
    )
    if (cb) {
      void done.then(
        () => cb(),
        () => cb(),
      )
      return
    }
    return done
  }
}

/**
 * The dispatcher behind the main process's global fetch when a proxy is in
 * play. Loopback and private/local-network origins ride a direct Agent so local
 * or LAN providers (Ollama, LM Studio, self-hosted services) never get routed
 * through the upstream proxy as absolute-form requests (genoffice#2084), while
 * external targets continue through EnvHttpProxyAgent with NO_PROXY support.
 */
export async function createMainProcessProxyDispatcher(proxyUrl: string): Promise<Dispatcher> {
  return new MainProcessProxyDispatcher(proxyUrl)
}
