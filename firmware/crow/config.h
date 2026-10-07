// Crow firmware configuration.
// Pins match docs/HARDWARE.md. Rules mirror web/js/rules.js (tools/test.mjs checks they match).
#pragma once
#include <stdint.h>

#define FW_VERSION "1.0.0"

// ---------------- Hardware ----------------
// Each can also be set from the build, e.g. -DOLED_SH1106=1
#ifndef PIN_SDA
#define PIN_SDA          21
#endif
#ifndef PIN_SCL
#define PIN_SCL          22
#endif
#ifndef PIN_BUZZER
#define PIN_BUZZER       25   // passive buzzer via NPN transistor
#endif
#ifndef PIN_PERCH
#define PIN_PERCH        27   // big top button to GND (internal pull-up)
#endif
#ifndef PIN_PINHOLE
#define PIN_PINHOLE      26   // recessed SOS button to GND (internal pull-up)
#endif
#ifndef PIN_LED
#define PIN_LED          33   // "rage" LED through 220 ohm
#endif
#ifndef PIN_BATTERY
#define PIN_BATTERY      35   // LiPo sense through the board's 1:2 divider. -1 = not available
#endif
#ifndef BATTERY_DIVIDER
#define BATTERY_DIVIDER  2.0f
#endif
#ifndef PIN_USB_SENSE
#define PIN_USB_SENSE    34   // VUSB -> 100k -> pin -> 150k -> GND. -1 = not wired
#endif
#ifndef USB_SENSE_MV
#define USB_SENSE_MV     2000 // above this the clock thinks it is plugged in
#endif

#ifndef OLED_SH1106
#define OLED_SH1106      0    // 0 = SSD1306 (0.96"), 1 = SH1106 (most 1.3" modules)
#endif
#ifndef OLED_ADDR
#define OLED_ADDR        0x3C
#endif
#ifndef CLOCK_24H
#define CLOCK_24H        0    // 1 = show 24-hour time on the clock
#endif

// ---------------- Rules ----------------
#define ESCALATE_L1_S        30
#define ESCALATE_L2_S        90
#define ESCALATE_L3_S        180
#define GRACE_S              300
#define CHECK_S              120
#define PAIR_WINDOW_S        90
#define PERCH_PAIR_HOLD_MS   3000
#define PINHOLE_HOLD_MS      8000
#define PINHOLE_RESET_MS     20000
#define ORPHAN_S             (24UL * 3600UL)
#define SOS_ROUNDS           5
#define SOS_MIN_BEEPS        3
#define SOS_MAX_BEEPS        6
#define SOS_LEAD_MS          1200
#define SOS_BEEP_GAP_MS      650
#define SOS_INPUT_TIMEOUT_MS 15000
#define SOS_SETTLE_MS        2500
#define MISS_BUMP_COOLDOWN_S 3
#define MERCY_MIN_MIN        5
#define MERCY_MAX_MIN        120
#define DEFAULT_MERCY_MIN    45
#define MAX_ALARMS           4
#define HEARTBEAT_S          60
