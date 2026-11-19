import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { Agent, EnvHttpProxyAgent } from 'undici'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMainProcessProxyDispatcher,
  isLocalOrPrivateHost,
  mergeNoProxy,
} from '../src/main-proxy'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isLocalOrPrivateHost', () => {
  it('matches localhost, .localhost, .local, and .lan hosts', () => {
    for (const target of [
      'localhost',
      'localhost:3000',
      'localhost.',
      'LOCALHOST.:8080',
      'app.localhost',
      'http://sub.localhost:8080/v1',
      'nas.local',
      'nas.local.',
      'http://nas.local:5000/api',
      'printer.lan',
      'http://box.home.lan:8000',
    ]) {
      expect(isLocalOrPrivateHost(target), target).toBe(true)
    }
  })

  it('matches IPv4 loopback, RFC 1918 private, and link-local ranges', () => {
    for (const target of [
      '127.0.0.1',
      '127.0.0.1:8080',
      'http://127.0.0.2:9000',
      '10.0.0.5',
      'http://10.255.255.1:8009/v1/systemone',
      '172.16.0.1',
      '172.31.255.254',
      'http://172.20.10.2:3000',
      '192.168.100.235:7000',
      'http://192.168.100.235:7000',
      '169.254.1.2',
      'http://169.254.169.254/latest',
    ]) {
      expect(isLocalOrPrivateHost(target), target).toBe(true)
    }
  })

  it('matches IPv6 loopback, ULA, link-local, and IPv4-mapped private addresses', () => {
    for (const target of [
      '[::1]:8000',
      '::1',
      'http://[::1]:8000',
      '[fd00::1]',
      '[fd12:3456::1]',
      'fd00::1',
      'http://[fc00::1]:8080',
      '[fe80::1]',
      'http://[fe80::1]:8080',
      '[fe80::1%eth0]:8080',
      '::ffff:192.168.100.235',
      '[::ffff:127.0.0.1]:8080',
      'http://[::ffff:192.168.100.235]:7000',
      'http://[::ffff:10.0.0.5]:8009',
    ]) {
      expect(isLocalOrPrivateHost(target), target).toBe(true)
    }
  })

  it('rejects public hosts, out-of-range IPs, and invalid inputs', () => {
    for (const target of [
      'example.com',
      'https://example.com:443',
      '8.8.8.8',
      'http://8.8.8.8:8009',
      '172.15.255.255',
      '172.32.0.1',
      'http://172.32.0.1:8009',
      '192.167.1.1',
      '192.169.1.1',
      '11.0.0.1',
      '169.253.1.1',
      'http://[::ffff:8.8.8.8]:7000',
      '::ffff:172.32.0.1',
      '[fec0::1]',
      '[2001:4860:4860::8888]',
      '',
      '   ',
      'local',
      'lan',
      '.local',
      '.lan',
      '.localhost',
      'localhost.example.com',
      'file:///etc/hosts',
      'http://[invalid',
    ]) {
      expect(isLocalOrPrivateHost(target), target).toBe(false)
    }
  })
})

describe('mergeNoProxy', () => {
  it('keeps the caller entries in front of the loopback defaults', () => {
    expect(mergeNoProxy('internal.example, *.corp')).toBe(
      'internal.example, *.corp,localhost,127.0.0.1,[::1]',
    )
  })

  it('ships the loopback defaults alone when the user set nothing', () => {
    expect(mergeNoProxy(undefined)).toBe('localhost,127.0.0.1,[::1]')
  })
})

