import childProcess from 'node:child_process'
import http from 'node:http'
import type {ChildProcess} from 'node:child_process'

import logger from '../../../util/logger.js'
import type {WdaHandle} from '../types.js'

const log = logger.createLogger('ios-device:backend:exec')

const DEFAULT_TIMEOUT = 120000
const KILL_TIMEOUT = 5000
const STDERR_TAIL = 4096

export class ExecError extends Error {
  code: number | string | null
  stderr: string
  timedOut: boolean

  constructor(
    message: string
  , code: number | string | null
  , stderr: string
  , timedOut = false
  ) {
    super(message)
    this.name = 'ExecError'
    this.code = code
    this.stderr = stderr
    this.timedOut = timedOut
  }
}

export interface RunOptions {
  timeout?: number | undefined
  env?: NodeJS.ProcessEnv
}

export interface RunResult {
  stdout: string
  stderr: string
}

// Log the command name only: arguments may carry signing secrets later on.
export function run(
  cmd: string
, args: string[]
, opts: RunOptions = {}
): Promise<RunResult> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT
  log.debug('Running %s', cmd)
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      cmd
    , args
    , {
        timeout
      , maxBuffer: 16 * 1024 * 1024
      , env: opts.env ? {...process.env, ...opts.env} : process.env
      , encoding: 'utf8'
      }
    , (err, stdout, stderr) => {
        if (!err) {
          return resolve({stdout, stderr})
        }
        const failure = err as NodeJS.ErrnoException & {
          killed?: boolean
          code?: number | string
        }
        const trimmed = String(stderr || '').trim()
        const timedOut = Boolean(failure.killed)
        const code = timedOut ? null : failure.code ?? null
        const reason = timedOut ?
          `timed out after ${timeout}ms` :
          `failed with code ${code}`
        reject(new ExecError(
          `${cmd} ${reason}${trimmed ? ': ' + trimmed : ''}`
        , code
        , trimmed
        , timedOut
        ))
      }
    )
  })
}

export interface ExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface SpawnOptions {
  env?: NodeJS.ProcessEnv
  onExit?: (info: ExitInfo) => void
  killTimeout?: number | undefined
}

export interface LongRunning {
  child: ChildProcess
  // SIGTERM, then SIGKILL after the kill timeout (5s by default).
  stop(): Promise<void>
  exited: Promise<ExitInfo>
  // Last few KiB of stderr, for error messages.
  stderrTail(): string
}

export function spawnLongRunning(
  cmd: string
, args: string[]
, opts: SpawnOptions = {}
): LongRunning {
  log.debug('Spawning %s', cmd)
  const child = childProcess.spawn(cmd, args, {
    env: opts.env ? {...process.env, ...opts.env} : process.env
  , stdio: ['ignore', 'pipe', 'pipe']
  })
  let tail = ''
  let done = false
  child.stdout?.resume()
  child.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-STDERR_TAIL)
  })
  const exited = new Promise<ExitInfo>(resolve => {
    const finish = (info: ExitInfo) => {
      if (done) {
        return
      }
      done = true
      resolve(info)
      if (opts.onExit) {
        opts.onExit(info)
      }
    }
    child.on('exit', (code, signal) => finish({code, signal}))
    child.on('error', err => {
      tail = (tail + '\n' + err.message).slice(-STDERR_TAIL)
      // A spawn failure (ENOENT) never emits 'exit'.
      if (child.pid === undefined) {
        finish({code: null, signal: null})
      }
    })
  })
  return {
    child
  , exited
  , stderrTail: () => tail.trim()
  , async stop() {
      if (done) {
        return
      }
      child.kill('SIGTERM')
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
      }, opts.killTimeout ?? KILL_TIMEOUT)
      try {
        await exited
      }
      finally {
        clearTimeout(timer)
      }
    }
  }
}

// Resolves with the HTTP status code, or null when nothing answers.
export function httpStatus(url: string, timeout = 1000): Promise<number | null> {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      res.resume()
      resolve(res.statusCode ?? null)
    })
    req.setTimeout(timeout, () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
  })
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export interface SuperviseWdaOptions {
  label: string
  procs: LongRunning[]
  wdaUrl: string
  mjpegUrl: string
  startTimeout: number
  pollInterval: number
}

// Shared by the backends: waits until WDA answers /status, then hands back a
// handle whose `exited` fires when any supervising process dies. On timeout
// or early exit every process is killed before rejecting.
export async function superviseWda(opts: SuperviseWdaOptions): Promise<WdaHandle> {
  const {procs} = opts
  const stopAll = async() => {
    await Promise.all(procs.map(p => p.stop()))
  }
  const exited = Promise.race(procs.map(p => p.exited)).then(() => undefined)

  let failure: string | null = null
  const earlyExit = exited.then(() => {
    failure = failure ?? 'a WebDriverAgent process exited before it became ready'
  })
  const deadline = Date.now() + opts.startTimeout
  let ready = false
  while (failure === null) {
    if (await httpStatus(opts.wdaUrl + '/status') === 200) {
      ready = true
      break
    }
    if (Date.now() >= deadline) {
      failure = `WebDriverAgent (${opts.label}) did not answer /status ` +
        `within ${opts.startTimeout}ms`
      break
    }
    await Promise.race([sleep(opts.pollInterval), earlyExit])
  }

  if (!ready) {
    const detail = procs.map(p => p.stderrTail()).filter(Boolean).join('\n')
    await stopAll()
    throw new Error(failure + (detail ? ': ' + detail : ''))
  }

  return {
    wdaUrl: opts.wdaUrl
  , mjpegUrl: opts.mjpegUrl
  , exited
  , stop: stopAll
  }
}
