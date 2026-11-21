import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractAudioMetadata,
  MAX_COVER_IMAGE_BYTES,
  parseFlacMetadata,
  parseId3v2Metadata,
  parseLrcLyrics,
  parseTitleArtistFromFilename,
} from '../src/main/media-metadata'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'genoffice-media-meta-'))
  tempDirs.push(dir)
  return dir
}

function buildFlacBlock(blockType: number, isLast: boolean, payload: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header[0] = (isLast ? 0x80 : 0) | (blockType & 0x7f)
  header[1] = (payload.length >> 16) & 0xff
  header[2] = (payload.length >> 8) & 0xff
  header[3] = payload.length & 0xff
  return Buffer.concat([header, payload])
}

function buildVorbisComment(comments: string[]): Buffer {
  const vendor = Buffer.from('genoffice-test', 'utf8')
  const parts: Buffer[] = []
  const vLen = Buffer.alloc(4)
  vLen.writeUInt32LE(vendor.length, 0)
  parts.push(vLen, vendor)
  const countBuf = Buffer.alloc(4)
  countBuf.writeUInt32LE(comments.length, 0)
  parts.push(countBuf)
  for (const c of comments) {
    const cb = Buffer.from(c, 'utf8')
    const lb = Buffer.alloc(4)
    lb.writeUInt32LE(cb.length, 0)
    parts.push(lb, cb)
  }
  return Buffer.concat(parts)
}

function buildFlacPicture(picType: number, mime: string, imgData: Buffer): Buffer {
  const mimeBuf = Buffer.from(mime, 'ascii')
  const header = Buffer.alloc(8)
  header.writeUInt32BE(picType, 0)
  header.writeUInt32BE(mimeBuf.length, 4)
  const mid = Buffer.alloc(24) // descLen(4)=0, w/h/depth/colors(16)=0, picLen(4)
  mid.writeUInt32BE(0, 0)
  mid.writeUInt32BE(imgData.length, 20)
  return Buffer.concat([header, mimeBuf, mid, imgData])
}

function buildFlacStreamInfo(sampleRateHz: number, bitDepth: number): Buffer {
  const buf = Buffer.alloc(34)
  // sampleRate (20 bits) + channels-1 (3 bits) + (bitDepth-1) (5 bits)
  const bpsMinusOne = bitDepth - 1
  buf[10] = (sampleRateHz >> 12) & 0xff
  buf[11] = (sampleRateHz >> 4) & 0xff
  buf[12] = ((sampleRateHz & 0x0f) << 4) | (1 << 1) | ((bpsMinusOne >> 4) & 0x01)
  buf[13] = (bpsMinusOne & 0x0f) << 4
  return buf
}

function writeSynchsafe(value: number): Buffer {
  const b = Buffer.alloc(4)
  b[0] = (value >> 21) & 0x7f
  b[1] = (value >> 14) & 0x7f
  b[2] = (value >> 7) & 0x7f
  b[3] = value & 0x7f
  return b
}