describe('createMainProcessProxyDispatcher', () => {
  /** a loopback http server; `label` is what it answers with */
  const httpServer = async (label: string): Promise<{ url: string; close: () => void }> => {
    const listener: RequestListener = (_req, res) => {
      res.end(label)
    }
    const server = createServer(listener)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
  }

  it('sends loopback traffic directly even though a proxy is configured', async () => {
    const origin = await httpServer('loopback direct')
    // port 9 (discard) is not listening: a request that reached the "proxy"
    // would fail with ECONNREFUSED instead of this assertion passing
    const dispatcher = await createMainProcessProxyDispatcher('http://127.0.0.1:9')
    const { statusCode, body } = await dispatcher.request({
      origin: origin.url,
      path: '/',
      method: 'GET',
    })
    expect(statusCode).toBe(200)
    expect(await body.text()).toBe('loopback direct')
    await dispatcher.close()
    origin.close()
  })

  it('still sends everything off loopback to the proxy', async () => {
    // nothing listens on port 9, so the dispatch failing fast there is the
    // proxy being consulted at all — the loopback target above never touches it
    const dispatcher = await createMainProcessProxyDispatcher('http://127.0.0.1:9')
    await expect(
      dispatcher.request({ origin: 'http://example.com/', path: '/', method: 'GET' }),
    ).rejects.toThrow()
    await dispatcher.close()
  })

  it('honours the caller NO_PROXY entries the undici way', async () => {
    const origin = await httpServer('exempt host')
    process.env.no_proxy = '127.0.0.1'
    try {
      const dispatcher = await createMainProcessProxyDispatcher('http://127.0.0.1:9')
      const { statusCode } = await dispatcher.request({
        origin: origin.url,
        path: '/',
        method: 'GET',
      })
      expect(statusCode).toBe(200)
      await dispatcher.close()
    } finally {
      delete process.env.no_proxy
    }
    origin.close()
  })

  it('routes LAN/private origins via direct Agent and public origins via EnvHttpProxyAgent', async () => {
    const directSpy = vi.spyOn(Agent.prototype, 'dispatch').mockImplementation((_opts, handler) => {
      handler.onError?.(new Error('direct-agent'))
      return false
    })
    const proxySpy = vi
      .spyOn(EnvHttpProxyAgent.prototype, 'dispatch')
      .mockImplementation((_opts, handler) => {
        handler.onError?.(new Error('proxy-agent'))
        return false
      })

    const dispatcher = await createMainProcessProxyDispatcher('http://127.0.0.1:9')
    try {
      const privateOrigins: Array<string | URL> = [
        'http://192.168.100.235:7000',
        new URL('http://10.0.0.5:8009'),
        'http://172.16.0.1:8080',
        'http://172.31.255.254:8080',
        'http://169.254.1.2:80',
        'http://nas.local:5000',
        'http://printer.lan:631',
        'http://[fd12:3456::1]:8080',
        'http://[fe80::1]:8080',
      ]
      for (const origin of privateOrigins) {
        await expect(dispatcher.request({ origin, path: '/', method: 'GET' })).rejects.toThrow(
          'direct-agent',
        )
      }
      expect(directSpy).toHaveBeenCalledTimes(privateOrigins.length)
      expect(proxySpy).not.toHaveBeenCalled()

      const publicOrigins = ['http://example.com', 'http://172.32.0.1:8009', 'http://8.8.8.8:8080']
      for (const origin of publicOrigins) {
        await expect(dispatcher.request({ origin, path: '/', method: 'GET' })).rejects.toThrow(
          'proxy-agent',
        )
      }
      expect(proxySpy).toHaveBeenCalledTimes(publicOrigins.length)
      expect(directSpy).toHaveBeenCalledTimes(privateOrigins.length)
    } finally {
      await dispatcher.close()
    }
  })

  it('supports native Dispatcher methods like stream() directly over loopback', async () => {
    const origin = await httpServer('streamed body')
    const dispatcher = await createMainProcessProxyDispatcher('http://127.0.0.1:9')
    const chunks: Buffer[] = []
    const sink = new PassThrough()
    sink.on('data', (chunk: Buffer) => chunks.push(chunk))
    try {
      await dispatcher.stream({ origin: origin.url, path: '/', method: 'GET' }, () => sink)
      expect(Buffer.concat(chunks).toString('utf8')).toBe('streamed body')
    } finally {
      await dispatcher.close()
      origin.close()
    }
  })

  it('propagates close() and destroy() to both underlying dispatchers', async () => {
    const dispatcherA = await createMainProcessProxyDispatcher('http://127.0.0.1:9')
    await dispatcherA.close()
    await expect(
      dispatcherA.request({ origin: 'http://192.168.100.235:7000', path: '/', method: 'GET' }),
    ).rejects.toMatchObject({ code: 'UND_ERR_DESTROYED' })
    await expect(
      dispatcherA.request({ origin: 'http://example.com', path: '/', method: 'GET' }),
    ).rejects.toMatchObject({ code: 'UND_ERR_DESTROYED' })

    const dispatcherB = await createMainProcessProxyDispatcher('http://127.0.0.1:9')
    await dispatcherB.destroy()
    await expect(
      dispatcherB.request({ origin: 'http://10.0.0.5:8009', path: '/', method: 'GET' }),
    ).rejects.toMatchObject({ code: 'UND_ERR_DESTROYED' })
    await expect(
      dispatcherB.request({ origin: 'http://example.com', path: '/', method: 'GET' }),
    ).rejects.toMatchObject({ code: 'UND_ERR_DESTROYED' })
  })
})
