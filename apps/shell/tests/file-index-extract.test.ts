import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractText } from '../src/main/file-index/extract'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-extract-'))
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('extractText', () => {
  it('indexes image and audio/video files by name without throwing parse errors', async () => {
    const pngPath = join(dir, 'banner.png')
    const jpgPath = join(dir, 'photo.jpg')
    const mp4Path = join(dir, 'clip.mp4')
    const mp3Path = join(dir, 'voice.mp3')
    writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(jpgPath, Buffer.from([0xff, 0xd8, 0xff]))
    writeFileSync(mp4Path, Buffer.from([0x00, 0x00, 0x00]))
    writeFileSync(mp3Path, Buffer.from([0x49, 0x44, 0x33]))

    expect(await extractText(pngPath)).toEqual({ kind: 'name-only' })
    expect(await extractText(jpgPath)).toEqual({ kind: 'name-only' })
    expect(await extractText(mp4Path)).toEqual({ kind: 'name-only' })
    expect(await extractText(mp3Path)).toEqual({ kind: 'name-only' })
  })

  it('extracts searchable plain text for config and code files', async () => {
    const yamlPath = join(dir, 'config.yaml')
    const tomlPath = join(dir, 'Cargo.toml')
    const tsPath = join(dir, 'app.ts')
    writeFileSync(yamlPath, 'service: gateway\nport: 8080\n', 'utf8')
    writeFileSync(tomlPath, '[package]\nname = "genoffice"\n', 'utf8')
    writeFileSync(tsPath, 'export const version = 3\n', 'utf8')

    expect(await extractText(yamlPath)).toEqual({
      kind: 'text',
      text: 'service: gateway\nport: 8080\n',
    })
    expect(await extractText(tomlPath)).toEqual({
      kind: 'text',
      text: '[package]\nname = "genoffice"\n',
    })
    expect(await extractText(tsPath)).toEqual({
      kind: 'text',
      text: 'export const version = 3\n',
    })
  })
})