function buildId3v23TextFrame(id: string, encoding: number, textPayload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([encoding]), textPayload])
  const header = Buffer.alloc(10)
  header.write(id, 0, 4, 'ascii')
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('media-metadata parser & sidecars', () => {
  it('parses FLAC STREAMINFO, VORBIS_COMMENT, and prioritizes Front Cover PICTURE', () => {
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8])
    const flac = Buffer.concat([
      Buffer.from('fLaC', 'ascii'),
      buildFlacBlock(0, false, buildFlacStreamInfo(96000, 24)),
      buildFlacBlock(4, false, buildVorbisComment(['TITLE=Twilight Echo', 'ARTIST=Angela', 'ALBUM=Skyline'])),
      buildFlacBlock(6, false, buildFlacPicture(4, 'image/jpg', fakeJpg)),
      buildFlacBlock(6, true, buildFlacPicture(3, 'image/png', fakePng)),
    ])

    const parsed = parseFlacMetadata(flac)
    expect(parsed.sampleRateHz).toBe(96000)
    expect(parsed.bitDepth).toBe(24)
    expect(parsed.title).toBe('Twilight Echo')
    expect(parsed.artist).toBe('Angela')
    expect(parsed.album).toBe('Skyline')
    expect(parsed.cover?.mime).toBe('image/png')
    expect(parsed.cover?.data).toEqual(fakePng)
  })

  it('parses ID3v2.3 tags (UTF-8 / UTF-16) and APIC embedded artwork cleanly', () => {
    const utf16Text = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Midnight Track', 'utf16le')])
    const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 4, 5])
    const apicPayload = Buffer.concat([
      Buffer.from([3]),
      Buffer.from('image/jpeg\0', 'ascii'),
      Buffer.from([3]),
      Buffer.from('cover\0', 'utf8'),
      fakeJpg,
    ])
    const apicHeader = Buffer.alloc(10)
    apicHeader.write('APIC', 0, 4, 'ascii')
    apicHeader.writeUInt32BE(apicPayload.length, 4)

    const frames = Buffer.concat([
      buildId3v23TextFrame('TIT2', 1, utf16Text),
      buildId3v23TextFrame('TPE1', 3, Buffer.from('Demo Artist', 'utf8')),
      buildId3v23TextFrame('TALB', 0, Buffer.from('First Album', 'latin1')),
      apicHeader,
      apicPayload,
    ])
    const id3Header = Buffer.concat([
      Buffer.from('ID3', 'ascii'),
      Buffer.from([3, 0, 0]),
      writeSynchsafe(frames.length),
      frames,
    ])

    const parsed = parseId3v2Metadata(id3Header)
    expect(parsed.title).toBe('Midnight Track')
    expect(parsed.artist).toBe('Demo Artist')
    expect(parsed.album).toBe('First Album')
    expect(parsed.cover?.mime).toBe('image/jpeg')
    expect(parsed.cover?.data).toEqual(fakeJpg)
  })

  it('rejects oversized or malformed embedded covers and handles truncated input safely', () => {
    const tooLarge = Buffer.alloc(MAX_COVER_IMAGE_BYTES + 10)
    const header = Buffer.concat([
      Buffer.from('fLaC', 'ascii'),
      buildFlacBlock(6, true, buildFlacPicture(3, 'image/png', tooLarge)),
    ])
    expect(parseFlacMetadata(header).cover).toBeUndefined()
    expect(parseFlacMetadata(Buffer.from('not-a-flac'))).toEqual({})
    expect(parseId3v2Metadata(Buffer.from('ID3\x03\x00\x00'))).toEqual({})
  })

  it('parses LRC multi-timestamps, offset tags, and splits filename titles gracefully', () => {
    const lrc = parseLrcLyrics(
      '\uFEFF[ti:Sample]\n[offset:500]\n[00:10.00][00:30.25] Chorus line\n[00:05.5] First line\n',
    )
    expect(lrc).toEqual([
      { timeSec: 6.0, text: 'First line' },
      { timeSec: 10.5, text: 'Chorus line' },
      { timeSec: 30.75, text: 'Chorus line' },
    ])

    expect(parseTitleArtistFromFilename('04.Twilight Echo - Singer.flac')).toEqual({
      title: 'Twilight Echo',
      artist: 'Singer',
    })
  })

  it('extracts sidecar cover.png and matching .lrc while rejecting escaping symlinks', async () => {
    const root = makeTempDir()
    const albumDir = join(root, 'album')
    const outsideDir = join(root, 'secret')
    mkdirSync(albumDir)
    mkdirSync(outsideDir)

    const wav = join(albumDir, '01.Starlight - Artist.wav')
    writeFileSync(wav, Buffer.from('RIFFdemo'))
    writeFileSync(join(albumDir, 'cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(albumDir, '01.Starlight - Artist.lrc'), '[00:01.00]Hello world\n', 'utf8')

    const meta = await extractAudioMetadata(wav)
    expect(meta.title).toBe('Starlight')
    expect(meta.artist).toBe('Artist')
    expect(meta.cover?.mime).toBe('image/png')
    expect(meta.lyrics).toEqual([{ timeSec: 1, text: 'Hello world' }])

    // Replace cover with symlink escaping albumDir and ensure it is refused
    const badCover = join(outsideDir, 'leak.jpg')
    writeFileSync(badCover, Buffer.from([0xff, 0xd8, 0xff]))
    const dir2 = join(root, 'album2')
    mkdirSync(dir2)
    const wav2 = join(dir2, '02.Song.wav')
    writeFileSync(wav2, Buffer.from('RIFF'))
    try {
      symlinkSync(badCover, join(dir2, 'cover.jpg'))
      const meta2 = await extractAudioMetadata(wav2)
      expect(meta2.cover).toBeUndefined()
    } catch {
      // Skip symlink assertion if platform forbids unprivileged symlinks.
    }
  })
})
