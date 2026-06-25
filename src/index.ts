/**
 * rainbird-node — control a Rain Bird irrigation controller over its LNK/LNK2
 * WiFi module on the local network. Promise-first, zero runtime dependencies.
 *
 * The LNK module speaks a reverse-engineered local "SIP" protocol: an
 * AES-256-CBC-encrypted JSON-RPC envelope POSTed to `/stick`, keyed by the
 * SHA-256 of the device password. v2 controllers use HTTPS with a self-signed
 * cert; older ones use plain HTTP. We auto-discover which on the first call.
 *
 *   import { RainBird } from 'rainbird-node'
 *   const rb = new RainBird({ address: '192.168.1.50', password: 'xxxx' })
 *   console.log(await rb.getModelAndVersion())   // { modelName, version, ... }
 *   console.log(await rb.getAvailableZones())     // { zones: [1,2,3,...] }
 *   await rb.startZone(3, 600)                     // zone 3 for 600s (10 min)
 *   await rb.stopIrrigation()
 */

import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

export interface RainBirdOptions {
  /** IP address or hostname of the LNK/LNK2 WiFi module. */
  address: string
  /** Device password (set in the Rain Bird app). */
  password: string
  /** Per-request timeout in ms (default 20000). */
  timeoutMs?: number
  /** Optional logger for debugging the wire protocol. */
  onLog?: (level: 'debug' | 'warn' | 'error', message: string) => void
}

export interface ModelAndVersion {
  modelNumber: number
  modelName: string
  version: string
}

export interface ControllerState {
  controllerDateTime: Date
  delayDays: number
  rainSetPointReached: boolean
  irrigationState: boolean
  seasonalAdjust: number
  currentZoneTimeRemaining: number
  currentZone: number
}

/** Raised when the controller replies with a NAK (command not acknowledged). */
export class RainBirdNakError extends Error {
  constructor(public readonly commandType: number, public readonly code: number) {
    super(`Rain Bird did not acknowledge command 0x${commandType.toString(16)} (code 0x${code.toString(16)})`)
    this.name = 'RainBirdNakError'
  }
}

const MODELS: Record<number, string> = {
  0x0003: 'ESP-RZXe', 0x0005: 'ESP-TM2', 0x0006: 'ST8x-WiFi', 0x0007: 'ESP-Me',
  0x0008: 'ST8x-WiFi2', 0x0009: 'ESP-ME3', 0x000a: 'ESP-TM2', 0x000c: 'LXME2',
  0x000d: 'LX-IVM', 0x000e: 'LX-IVM Pro', 0x0010: 'ESP-Me2', 0x0011: 'ESP-2WIRE',
  0x0014: 'TM2R', 0x0015: 'TRU', 0x0099: 'TBOS-BT', 0x0100: 'TBOS-BT',
  0x0103: 'ESP-RZXe2', 0x0107: 'ESP-Me', 0x010a: 'ESP-TM2', 0x0812: 'RC2', 0x0813: 'ARC8',
}

export class RainBird {
  private readonly address: string
  private readonly password: string
  private readonly timeoutMs: number
  private readonly onLog?: RainBirdOptions['onLog']

  /** Discovered transport: null until the first successful request. */
  private proto: 'https' | 'http' | null = null
  /** Serialize requests — the controller handles one at a time. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(opts: RainBirdOptions) {
    if (!opts?.address) throw new Error('RainBird: address is required')
    if (!opts?.password) throw new Error('RainBird: password is required')
    this.address = opts.address
    this.password = opts.password
    this.timeoutMs = opts.timeoutMs ?? 20000
    this.onLog = opts.onLog
  }

  // ---- public API ---------------------------------------------------------

  /** Controller model + firmware version (also a good connectivity check). */
  async getModelAndVersion(): Promise<ModelAndVersion> {
    const d = await this.command(Buffer.from([0x02]), 0x82)
    const modelNumber = d.readUInt16BE(1)
    return { modelNumber, modelName: MODELS[modelNumber] ?? String(modelNumber), version: `${d[3]}.${d[4]}` }
  }

  /** The controller's serial number (hex string). */
  async getSerialNumber(): Promise<string> {
    const d = await this.command(Buffer.from([0x05]), 0x85)
    return d.subarray(1, 8).toString('hex')
  }

  /** List of available (configured) zone numbers, e.g. [1,2,3,4]. */
  async getAvailableZones(): Promise<number[]> {
    const d = await this.command(Buffer.from([0x03, 0x00]), 0x83)
    const zones: number[] = []
    let bits = d.readUInt32LE(2)
    for (let i = 0; i < 32; i++) {
      if (bits & 1) zones.push(i + 1)
      bits >>>= 1
    }
    return zones
  }

