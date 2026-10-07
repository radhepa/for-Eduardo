# Building a Crow

About $29 of parts, roughly 6 hours of printing and an evening of soldering. Everything here matches
`firmware/crow/config.h` (pins) and `cad/build.mjs` (enclosure).

## Parts

| # | Part | Notes | ≈ USD |
|---|------|-------|------:|
| 1 | ESP32 board with a LiPo charger and JST-PH socket | LOLIN D32 (what the enclosure is sized for, 57 × 25.4 mm). Adafruit ESP32 Feather V2 or FireBeetle ESP32-E also work; check the pin notes below. | 8 |
| 1 | 0.96″ SSD1306 OLED, 128×64, I²C, 4-pin | For a 1.3″ SH1106 module set `OLED_SH1106 1` and widen the window (`WIN_W`, `OLED_PCB`). | 4 |
| 1 | DS3231 RTC module (ZS-042) + CR2032 | Keeps time through power cuts. See the ZS-042 warning below. | 3 |
| 1 | 12 mm passive magnetic buzzer (3–5 V) | Passive, not "active": the firmware plays tones. | 0.5 |
| 1 | NPN transistor (S8050 or 2N2222) + 1 kΩ + 1N4148 diode | Drives the buzzer louder than a GPIO can. | 0.3 |
| 1 | 2000 mAh 3.7 V LiPo, 103450 size (10 × 34 × 50 mm), JST-PH | Lets it ring after you pull the plug. | 7 |
| 1 | 16 mm panel-mount momentary push button | The perch. Normally open. | 2 |
| 1 | 6 × 6 mm tact switch, 5 mm tall | The SOS pin switch. | 0.1 |
| 1 | 5 mm red LED + 220 Ω | The rage light. | 0.1 |
| 2 | 100 kΩ, 150 kΩ resistors | USB-power sensing. | 0.1 |
| 4 | M3 × 8 countersunk self-tapping screws | Floor plate. | 0.5 |
| 2 | 3 mm stick-on rubber bumpers | Under the back, level with the printed feet. | 0.3 |
| — | PETG filament, about 120 g | Shell + floor in black or charcoal, feet in orange. | 3 |
| — | Hookup wire, a scrap of perfboard, hot glue | | |

## Printing

Print-ready files are in `cad/stl/` (already oriented). Rebuild them with `npm run cad`.

| File | Qty | How |
|------|----:|-----|
| `crow-shell.stl` | 1 | Top on the bed, as exported. 0.2 mm layers, 3 walls, 20 % infill. The screw posts have built-in 45° cones, so no supports. The window and USB openings bridge fine. |
| `crow-floor.stl` | 1 | Flat, ribs up. |
| `crow-foot.stl` | 2 | Flat. Orange looks best. |
| `crow-tuft.stl` | 1 | Flat. |

All four meshes are closed and manifold (`npm test` checks this). Total is about 118 g of PETG at 100 %
solid; your slicer will estimate less.

Want to change something? `cad/crow.scad` is the same model in OpenSCAD with the same parameter names.
Edit, render (F6), export. Or edit `P` at the top of `cad/build.mjs` and run `npm run cad`, which also
re-runs the fit check that every component fits and nothing collides.

## Wiring

```
                 ESP32 (LOLIN D32)
   OLED VCC ──── 3V3          GPIO21 ──── SDA  (OLED + DS3231)
   OLED GND ──── GND          GPIO22 ──── SCL  (OLED + DS3231)
   RTC  VCC ──── 3V3
   RTC  GND ──── GND
   BAT ──────── Buzzer +
                Buzzer − ──── NPN collector     (1N4148 across the buzzer, stripe to +)
                              GPIO25 ──[1k]── NPN base        NPN emitter ── GND
                              GPIO27 ──── perch button ──── GND
                              GPIO26 ──── SOS tact switch ── GND
                              GPIO33 ──[220R]──|>|── GND     (red LED)
   USB 5V ──[100k]──┬── GPIO34
                    └─[150k]── GND
                              GPIO35 ──── battery sense (built in on LOLIN D32 / Feather V2)
   LiPo ──── JST-PH socket (check polarity before plugging in!)
```

| Wire | ESP32 pin | Why that pin |
|------|-----------|--------------|
| I²C SDA / SCL | 21 / 22 | Default I²C pins. OLED (0x3C) and DS3231 (0x68) share the bus. |
| Buzzer (via NPN) | 25 | Any output with LEDC works. |
| Perch button | 27 | Internal pull-up, button to GND. |
| SOS switch | 26 | Internal pull-up, switch to GND. |
| LED | 33 | |
| USB sense | 34 | Input-only pin. 5 V × 150/(100+150) = 3.0 V when plugged in. |
| Battery sense | 35 | Input-only pin, through the board's 1:2 divider. |

