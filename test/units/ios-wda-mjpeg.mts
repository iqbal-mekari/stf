import {expect} from 'chai'

import {MjpegParser, createMjpegReader} from '../../lib/units/ios-device/wda/mjpeg.js'
import {startFakeWda} from '../../lib/units/ios-device/wda/fake-server.js'

// Minimal JPEG-shaped payloads: SOI, marker, unique body without FFD9, EOI.
function fakeJpeg(id: number, size: number) {
  const body = Buffer.alloc(size, id & 0x7f)
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  , body
  , Buffer.from([0xff, 0xd9])
  ])
}

function part(data: Buffer, withLength = true) {
  const header = '--BoundaryString\r\nContent-type: image/jpeg\r\n' +
    (withLength ? 'Content-Length: ' + data.length + '\r\n' : '') + '\r\n'
  return Buffer.concat([Buffer.from(header), data, Buffer.from('\r\n\r\n')])
}

// Deterministic PRNG (mulberry32).
function seeded(seed: number) {
  let a = seed
  return function() {
    a = a + 0x6d2b79f5 | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function collect(parser: MjpegParser) {
  const frames: Buffer[] = []
  parser.on('frame', function(f: Buffer) {
    frames.push(f)
  })
  return frames
}

function feedRandomly(parser: MjpegParser, data: Buffer, rand: () => number) {
  let offset = 0
  while (offset < data.length) {
    const n = 1 + Math.floor(rand() * 64)
    parser.push(data.subarray(offset, offset + n))
    offset += n
  }
}

describe('MjpegParser', function() {
  it('parses frames split at random byte boundaries', function() {
    for (let seed = 1; seed <= 50; seed++) {
      const rand = seeded(seed)
      const sent = [1, 2, 3, 4, 5].map(function(i) {
        return fakeJpeg(i, 10 + Math.floor(rand() * 300))
      })
      const stream = Buffer.concat(sent.map(function(f) {
        return part(f)
      }))
      const parser = new MjpegParser()
      const frames = collect(parser)
      feedRandomly(parser, stream, rand)
      expect(frames, 'seed ' + seed).to.have.length(sent.length)
      frames.forEach(function(f, i) {
        expect(f.equals(sent[i]!), 'seed ' + seed + ' frame ' + i).to.equal(true)
      })
    }
  })

  it('handles one-byte chunks', function() {
    const sent = [fakeJpeg(1, 50), fakeJpeg(2, 70)]
    const stream = Buffer.concat(sent.map(function(f) {
      return part(f)
    }))
    const parser = new MjpegParser()
    const frames = collect(parser)
    for (const byte of stream) {
      parser.push(Buffer.from([byte]))
    }
    expect(frames).to.have.length(2)
    expect(frames[1]!.equals(sent[1]!)).to.equal(true)
  })

  it('emits several frames from one chunk', function() {
    const sent = [fakeJpeg(1, 20), fakeJpeg(2, 30), fakeJpeg(3, 40)]
    const parser = new MjpegParser()
    const frames = collect(parser)
    parser.push(Buffer.concat(sent.map(function(f) {
      return part(f)
    })))
    expect(frames).to.have.length(3)
  })

  it('falls back to SOI/EOI scanning without Content-Length', function() {
    for (let seed = 1; seed <= 20; seed++) {
      const rand = seeded(seed)
      const sent = [fakeJpeg(1, 100), fakeJpeg(2, 200), fakeJpeg(3, 5)]
      const stream = Buffer.concat(sent.map(function(f) {
        return part(f, false)
      }))
      const parser = new MjpegParser()
      const frames = collect(parser)
      feedRandomly(parser, stream, rand)
      expect(frames, 'seed ' + seed).to.have.length(3)
      frames.forEach(function(f, i) {
        expect(f.equals(sent[i]!)).to.equal(true)
      })
    }
  })

  it('skips garbage between frames', function() {
    const sent = [fakeJpeg(1, 60), fakeJpeg(2, 80)]
    const parser = new MjpegParser()
    const frames = collect(parser)
    const garbage = Buffer.from('\r\nnoise \x00\x01\x02 --partial\r\n')
    parser.push(Buffer.concat([garbage, part(sent[0]!), garbage, part(sent[1]!, false), garbage]))
    expect(frames).to.have.length(2)
    expect(frames[0]!.equals(sent[0]!)).to.equal(true)
    expect(frames[1]!.equals(sent[1]!)).to.equal(true)
  })

  it('bounds memory while no frame is in sight', function() {
    const parser = new MjpegParser()
    const frames = collect(parser)
    parser.push(Buffer.alloc(1 << 20, 0x41))
    parser.push(part(fakeJpeg(1, 10)))
    expect(frames).to.have.length(1)
  })
})

describe('createMjpegReader', function() {
  it('receives distinct frames from the fake server and stops cleanly', async function() {
    const fake = await startFakeWda({framerate: 30})
    const seen = new Set<string>()
    let total = 0
    const done = new Promise<void>(function(resolve) {
      const reader = createMjpegReader(fake.mjpegUrl, {
        onFrame: function(frame) {
          expect(frame[0]).to.equal(0xff)
          expect(frame[1]).to.equal(0xd8)
          seen.add(frame.toString('base64'))
          total++
          if (seen.size >= 3) {
            reader.stop()
            resolve()
          }
        }
      })
      reader.start()
    })
    try {
      await done
      expect(seen.size).to.be.at.least(3)
      const after = total
      await new Promise(function(resolve) {
        setTimeout(resolve, 150)
      })
      expect(total).to.equal(after)
    }
    finally {
      await fake.close()
    }
  })

  it('reconnects after the server goes away', async function() {
    let fake = await startFakeWda({framerate: 30})
    const port = Number(new URL(fake.mjpegUrl).port)
    const errors: Error[] = []
    let frames = 0
    const reader = createMjpegReader(fake.mjpegUrl, {
      onFrame: function() {
        frames++
      }
    , onError: function(err) {
        errors.push(err)
      }
    , reconnectDelayMs: 50
    })
    try {
      reader.start()
      await waitFor(function() {
        return frames > 0
      })
      await fake.close()
      await waitFor(function() {
        return errors.length > 0
      })
      const before = frames
      fake = await startFakeWda({framerate: 30, mjpegPort: port})
      await waitFor(function() {
        return frames > before
      })
    }
    finally {
      reader.stop()
      await fake.close()
    }
  })
})

async function waitFor(cond: () => boolean, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise(function(resolve) {
      setTimeout(resolve, 20)
    })
  }
}