  /** The currently running zone number, or 0 if none is active. */
  async getCurrentZone(): Promise<number> {
    const d = await this.command(Buffer.from([0x3f, 0x00]), 0xbf)
    const raw = d.readUInt32LE(2)
    return raw === 0 ? 0 : Math.log2(raw) + 1
  }

  /**
   * True when a zone is ACTIVELY watering. Derived from the current zone, because
   * on some models (e.g. ESP-TM2) the raw 0xC8 irrigation flag means "system
   * enabled" and stays true even when idle — see `getIrrigationFlag()`.
   */
  async isIrrigating(): Promise<boolean> {
    return (await this.getCurrentZone()) !== 0
  }

  /**
   * Raw controller "irrigation state" flag (SIP 0xC8). NOTE: on some models this
   * reflects "system enabled" rather than "actively watering" — prefer
   * `isIrrigating()` / `getCurrentZone()` for whether a zone is really running.
   */
  async getIrrigationFlag(): Promise<boolean> {
    const d = await this.command(Buffer.from([0x48]), 0xc8)
    return d[1] !== 0
  }

  /** True when the rain sensor's set point has been reached (i.e. it's "raining"). */
  async getRainSensorState(): Promise<boolean> {
    const d = await this.command(Buffer.from([0x3e]), 0xbe)
    return d[1] !== 0
  }

  /** Rich controller status: date/time, active zone + time remaining, rain delay, etc. */
  async getControllerState(): Promise<ControllerState> {
    const d = await this.command(Buffer.from([0x4c]), 0xcc)
    const monthYear = d.subarray(5, 7).toString('hex')
    const month = Number(`0x0${monthYear.substring(0, 1)}`) - 1
    const year = Number(`0x0${monthYear.substring(1, 4)}`)
    return {
      controllerDateTime: new Date(year, month, d[4], d[1], d[2], d[3]),
      delayDays: d.readUInt16BE(7),
      rainSetPointReached: d[9] !== 0,
      irrigationState: d[10] !== 0,
      seasonalAdjust: d.readUInt16BE(11),
      currentZoneTimeRemaining: d.readUInt16BE(13),
      currentZone: d[15],
    }
  }

  /**
   * Start watering a zone for `durationSeconds`. The controller works in whole
   * minutes, so the duration is rounded to the nearest minute (min 1).
   */
  async startZone(zone: number, durationSeconds: number): Promise<void> {
    const minutes = Math.max(1, Math.round(durationSeconds / 60))
    const buf = Buffer.concat([Buffer.from([0x39]), u16be(zone), Buffer.from([minutes])])
    await this.commandAck(buf)
  }

  /** Run a stored program (0-indexed). */
  async runProgram(program: number): Promise<void> {
    await this.commandAck(Buffer.from([0x38, program]))
  }

  /** Advance to the next zone in the running sequence. */
  async advanceZone(): Promise<void> {
    await this.commandAck(Buffer.from([0x42, 0x00]))
  }

  /** Stop all irrigation immediately. */
  async stopIrrigation(): Promise<void> {
    await this.commandAck(Buffer.from([0x40]))
  }

  /**
   * Send a raw SIP command and get the decrypted response bytes back. Escape
   * hatch for commands this client doesn't model. `bytes` is the command body
   * (first byte = command code).
   */
  async raw(bytes: Buffer | number[]): Promise<Buffer> {
    return this.send(Buffer.from(bytes as number[]))
  }

  // ---- command helpers ----------------------------------------------------

  /** Send a command and assert the reply is the expected response code. */
  private async command(body: Buffer, expectCode: number): Promise<Buffer> {
    const d = await this.send(body)
    if (d[0] !== expectCode) {
      if (d[0] === 0x00) throw new RainBirdNakError(d[1], d[2])
      throw new Error(`Unexpected Rain Bird response 0x${d[0].toString(16)} (wanted 0x${expectCode.toString(16)})`)
    }
    return d
  }

  /** Send a command expecting an ACK (0x01); throw RainBirdNakError on NAK (0x00). */
  private async commandAck(body: Buffer): Promise<void> {
    const d = await this.send(body)
    if (d[0] === 0x00) throw new RainBirdNakError(d[1], d[2])
    if (d[0] !== 0x01) throw new Error(`Unexpected Rain Bird response 0x${d[0].toString(16)} (wanted ACK)`)
  }

