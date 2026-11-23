const DEFAULT_MAX_REPLAY_BYTES = 256 * 1024

interface BufferedSegment {
  text: string
  bytes: number
}

/**
 * Slice the trailing UTF-8 bytes without leaving leading continuation bytes (`0x80..0xBF`),
 * preventing replacement-character corruption when truncating oversized chunks.
 */
function sliceTrailingUtf8Safe(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || !value) return ''
  const buf = Buffer.from(value, 'utf8')
  if (buf.length <= maxBytes) return value

  const tail = buf.subarray(buf.length - maxBytes)
  let startOffset = 0
  // Skip orphan UTF-8 continuation bytes so we start at a valid multi-byte code point boundary.
  while (startOffset < tail.length && startOffset < 3 && (tail[startOffset]! & 0xc0) === 0x80) {
    startOffset += 1
  }
  return tail.subarray(startOffset).toString('utf8')
}

/**
 * Fixed-capacity byte ring buffer holding recent raw VT sequences for seamless
 * replay across drawer/tab docking and pane remounts.
 */
export class PtyReplayBuffer {
  private readonly maxBytes: number
  private segments: BufferedSegment[] = []
  private headIndex = 0
  private totalBytes = 0

  constructor(maxBytes = DEFAULT_MAX_REPLAY_BYTES) {
    this.maxBytes = Math.max(0, Math.floor(maxBytes))
  }

  get byteLength(): number {
    return this.totalBytes
  }

  append(chunk: string): void {
    if (!chunk || this.maxBytes <= 0) return

    const chunkBytes = Buffer.byteLength(chunk, 'utf8')
    if (chunkBytes >= this.maxBytes) {
      const clipped = sliceTrailingUtf8Safe(chunk, this.maxBytes)
      this.segments = clipped ? [{ text: clipped, bytes: Buffer.byteLength(clipped, 'utf8') }] : []
      this.headIndex = 0
      this.totalBytes = clipped ? this.segments[0]!.bytes : 0
      return
    }

    this.segments.push({ text: chunk, bytes: chunkBytes })
    this.totalBytes += chunkBytes

    while (this.totalBytes > this.maxBytes && this.headIndex < this.segments.length) {
      const dropped = this.segments[this.headIndex]!
      this.totalBytes -= dropped.bytes
      this.headIndex += 1
    }

    if (this.headIndex >= 64 && this.headIndex * 2 >= this.segments.length) {
      this.segments = this.segments.slice(this.headIndex)
      this.headIndex = 0
    }
  }

  snapshot(): string {
    if (this.headIndex >= this.segments.length) return ''
    if (this.headIndex === 0) {
      return this.segments.map((seg) => seg.text).join('')
    }
    return this.segments
      .slice(this.headIndex)
      .map((seg) => seg.text)
      .join('')
  }

  clear(): void {
    this.segments = []
    this.headIndex = 0
    this.totalBytes = 0
  }
}
