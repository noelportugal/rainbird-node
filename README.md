# rainbird-node

Control a **Rain Bird** irrigation controller over its **LNK / LNK2 WiFi module**
on your local network — a small, modern, **Promise-first TypeScript** client with
**zero runtime dependencies**.

It talks the device's local "SIP" protocol directly (AES-256 over HTTP/HTTPS to
the module on your LAN) — **no cloud, no account, no polling a Rain Bird server.**

- 📦 **Zero runtime dependencies** — just `node:crypto` + `node:http(s)`.
- 🔒 **Local & private** — speaks straight to the module's IP. Nothing leaves your network.
- ⛓️ **Promise-first** — `await rb.startZone(3, 600)`. Requests are serialized for you.
- 🟦 **TypeScript**, shipped dual **ESM + CJS** with types.
- 🔁 **Auto transport** — probes HTTPS (LNK2 self-signed cert) and falls back to HTTP.

## Install

```sh
npm install rainbird-node
```

## Quick start

```ts
import { RainBird } from 'rainbird-node'

const rb = new RainBird({ address: '192.168.1.50', password: 'your-device-password' })

console.log(await rb.getModelAndVersion()) // { modelNumber, modelName: 'ESP-ME3', version: '3.8' }
console.log(await rb.getAvailableZones())   // [1, 2, 3, 4]

await rb.startZone(3, 600)                   // water zone 3 for 600 seconds (10 min)
console.log(await rb.getCurrentZone())       // 3
await rb.stopIrrigation()                    // stop everything
```

> **Address & password:** the `address` is the LNK module's LAN IP (find it in
> your router or the Rain Bird app). The `password` is the device password set in
> the Rain Bird app — it keys the AES encryption; there's no separate API key.

## API

| Method | Returns | Notes |
|---|---|---|
| `getModelAndVersion()` | `{ modelNumber, modelName, version }` | Good connectivity check |
| `getSerialNumber()` | `string` | Hex serial |
| `getAvailableZones()` | `number[]` | Configured zone numbers |
| `getCurrentZone()` | `number` | Running zone, `0` if none |
| `isIrrigating()` | `boolean` | Any zone active |
| `getRainSensorState()` | `boolean` | Rain set point reached |
| `getControllerState()` | `ControllerState` | Date/time, active zone + time left, rain delay, seasonal adjust |
| `startZone(zone, seconds)` | `void` | Rounded to whole minutes (controller granularity) |
| `runProgram(program)` | `void` | Run a stored program (0-indexed) |
| `advanceZone()` | `void` | Next zone in sequence |
| `stopIrrigation()` | `void` | Stop everything |
| `raw(bytes)` | `Buffer` | Escape hatch for unmodeled SIP commands |

Commands that aren't acknowledged throw `RainBirdNakError` (with `commandType` and `code`).

## CLI (for testing)

```sh
npm run build
RAINBIRD_ADDRESS=192.168.1.50 RAINBIRD_PASSWORD=xxxx node scripts/rainbird.mjs info
RAINBIRD_ADDRESS=… RAINBIRD_PASSWORD=… node scripts/rainbird.mjs start 3 10
```

Set `RAINBIRD_DEBUG=1` to log transport discovery.

## ⚠️ Rain Bird 2.0 / IQ4 cloud

The local API is **only** available while the controller stays on the classic
app/firmware. Migrating to the **Rain Bird 2.0 app / IQ4 cloud** removes local
access — this library (and Home Assistant's integration) will no longer reach
the device. Don't take that "upgrade" if you want local control.

## Credits

Protocol based on the excellent reverse-engineering work in
[`homebridge-plugins/rainbird`](https://github.com/homebridge-plugins/rainbird)
and [`pyrainbird`](https://github.com/allenporter/pyrainbird), reimplemented here
with zero runtime dependencies.

## License

MIT © Noel Portugal