  /** Queue a request (concurrency 1) and return the decrypted SIP data bytes. */
  private send(body: Buffer): Promise<Buffer> {
    const run = () => this.exchange(body)
    const next = this.chain.then(run, run)
    // Keep the chain alive regardless of individual failures.
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }

  // ---- wire protocol ------------------------------------------------------

  private async exchange(body: Buffer): Promise<Buffer> {
    const formatted = JSON.stringify({
      id: 9,
      jsonrpc: '2.0',
      method: 'tunnelSip',
      params: { data: body.toString('hex'), length: body.length },
    })
    const payload = this.encrypt(formatted)
    const respBuf = await this.post(payload)
    const json = JSON.parse(this.decrypt(respBuf).replace(/[\n ]/g, ''))
    if (json?.error) throw new Error(`Rain Bird error ${json.error.code}: ${json.error.message}`)
    if (!json?.result?.data) throw new Error('Rain Bird: malformed response (no result data)')
    return Buffer.from(json.result.data, 'hex')
  }

  private encrypt(formatted: string): Buffer {
    const key = crypto.createHash('sha256').update(Buffer.from(this.password, 'utf8')).digest()
    const iv = crypto.randomBytes(16)
    const packed = Buffer.from(addPadding(`${formatted} `), 'binary')
    const sig = crypto.createHash('sha256').update(Buffer.from(formatted, 'utf8')).digest()
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
    cipher.setAutoPadding(false)
    const enc = Buffer.concat([cipher.update(packed), cipher.final()])
    return Buffer.concat([sig, iv, enc])
  }

  private decrypt(data: Buffer): string {
    const key = crypto.createHash('sha256').update(Buffer.from(this.password, 'utf8')).digest().subarray(0, 32)
    const iv = data.subarray(32, 48)
    const body = data.subarray(48)
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
    decipher.setAutoPadding(false)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  }

  /** POST the encrypted payload to /stick, discovering https-vs-http on first use. */
  private async post(payload: Buffer): Promise<Buffer> {
    if (this.proto === null) {
      try {
        const r = await this.httpPost('https', payload)
        this.proto = 'https'
        this.log('debug', `[${this.address}] using HTTPS`)
        return r
      } catch (e) {
        if (!isConnError(e)) throw e
        this.proto = 'http'
        this.log('debug', `[${this.address}] HTTPS unavailable, using HTTP`)
      }
    }
    return this.httpPost(this.proto ?? 'http', payload)
  }

  private httpPost(proto: 'https' | 'http', payload: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const mod = proto === 'https' ? https : http
      // address may include a port ("host:port"); split it out so http.request
      // doesn't try to DNS-resolve the whole string as a hostname.
      const u = new URL(`${proto}://${this.address}`)
      const req = mod.request(
        {
          hostname: u.hostname,
          port: u.port || (proto === 'https' ? 443 : 80),
          path: '/stick',
          method: 'POST',
          ...(proto === 'https' ? { rejectUnauthorized: false } : {}),
          headers: {
            'Accept-Language': 'en',
            'Accept-Encoding': 'identity',
            'User-Agent': 'RainBird/2.0 CFNetwork/811.5.4 Darwin/16.7.0',
            Accept: '*/*',
            Connection: 'keep-alive',
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(payload.length),
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c as Buffer))
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`Rain Bird HTTP ${res.statusCode}`))
              return
            }
            resolve(Buffer.concat(chunks))
          })
        },
      )
      req.on('error', reject)
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error('Rain Bird request timed out')))
      req.end(payload)
    })
  }

  private log(level: 'debug' | 'warn' | 'error', message: string): void {
    this.onLog?.(level, message)
  }
}

// ---- helpers --------------------------------------------------------------

function u16be(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n & 0xffff)
  return b
}

/** Pad a string up to a 16-byte block boundary with 0x10 bytes (Rain Bird scheme). */
function addPadding(data: string): string {
  const BLOCK = 16
  const charsToAdd = BLOCK - (data.length % BLOCK)
  return data + ''.repeat(charsToAdd)
}

const CONN_ERR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EPROTO',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_NO_PROTOCOLS_AVAILABLE',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', 'ETIMEDOUT',
])
const CONN_ERR_SUBSTR = ['ssl', 'tls', 'socket hang up', 'wrong version']

function isConnError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const code = (e as Error & { code?: string }).code
  if (code && CONN_ERR_CODES.has(code)) return true
  const msg = e.message.toLowerCase()
  return CONN_ERR_SUBSTR.some((s) => msg.includes(s))
}

export default RainBird
