import { describe, expect, it } from 'vitest'
import { shouldReclaimDevLock } from '../src/main/dev-lock-policy'

describe('shouldReclaimDevLock', () => {
  it('returns true when launched without deep links or document paths', () => {
    expect(
      shouldReclaimDevLock(['electron.exe', 'apps/shell', '--remote-debugging-port=9225'], []),
    ).toBe(true)
  })

  it('returns false when argv carries a genoffice:// deep link', () => {
    expect(shouldReclaimDevLock(['electron.exe', 'apps/shell', 'genoffice://butler'], [])).toBe(
      false,
    )
    expect(
      shouldReclaimDevLock(['electron.exe', 'apps/shell', 'genoffice://open?path=foo'], []),
    ).toBe(false)
  })

  it('returns false when document launch paths are present', () => {
    expect(
      shouldReclaimDevLock(
        ['electron.exe', 'apps/shell', 'D:/docs/report.docx'],
        ['D:/docs/report.docx'],
      ),
    ).toBe(false)
  })
})
