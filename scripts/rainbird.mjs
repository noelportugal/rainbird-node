#!/usr/bin/env node
// Tiny CLI for poking a real Rain Bird controller using the built library.
//   RAINBIRD_ADDRESS=192.168.1.50 RAINBIRD_PASSWORD=xxxx node scripts/rainbird.mjs <cmd> [args]
//
// Commands:
//   info                 model, version, serial
//   zones                list available zones
//   status               full controller state (active zone, rain delay, etc.)
//   current              currently running zone (0 = none)
//   rain                 rain-sensor set point reached?
//   running              is irrigation active?
//   start <zone> <min>   water a zone for <min> minutes
//   stop                 stop all irrigation
//   raw <hex>            send a raw SIP command (hex, e.g. 02)
import { RainBird } from '../dist/index.js'

const address = process.env.RAINBIRD_ADDRESS
const password = process.env.RAINBIRD_PASSWORD
if (!address || !password) {
  console.error('Set RAINBIRD_ADDRESS and RAINBIRD_PASSWORD in the environment.')
  process.exit(2)
}

const [, , cmd, ...args] = process.argv
const rb = new RainBird({
  address,
  password,
  onLog: (lvl, msg) => { if (process.env.RAINBIRD_DEBUG) console.error(`[${lvl}] ${msg}`) },
})

try {
  switch (cmd) {
    case 'info': {
      const [mv, serial] = await Promise.all([rb.getModelAndVersion(), rb.getSerialNumber().catch(() => '(n/a)')])
      console.log(JSON.stringify({ ...mv, serial }, null, 2))
      break
    }
    case 'zones': console.log(JSON.stringify(await rb.getAvailableZones())); break
    case 'status': console.log(JSON.stringify(await rb.getControllerState(), null, 2)); break
    case 'current': console.log(`current zone: ${await rb.getCurrentZone()}`); break
    case 'rain': console.log(`rain set point reached: ${await rb.getRainSensorState()}`); break
    case 'running': console.log(`irrigating: ${await rb.isIrrigating()}`); break
    case 'start': {
      const zone = Number(args[0]); const min = Number(args[1])
      if (!zone || !min) { console.error('usage: start <zone> <minutes>'); process.exit(2) }
      await rb.startZone(zone, min * 60)
      console.log(`started zone ${zone} for ${min} min`)
      break
    }
    case 'stop': await rb.stopIrrigation(); console.log('stopped all irrigation'); break
    case 'delay': {
      if (args[0] === undefined) { console.log(`rain delay (days): ${await rb.getRainDelay()}`); break }
      const days = Number(args[0])
      await rb.setRainDelay(days)
      console.log(days > 0 ? `rain delay set to ${days} day(s) — watering skipped` : 'rain delay cleared')
      break
    }
    case 'raw': console.log(Buffer.from(await rb.raw(Buffer.from(args[0], 'hex'))).toString('hex')); break
    default:
      console.error('unknown command. see header of this file for usage.')
      process.exit(2)
  }
  process.exit(0)
} catch (e) {
  console.error('ERROR:', e?.message || e)
  process.exit(1)
}
