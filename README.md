# Crow

**The alarm clock you can't snooze, unplug, or uninstall your way out of.**

Crow is two things: a battery-backed ESP32 alarm clock with a crow's face, and a phone app that holds the
only key to it. When the alarm goes off, the clock makes up a fresh random challenge. The app answers it
(an HMAC proof) only after you solve a couple of quick puzzles. Delete the app and the key goes with it,
but the alarms live on the clock, so it keeps ringing.

## What's here

| Folder | What |
|--------|------|
| `firmware/crow/` | ESP32 firmware (Arduino): alarms, escalation, BLE, HMAC proofs, wake check, SOS count-off, mercy limit, OLED face |
| `web/index.html` | Simulator + product page: a virtual clock next to a virtual phone running the real app, plus a 3D model of the enclosure |
| `web/app.html` | The real companion app (installable web app, Web Bluetooth) |
| `web/js/` | App, puzzles, protocol, simulated clock (a port of the firmware), Bluetooth link, 3D viewer |
| `cad/` | Enclosure: `build.mjs` (code-CAD, writes STL + fit check), `crow.scad` (OpenSCAD version), `stl/` (print-ready) |
| `docs/` | [PRODUCT.md](docs/PRODUCT.md) rules and flows, [PROTOCOL.md](docs/PROTOCOL.md) Bluetooth spec, [HARDWARE.md](docs/HARDWARE.md) parts, wiring, printing, assembly, flashing, [PITCH.md](docs/PITCH.md) |
| `tools/` | Tests, a local server, the icon generator |

## Try it

Needs [Node.js](https://nodejs.org) 18 or newer, nothing else.

```bash
npm run serve
```

Open http://localhost:5180 for the simulator. Press **Start the morning**, let it ring, solve your way
out. Then pick **App deleted** and see what the clock thinks of that.

## Check it

```bash
npm test
```

179 checks: HMAC proofs against Node's reference HMAC, firmware and app rules in sync, the wire format,
whole simulated mornings (pairing, escalation, wrong proofs, wake check, deleted app, re-pair betrayal,
orphan penalty, mercy limit, SOS count-off, unplugging, factory reset), and that every STL is watertight
and sits on the bed. The same tests run on every push.

```bash
npm run cad
```

Rebuilds the enclosure STLs and re-runs the fit check (every component inside the shell, nothing colliding).

## Build a real one

Everything is in [docs/HARDWARE.md](docs/HARDWARE.md): about $29 of parts, about 118 g of PETG, wiring,
assembly, flashing and a bench test. The firmware builds with the esp32 core 3.3.12 for a LOLIN D32 or
a generic ESP32 Dev Module.

## Put the app on a phone

Web Bluetooth needs HTTPS, so host the `web/` folder:

1. In this repo: **Settings → Pages → Source: GitHub Actions**.
2. **Actions → Deploy web app → Run workflow.**
3. On Android, open `https://<user>.github.io/<repo>/app.html` in Chrome and choose **Add to Home screen**.
   On iPhone, use the Bluefy browser (Safari has no Web Bluetooth).

On a computer with Bluetooth, Chrome or Edge can pair straight from `http://localhost:5180/app.html`.

## Status

| Piece | State |
|-------|-------|
| Simulator + app logic | Working, covered by `npm test` and tried in the browser |
| Firmware | Compiles cleanly (esp32 core 3.3.12, LOLIN D32 and ESP32 Dev Module, SSD1306 and SH1106 builds). Not yet flashed to a board. |
| Enclosure STLs | Closed meshes, fit-checked. Not yet test-printed. |
| Web Bluetooth link | Written to the protocol spec. Not yet run against a physical clock. |