- **Buzzer power.** Taking the buzzer's + from the battery pin (BAT/VBAT) keeps it loud when unplugged.
  3V3 works too, just quieter.
- **ZS-042 warning.** The common blue DS3231 board tries to charge its coin cell. With a normal CR2032,
  remove the 200 Ω resistor (or the diode) next to the cell holder, or use an LIR2032.
- **Other boards.** If your board has no battery divider on GPIO35, add 100 k + 100 k from BAT to GND
  with the middle to GPIO35. If you skip USB sensing, set `PIN_USB_SENSE -1`; the clock then assumes it is
  always plugged in (and the "NICE TRY" rule never fires).

## Assembly

1. Push the 16 mm perch button up through the top hole and tighten its nut.
2. Glue the tuft's tab into the slot on top.
3. From inside, press the OLED into its pocket, glass toward the window, header pins at the top. A few
   dots of hot glue on the pocket edges hold it.
4. LED into the small hole under the window (glue). Buzzer into the round cup behind the grill, sound
   hole facing out (it's a press fit; a dot of glue if loose).
5. Tact switch into the box on the right wall, button toward the pinhole. Glue around it, not on it.
   Check a paperclip through the pinhole clicks it.
6. DS3231: stand it on the ledge on the left wall, coin cell toward the wall, foam tape behind it.
7. Solder the wiring above. A small perfboard for the transistor, diode and resistors keeps it tidy.
8. Flash the firmware (below) and test on the bench before closing up.
9. Slide the ESP32 into the floor cradle, USB toward the back opening. Battery into the corral with
   foam tape, lead through the notch.
10. Fit the floor into the shell and drive the four screws. Stick the crow feet under the front so the
    toes peek out, and the two rubber bumpers under the back.

## Flashing the firmware

Tested with the **esp32 by Espressif** core 3.3.12, Adafruit SSD1306 2.5.17, Adafruit GFX 1.12.6,
Adafruit SH110X 2.1.14 and RTClib 2.1.4. It builds without errors or warnings and uses about 1.18 MB of
flash (90 % of the default app partition) and 44 KB of RAM.

**Arduino IDE 2**

1. **Boards Manager:** install "esp32 by Espressif Systems".
2. **Library Manager:** "Adafruit SSD1306" (pulls in Adafruit GFX and BusIO) and "RTClib" by Adafruit.
   For an SH1106 screen also "Adafruit SH110X".
3. Open `firmware/crow/crow.ino`. Board: *LOLIN D32* (or *ESP32 Dev Module*). The default partition
   scheme fits; pick *No OTA (Large APP)* / *Huge APP* if you add features.
4. Upload. Serial monitor at 115200 should print `[crow] advertising as Crow-XXXX` and a boot line.

**arduino-cli**

```bash
arduino-cli config add board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32
arduino-cli lib install "Adafruit SSD1306" "Adafruit GFX Library" "RTClib" "Adafruit SH110X"
arduino-cli compile -b esp32:esp32:d32 firmware/crow
arduino-cli upload -b esp32:esp32:d32 -p COM5 firmware/crow
```

Use your board's port instead of `COM5`. Hardware options in `config.h` (pins, `OLED_SH1106`,
`CLOCK_24H`, `PIN_USB_SENSE`) can also be set from the build without editing the file:
`--build-property "compiler.cpp.extra_flags=-DOLED_SH1106=1"`.

The clock's logic is mirrored line for line by `web/js/sim-clock.js`, which `npm test` runs through whole
mornings, and its proofs are checked against a reference HMAC.

## Bench test

- [ ] Screen shows a wide-eyed crow and "HOLD PERCH 3s TO PAIR".
- [ ] Hold the perch 3 s: a progress bar fills, then "PAIRING 90s".
- [ ] Pair from the app. The crow closes its eyes and shows the time.
- [ ] Set an alarm 2 minutes ahead. It rings at level 1 and gets louder at 30, 90 and 180 s.
- [ ] Press the perch while ringing: "NO SNOOZE".
- [ ] Unplug USB while ringing: "NICE TRY", full volume.
- [ ] Solve the puzzles: it goes quiet, "WATCHING YOU". 5 minutes later it chirps; tap the crow in the app.
- [ ] Hold a paperclip in the SOS pin for 8 s while it rings: count-off starts. Count right 5 times: "ESCAPED".
- [ ] Delete the app's data (or the app), let it ring, reinstall, re-pair: penalty round, betrayal +1.
