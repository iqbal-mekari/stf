import {EventEmitter} from 'events'

import logger from '../../../util/logger.js'
import {createMjpegReader} from '../wda/mjpeg.js'
import type {MjpegReader} from '../wda/mjpeg.js'
import {errorMessage} from '../util.js'

export interface FrameSource {
  // Read on every (re)connect, WebDriverAgent may have moved.
  mjpegUrl(): string
  screenshot(): Promise<Buffer>
}

export interface FrameProducerOptions {
  // Fall back to screenshot polling when MJPEG delivers no frame for this
  // long (ms), whether it never started or stalled later.
  fallbackTimeout: number
  // Upper bound for the polling frame rate.
  pollFrameRate: number
  // While polling, check this often (ms) whether MJPEG works again.
  // 0 never checks.
  mjpegRetryInterval: number
  // MJPEG reconnect delay after a dropped stream (ms).
  reconnectDelay?: number
}

export type FrameMode = 'idle' | 'mjpeg' | 'polling'

interface FrameProducerEvents {
  frame: [frame: Buffer]
  mode: [mode: FrameMode]
}

// Produces complete screen images, from the WebDriverAgent MJPEG stream when
// it delivers and from polled screenshots otherwise. Some WebDriverAgent
// builds (notably on simulators) accept MJPEG connections but never send a
// frame, while GET /screenshot keeps working.
export class IosFrameProducer extends EventEmitter<FrameProducerEvents> {
  mode: FrameMode = 'idle'
  private log = logger.createLogger('ios-device:screen:producer')
  // Bumped on every mode change; callbacks of an older mode see a stale
  // generation and do nothing.
  private generation = 0
  private reader: MjpegReader | null = null
  private probe: MjpegReader | null = null
  private timers = new Set<NodeJS.Timeout>()
  private lastMjpegFrame = 0

  constructor(private source: FrameSource, private options: FrameProducerOptions) {
    super()
  }

  start() {
    if (this.mode !== 'idle') {
      return
    }
    this.startMjpeg()
  }

  stop() {
    if (this.mode === 'idle') {
      return
    }
    this.reset()
    this.setMode('idle')
  }

  // Starts over with MJPEG, e.g. after WebDriverAgent was restarted.
  restart() {
    if (this.mode === 'idle') {
      return
    }
    this.reset()
    this.startMjpeg()
  }

  private setMode(mode: FrameMode) {
    if (this.mode !== mode) {
      this.mode = mode
      this.emit('mode', mode)
    }
  }

  private reset() {
    this.generation += 1
    this.reader?.stop()
    this.reader = null
    this.probe?.stop()
    this.probe = null
    for (const timer of this.timers) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }

  private later(ms: number, fn: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    this.timers.add(timer)
  }

  private openMjpeg(onFrame: (frame: Buffer) => void) {
    return createMjpegReader(this.source.mjpegUrl(), {
      onFrame: onFrame
    , onError: (err) => {
        this.log.debug('MJPEG stream error: %s', err.message)
      }
    , reconnectDelayMs: this.options.reconnectDelay ?? 500
    })
  }

  private startMjpeg() {
    const gen = ++this.generation
    this.setMode('mjpeg')
    this.lastMjpegFrame = Date.now()
    this.reader = this.openMjpeg((frame) => {
      if (gen === this.generation) {
        this.lastMjpegFrame = Date.now()
        this.emit('frame', frame)
      }
    })
    this.reader.start()
    this.watch(gen, this.options.fallbackTimeout)
  }

  private watch(gen: number, delay: number) {
    this.later(delay, () => {
      if (gen !== this.generation) {
        return
      }
      const idle = Date.now() - this.lastMjpegFrame
      if (idle >= this.options.fallbackTimeout) {
        this.startPolling(idle)
      }
      else {
        this.watch(gen, this.options.fallbackTimeout - idle)
      }
    })
  }

  private startPolling(idle: number) {
    this.log.info(
      'No MJPEG frame for %d ms, switching to screenshot polling'
    , idle
    )
    this.reset()
    const gen = this.generation
    this.setMode('polling')
    this.poll(gen)
    this.scheduleProbe(gen)
  }

  private poll(gen: number) {
    const started = Date.now()
    const interval = 1000 / Math.max(0.1, this.options.pollFrameRate)
    this.source.screenshot()
      .then((frame) => {
        if (gen === this.generation) {
          this.emit('frame', frame)
        }
      })
      .catch((err) => {
        this.log.debug('Screenshot failed: %s', errorMessage(err))
      })
      .finally(() => {
        if (gen === this.generation) {
          this.later(Math.max(0, interval - (Date.now() - started)), () => {
            this.poll(gen)
          })
        }
      })
  }

  // Listens to MJPEG next to the polling, and only switches back once a
  // frame actually arrives, so a still silent stream never freezes the
  // screen.
  private scheduleProbe(gen: number) {
    if (this.options.mjpegRetryInterval <= 0) {
      return
    }
    this.later(this.options.mjpegRetryInterval, () => {
      if (gen !== this.generation) {
        return
      }
      this.log.debug('Checking whether MJPEG delivers frames again')
      this.probe = this.openMjpeg(() => {
        if (gen === this.generation) {
          this.log.info('MJPEG delivers frames again, leaving screenshot polling')
          this.reset()
          this.startMjpeg()
        }
      })
      this.probe.start()
      this.later(this.options.fallbackTimeout, () => {
        if (gen === this.generation) {
          this.probe?.stop()
          this.probe = null
          this.scheduleProbe(gen)
        }
      })
    })
  }
}
