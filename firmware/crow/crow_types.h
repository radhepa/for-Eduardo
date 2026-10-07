// Types used by crow.ino. They live in a header because the Arduino build generates function
// prototypes near the top of the sketch, before any type declared further down would exist.
#pragma once
#include <stdint.h>

enum State : uint8_t { ST_NEW, ST_IDLE, ST_RING, ST_GRACE, ST_CHECK, ST_SOS };

struct Alarm { uint8_t h, m, mask, on; };   // mask bit 0 = Sunday .. bit 6 = Saturday

struct Note { uint16_t f, ms; };            // f = 0 is a rest

struct Button { uint8_t pin; bool stable, lastRaw, longDone, xlongDone; uint32_t changedAt, downAt; };

enum SosPhase : uint8_t { SOS_BEEPING, SOS_INPUT };

enum Mood : uint8_t { M_SLEEP, M_OPEN, M_ANGRY, M_SAD, M_SQUINT, M_WIDE };
