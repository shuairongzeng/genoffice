import { describe, expect, it } from 'vitest'
import { isSafeRevealPath } from '../src/main/reveal-path-guard'

describe('isSafeRevealPath', () => {
  it('allows local absolute paths on POSIX and Windows', () => {
    if (process.platform === 'win32') {
      expect(isSafeRevealPath('C:\\Users\\alice\\report.docx')).toBe(true)
      expect(isSafeRevealPath('D:/work/notes.pdf')).toBe(true)
    } else {
      expect(isSafeRevealPath('/Users/alice/report.docx')).toBe(true)
    }
  })

  it('rejects relative paths', () => {
    expect(isSafeRevealPath('report.docx')).toBe(false)
    expect(isSafeRevealPath('./report.docx')).toBe(false)
    expect(isSafeRevealPath('../secret.txt')).toBe(false)
  })

  it('rejects UNC network share paths', () => {
    expect(isSafeRevealPath('\\\\server\\share\\file.docx')).toBe(false)
    expect(isSafeRevealPath('//server/share/file.docx')).toBe(false)
    expect(isSafeRevealPath('\\\\?\\UNC\\server\\share\\file.docx')).toBe(false)
  })

  it('rejects non-strings, empty strings, and NUL bytes', () => {
    expect(isSafeRevealPath('')).toBe(false)
    expect(isSafeRevealPath(null)).toBe(false)
    expect(isSafeRevealPath(undefined)).toBe(false)
    expect(isSafeRevealPath(123)).toBe(false)
    expect(isSafeRevealPath('/tmp/bad\0name')).toBe(false)
  })
})
