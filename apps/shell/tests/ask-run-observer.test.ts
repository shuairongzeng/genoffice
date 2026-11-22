import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  addAskRunObserver,
  notifyRunBegin,
  notifyRunConfirm,
  notifyRunEvent,
  notifyRunFinish,
} from '../src/main/ask-run-observer'

const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose()
  }
})

describe('ask-run-observer', () => {
  it('broadcasts begin, event, confirm, and finish to every registered observer', () => {
    const eventsA: string[] = []
    const eventsB: string[] = []

    disposers.push(
      addAskRunObserver({
        onBegin: (input) => eventsA.push(`begin:${input.sessionKey}`),
        onEvent: (evt) => eventsA.push(`evt:${evt.type}`),
        onConfirm: (key, req) => eventsA.push(`confirm:${key}:${req ? req.requestId : 'null'}`),
        onFinish: (key) => eventsA.push(`finish:${key}`),
      }),
      addAskRunObserver({
        onBegin: (input) => eventsB.push(`begin:${input.sessionKey}`),
        onEvent: (evt) => eventsB.push(`evt:${evt.type}`),
        onConfirm: (key, req) => eventsB.push(`confirm:${key}:${req ? req.requestId : 'null'}`),
        onFinish: (key) => eventsB.push(`finish:${key}`),
      }),
    )

    notifyRunBegin({
      sessionKey: 'default:c1',
      projectId: 'default',
      chatId: 'c1',
      docPath: null,
      userText: 'hello',
    })
    notifyRunEvent({ type: 'text', sessionKey: 'default:c1', payload: 'hi' })
    notifyRunConfirm('default:c1', {
      requestId: 'req-1',
      sessionKey: 'default:c1',
      call: { id: 't1', name: 'bash', args: {} },
      sessionAllowable: true,
    })
    notifyRunConfirm('default:c1', null)
    notifyRunFinish('default:c1')

    const expected = [
      'begin:default:c1',
      'evt:text',
      'confirm:default:c1:req-1',
      'confirm:default:c1:null',
      'finish:default:c1',
    ]
    expect(eventsA).toEqual(expected)
    expect(eventsB).toEqual(expected)
  })

  it('isolates throwing observers so other observers still receive every callback', () => {
    const onFinishHealthy = vi.fn()
    disposers.push(
      addAskRunObserver({
        onBegin: () => {
          throw new Error('boom begin')
        },
        onEvent: () => {
          throw new Error('boom event')
        },
        onConfirm: () => {
          throw new Error('boom confirm')
        },
        onFinish: () => {
          throw new Error('boom finish')
        },
      }),
      addAskRunObserver({
        onFinish: onFinishHealthy,
      }),
    )

    expect(() => {
      notifyRunBegin({
        sessionKey: 'default:c2',
        projectId: 'default',
        chatId: 'c2',
        docPath: null,
        userText: 'hi',
      })
      notifyRunEvent({ type: 'done', sessionKey: 'default:c2', payload: null })
      notifyRunConfirm('default:c2', null)
      notifyRunFinish('default:c2')
    }).not.toThrow()

    expect(onFinishHealthy).toHaveBeenCalledWith('default:c2')
  })

  it('stops notifying after the disposer is invoked', () => {
    const onBegin = vi.fn()
    const dispose = addAskRunObserver({ onBegin })
    disposers.push(dispose)

    dispose()
    notifyRunBegin({
      sessionKey: 'default:c3',
      projectId: 'default',
      chatId: 'c3',
      docPath: null,
      userText: 'hi',
    })
    expect(onBegin).not.toHaveBeenCalled()
  })
})
