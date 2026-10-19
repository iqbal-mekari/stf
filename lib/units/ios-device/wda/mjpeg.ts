import {EventEmitter} from 'node:events'

const SOI = Buffer.from([0xff, 0xd8, 0xff])
const EOI = Buffer.from([0xff, 0xd9])
// Bytes kept while no frame start is in sight, enough for any part header.
const KEEP_BYTES = 4096
const LENGTH_PATTERN = /content-length:\s*(\d+)/gi

// Splits a multipart/x-mixed-replace MJPEG byte stream into JPEG frames.
// Emits 'frame' with a Buffer holding exactly one JPEG.
export class MjpegParser extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (this.extract()) {
      // Keep extracting until the buffer holds no complete frame.
    }
  }

  reset() {
    this.buffer = Buffer.alloc(0)
  }

  private extract() {
    const buf = this.buffer
    const start = buf.indexOf(SOI)
    if (start === -1) {
      if (buf.length > KEEP_BYTES) {
        this.buffer = buf.subarray(buf.length - KEEP_BYTES)
      }
      return false
    }

    // The part header sits between the previous frame and this start marker.
    const prefix = buf.subarray(0, start).toString('latin1')
    let length: number | undefined, end: number
    for (const match of prefix.matchAll(LENGTH_PATTERN)) {
      length = Number(match[1])
    }

    if (length !== undefined && length >= SOI.length) {
      end = start + length
      if (buf.length < end) {
        return false
      }
    }
    else {
      const eoi = buf.indexOf(EOI, start + SOI.length)
      if (eoi === -1) {
        return false
      }
      end = eoi + EOI.length
    }

    // Copy so a retained frame does not pin the whole receive buffer.
    const frame = Buffer.from(buf.subarray(start, end))
    this.buffer = buf.subarray(end)
    this.emit('frame', frame)
    return true
  }
}

export interface MjpegReaderOptions {
  onFrame: (frame: Buffer) => void
  onError?: (err: Error) => void
  reconnectDelayMs?: number
}

export interface MjpegReader {
  start(): void
  stop(): void
}

export function createMjpegReader(url: string, opts: MjpegReaderOptions): MjpegReader {
  const reconnectDelayMs = opts.reconnectDelayMs ?? 500
  let running = false
  let generation = 0
  let controller: AbortController | undefined, wake: (() => void) | undefined

  function sleep(ms: number) {
    return new Promise<void>(function(resolve) {
      const timer = setTimeout(done, ms)
      function done() {
        clearTimeout(timer)
        wake = undefined
        resolve()
      }
      wake = done
    })
  }

  async function stream(signal: AbortSignal) {
    const res = await fetch(url, {signal: signal})
    if (!res.ok || !res.body) {
      throw new Error('MJPEG GET failed with HTTP ' + res.status)
    }
    const parser = new MjpegParser()
    parser.on('frame', opts.onFrame)
    for await (const chunk of res.body) {
      parser.push(Buffer.from(chunk))
    }
  }

  async function loop(gen: number) {
    const active = () => running && gen === generation
    while (active()) {
      controller = new AbortController()
      try {
        await stream(controller.signal)
      }
      catch (err) {
        if (active() && opts.onError) {
          opts.onError(err instanceof Error ? err : new Error(String(err)))
        }
      }
      if (active()) {
        await sleep(reconnectDelayMs)
      }
    }
  }

  return {
    start() {
      if (running) {
        return
      }
      running = true
      generation++
      loop(generation).catch(function() {
        // loop() reports stream errors through onError and never rejects.
      })
    }

  , stop() {
      running = false
      controller?.abort()
      wake?.()
    }
  }
}
