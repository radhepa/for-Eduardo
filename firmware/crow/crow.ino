/*
  CROW: the unsnoozable alarm clock. Firmware 1.0.0 for ESP32.

  The clock is the boss. The phone is the key.
    - Alarms live on the clock. It rings on its own; the phone is never needed to START ringing.
    - It only goes quiet when the paired Crow app proves it holds the key (HMAC over a fresh
      challenge), which the app only does after you solve its puzzles.
    - Delete the app and the key goes with it. The crow keeps screaming until you reinstall,
      re-pair (penalty: +2 puzzles, betrayal logged) or win the SOS count-off.
    - Battery backed. Pulling the plug while it rings sends it straight to full volume.

  Build: Arduino IDE 2 or arduino-cli + "esp32 by Espressif" core (tested with 3.3.12).
  Libraries (Library Manager): Adafruit GFX, Adafruit SSD1306 (or Adafruit SH110X), RTClib.
  Fits the default partition scheme (about 1.18 MB, 90%). For headroom pick a no-OTA scheme.
  Wiring + parts: docs/HARDWARE.md. Protocol: docs/PROTOCOL.md.
*/
#include <Arduino.h>
#include <Wire.h>
#include <Preferences.h>
#include <RTClib.h>
#include <Adafruit_GFX.h>
#include "config.h"
#include "crow_types.h"

#if OLED_SH1106
  #include <Adafruit_SH110X.h>
  Adafruit_SH1106G display(128, 64, &Wire, -1);
  #define OLED_ON  SH110X_WHITE
  #define OLED_OFF SH110X_BLACK
#else
  #include <Adafruit_SSD1306.h>
  Adafruit_SSD1306 display(128, 64, &Wire, -1);
  #define OLED_ON  SSD1306_WHITE
  #define OLED_OFF SSD1306_BLACK
#endif

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "mbedtls/md.h"
#if __has_include("esp_random.h")
  #include "esp_random.h"
#else
  #include "esp_system.h"
#endif

// ------------------------------------------------------------------ BLE ids
#define UUID_SERVICE "c20a0000-0b5e-4d1e-9a1a-0000c20ac20a"
#define UUID_STATE   "c20a0001-0b5e-4d1e-9a1a-0000c20ac20a"
#define UUID_CMD     "c20a0002-0b5e-4d1e-9a1a-0000c20ac20a"
#define UUID_KEY     "c20a0003-0b5e-4d1e-9a1a-0000c20ac20a"
#define UUID_ALARMS  "c20a0004-0b5e-4d1e-9a1a-0000c20ac20a"

// ------------------------------------------------------------------ state
static const char* STATE_NAMES[] = {"NEW", "IDLE", "RING", "GRACE", "CHECK", "SOS"};


Preferences prefs;
RTC_DS3231 rtc;
bool rtcOk = false, oledOk = false;

// persisted
uint8_t  key[16];
bool     hasKey = false;
Alarm    alarms[MAX_ALARMS];
bool     wakeCheck = true;
uint8_t  mercyMin = DEFAULT_MERCY_MIN;
int16_t  tzMin = 0;
uint32_t lastSeen = 0;
uint16_t betrayals = 0, shame = 0, sosEscapes = 0;

// runtime
State    st = ST_NEW;
uint8_t  level = 0, levelFloor = 0;
bool     penalty = false;
char     challenge[17] = "";
char     nonce[17] = "";
uint32_t ringStart = 0, ringAccumS = 0, lastAccum = 0, stateUntil = 0, lastFiredMinute = 0;
uint32_t lastBump = 0, lastSeenSaved = 0;
uint8_t  pendingKey[16];
char     pendingHex[33] = "";
bool     pairOpen = false;
uint32_t pairUntil = 0;
bool     connected = false, authed = false;
bool     usbPower = true;
uint8_t  batteryPct = 100;
bool     showShame = false;
char     flashMsg[22] = "";
uint32_t flashUntilMs = 0, awakeUntilMs = 0;
char     deviceName[16] = "Crow";

// SOS count-off
SosPhase sosPhase = SOS_BEEPING;
uint8_t  sosRound = 0, sosTarget = 0, sosBeepsLeft = 0, sosPresses = 0;
uint32_t sosNextMs = 0, sosLastPressMs = 0, sosDeadlineMs = 0, ledFlashUntilMs = 0;

// time: a soft clock re-based from the DS3231 every minute
uint32_t softBaseUnix = 0, softBaseMs = 0;
bool     timeValid = false;

bool dirty = true;   // state changed, publish soon

// ------------------------------------------------------------------ helpers
static void toHex(const uint8_t* b, size_t n, char* out) {
  static const char* H = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) { out[2 * i] = H[b[i] >> 4]; out[2 * i + 1] = H[b[i] & 15]; }
  out[2 * n] = 0;
}

static void randomHexStr(char* out, size_t nBytes) {
  uint8_t b[16];
  esp_fill_random(b, nBytes);
  toHex(b, nBytes, out);
}

// first 8 bytes of HMAC-SHA256(key, msg) as 16 hex chars
static void hmac16(const uint8_t* k, const char* msg, char* out17) {
  uint8_t mac[32];
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), k, 16,
                  (const unsigned char*)msg, strlen(msg), mac);
  toHex(mac, 8, out17);
}

static bool proofOk(const uint8_t* k, const char* prefix, const char* data, const char* given) {
  if (!data[0] || strlen(given) != 16) return false;
  char msg[48];
  snprintf(msg, sizeof msg, "%s%s", prefix, data);
  char expect[17];
  hmac16(k, msg, expect);
  uint8_t diff = 0;
  for (int i = 0; i < 16; i++) diff |= (uint8_t)(tolower((unsigned char)given[i]) ^ expect[i]);
  return diff == 0;
}

static uint32_t nowUnix() { return softBaseUnix + (millis() - softBaseMs) / 1000; }

static void rebaseSoftClock() {
  uint32_t ms = millis(), el = ms - softBaseMs;
  softBaseUnix += el / 1000;
  softBaseMs = ms - (el % 1000);
}

static void setTimeUnix(uint32_t u) {
  softBaseUnix = u;
  softBaseMs = millis();
  timeValid = true;
  if (rtcOk) rtc.adjust(DateTime(u));
}

static uint32_t localUnix() { return (uint32_t)((int64_t)nowUnix() + (int32_t)tzMin * 60); }

static void flash(const char* msg, uint32_t ms) {
  strncpy(flashMsg, msg, sizeof flashMsg - 1);
  flashMsg[sizeof flashMsg - 1] = 0;
  flashUntilMs = millis() + ms;
}

static bool isOrphan() { return hasKey && lastSeen > 0 && timeValid && nowUnix() > lastSeen + ORPHAN_S; }

// ------------------------------------------------------------------ persistence
static void saveKey()    { prefs.putBytes("key", key, 16); prefs.putBool("hasKey", hasKey); }
static void saveAlarms() { prefs.putBytes("alarms", alarms, sizeof alarms); }
static void saveConfig() { prefs.putBool("wake", wakeCheck); prefs.putUChar("mercy", mercyMin); prefs.putShort("tz", tzMin); }
static void saveStats()  { prefs.putUShort("betray", betrayals); prefs.putUShort("shame", shame); prefs.putUShort("sos", sosEscapes); }
static void saveSeen()   { prefs.putUInt("seen", lastSeen); lastSeenSaved = lastSeen; }

static void loadAll() {
  hasKey = prefs.getBool("hasKey", false);
  if (hasKey && prefs.getBytes("key", key, 16) != 16) hasKey = false;
  memset(alarms, 0, sizeof alarms);
  if (prefs.getBytesLength("alarms") == sizeof alarms) prefs.getBytes("alarms", alarms, sizeof alarms);
  wakeCheck  = prefs.getBool("wake", true);
  mercyMin   = constrain(prefs.getUChar("mercy", DEFAULT_MERCY_MIN), MERCY_MIN_MIN, MERCY_MAX_MIN);
  tzMin      = prefs.getShort("tz", 0);
  lastSeen   = prefs.getUInt("seen", 0);
  betrayals  = prefs.getUShort("betray", 0);
  shame      = prefs.getUShort("shame", 0);
  sosEscapes = prefs.getUShort("sos", 0);
  lastSeenSaved = lastSeen;
}

// ------------------------------------------------------------------ sound
static const Note PAT_L0[]    = {{2200, 70}, {0, 110}, {2200, 70}, {0, 3800}};
static const Note PAT_L1[]    = {{1500, 240}, {0, 140}, {1350, 260}, {0, 1500}};
static const Note PAT_L2[]    = {{1800, 180}, {0, 60}, {1400, 200}, {0, 60}, {1800, 180}, {0, 60}, {1400, 220}, {0, 500}};
static const Note PAT_L3[]    = {{2800, 110}, {2000, 110}, {2800, 110}, {2000, 110}, {2800, 110}, {2000, 110}, {0, 90}};
static const Note PAT_CHECK[] = {{2400, 60}, {0, 80}, {2400, 60}, {0, 80}, {2400, 60}, {0, 9500}};
static const Note PAT_TEST[]  = {{1500, 240}, {0, 140}, {1350, 260}, {0, 600}, {1500, 240}, {0, 140}, {1350, 260}};
static const Note PAT_OK[]    = {{1800, 80}, {2400, 80}, {3000, 140}};
static const Note PAT_BAD[]   = {{420, 380}};
static const Note PAT_SOS[]   = {{1000, 250}};
#define PAT(p) p, (uint8_t)(sizeof(p) / sizeof(Note))

const Note* patNotes = nullptr;
uint8_t  patLen = 0, patIdx = 0;
bool     patLoop = false;
uint32_t patNoteEnd = 0;
int8_t   soundMode = -1;   // which looping pattern is playing (-1 none, 0..3 ring level, 10 check)

static void startNote() {
  const Note& n = patNotes[patIdx];
  if (n.f) tone(PIN_BUZZER, n.f); else noTone(PIN_BUZZER);
  patNoteEnd = millis() + n.ms;
}
static void playPattern(const Note* p, uint8_t len, bool loop) {
  patNotes = p; patLen = len; patLoop = loop; patIdx = 0;
  if (!loop) soundMode = -1;
  startNote();
}
static void stopSound() { patNotes = nullptr; soundMode = -1; noTone(PIN_BUZZER); }
static void updateSound() {
  if (!patNotes || (int32_t)(millis() - patNoteEnd) < 0) return;
  if (++patIdx >= patLen) {
    if (!patLoop) { stopSound(); return; }
    patIdx = 0;
  }
  startNote();
}
static void ensureRingSound() {
  if (st == ST_RING) {
    if (soundMode != level) {
      soundMode = level;
      switch (level) {
        case 0: playPattern(PAT(PAT_L0), true); break;
        case 1: playPattern(PAT(PAT_L1), true); break;
        case 2: playPattern(PAT(PAT_L2), true); break;
        default: playPattern(PAT(PAT_L3), true); break;
      }
      soundMode = level;
    }
  } else if (st == ST_CHECK) {
    if (soundMode != 10) { playPattern(PAT(PAT_CHECK), true); soundMode = 10; }
  } else if (soundMode >= 0) {
    stopSound();
  }
}

// ------------------------------------------------------------------ state machine
static void newChallenge() { randomHexStr(challenge, 8); }
static void newNonce()     { randomHexStr(nonce, 8); }

static void startRing() {
  st = ST_RING;
  level = 0; levelFloor = 0; penalty = false;
  if (isOrphan()) { penalty = true; levelFloor = 2; }
  newChallenge();
  ringStart = nowUnix(); ringAccumS = 0; lastAccum = ringStart;
  showShame = false;
  dirty = true;
  Serial.printf("[crow] RING (penalty=%d)\n", penalty);
}

static void finishMorning(const char* msg) {
  st = ST_IDLE; level = 0; levelFloor = 0; penalty = false; challenge[0] = 0;
  stopSound();
  playPattern(PAT(PAT_OK), false);
  flash(msg, 4000);
  dirty = true;
}

static void onSolved() {
  challenge[0] = 0;
  stopSound();
  if (wakeCheck) {
    st = ST_GRACE; stateUntil = nowUnix() + GRACE_S;
    playPattern(PAT(PAT_OK), false);
    dirty = true;
  } else {
    finishMorning("GOOD MORNING");
  }
}

static void backToRing(uint8_t floorLevel) {
  st = ST_RING; newChallenge();
  ringStart = nowUnix(); lastAccum = ringStart;
  levelFloor = floorLevel; level = floorLevel;
  dirty = true;
}

static void openPairing() {
  esp_fill_random(pendingKey, 16);
  toHex(pendingKey, 16, pendingHex);
  pairOpen = true;
  pairUntil = nowUnix() + PAIR_WINDOW_S;
  flash("PAIRING", 2000);
  dirty = true;
}

static void closePairing() { pairOpen = false; pendingHex[0] = 0; dirty = true; }

static void commitPair() {
  bool hadKey = hasKey;
  memcpy(key, pendingKey, 16); hasKey = true;
  closePairing();
  if (hadKey) betrayals++;
  if (st == ST_RING) penalty = true;
  if (st == ST_NEW) st = ST_IDLE;
  authed = true;
  lastSeen = nowUnix();
  saveKey(); saveStats(); saveSeen();
  flash(hadKey ? "NEW PHONE?" : "PAIRED", 2500);
  dirty = true;
}

// ---- SOS count-off: hold the pinhole 8 s while ringing, then win 5 counting rounds
static void sosStartRound() {
  sosTarget = SOS_MIN_BEEPS + esp_random() % (SOS_MAX_BEEPS - SOS_MIN_BEEPS + 1);
  sosBeepsLeft = sosTarget; sosPresses = 0;
  sosPhase = SOS_BEEPING;
  sosNextMs = millis() + SOS_LEAD_MS;
  dirty = true;
}
static void startSos() { st = ST_SOS; stopSound(); sosRound = 0; sosStartRound(); }
static void sosFail() { playPattern(PAT(PAT_BAD), false); backToRing(3); flash("WRONG", 2000); }
static void updateSos() {
  uint32_t ms = millis();
  if (sosPhase == SOS_BEEPING) {
    if ((int32_t)(ms - sosNextMs) >= 0) {
      if (sosBeepsLeft > 0) {
        playPattern(PAT(PAT_SOS), false);
        ledFlashUntilMs = ms + 250;
        sosBeepsLeft--;
        sosNextMs = ms + SOS_BEEP_GAP_MS;
      } else {
        sosPhase = SOS_INPUT; sosDeadlineMs = ms + SOS_INPUT_TIMEOUT_MS; sosLastPressMs = 0;
        dirty = true;
      }
    }
    return;
  }
  if (sosPresses > 0 && ms - sosLastPressMs >= SOS_SETTLE_MS) {
    if (sosPresses == sosTarget) {
      sosRound++;
      if (sosRound >= SOS_ROUNDS) { sosEscapes++; saveStats(); finishMorning("ESCAPED"); }
      else { playPattern(PAT(PAT_OK), false); sosStartRound(); }
    } else {
      sosFail();
    }
  } else if (sosPresses == 0 && (int32_t)(ms - sosDeadlineMs) >= 0) {
    sosFail();
  }
}

static void updateStateMachine() {
  uint32_t now = nowUnix();

  if (pairOpen && now >= pairUntil) closePairing();

  if (connected && authed && now - lastSeen >= HEARTBEAT_S) {
    lastSeen = now;
    if (lastSeen - lastSeenSaved >= 600) saveSeen();
  }

  switch (st) {
    case ST_NEW:
      break;

    case ST_IDLE: {
      if (!timeValid) break;
      uint32_t minute = now / 60;
      if (minute == lastFiredMinute) break;
      uint32_t lt = localUnix();
      uint8_t h = (lt / 3600) % 24, m = (lt / 60) % 60, dow = ((lt / 86400) + 4) % 7;   // 1970-01-01 was a Thursday
      for (int i = 0; i < MAX_ALARMS; i++) {
        const Alarm& a = alarms[i];
        if (a.on && (a.mask & (1 << dow)) && a.h == h && a.m == m) {
          lastFiredMinute = minute;
          startRing();
          break;
        }
      }
      break;
    }

    case ST_RING: {
      uint32_t el = now - ringStart;
      uint8_t base = el >= ESCALATE_L3_S ? 3 : el >= ESCALATE_L2_S ? 2 : el >= ESCALATE_L1_S ? 1 : 0;
      uint8_t lv = max(base, levelFloor);
      if (lv != level) { level = lv; dirty = true; }
      break;
    }

    case ST_GRACE:
      if (now >= stateUntil) {
        newChallenge();
        st = ST_CHECK; stateUntil = now + CHECK_S; dirty = true;
      }
      break;

    case ST_CHECK:
      if (now >= stateUntil) { backToRing(2); flash("BACK TO BED?", 2000); }
      break;

    case ST_SOS:
      updateSos();
      break;
  }

  // mercy limit: total time spent screaming this morning
  if (st == ST_RING || st == ST_CHECK) {
    if (now > lastAccum) { ringAccumS += now - lastAccum; lastAccum = now; }
    if (ringAccumS >= (uint32_t)mercyMin * 60) {
      st = ST_IDLE; level = 0; levelFloor = 0; penalty = false; challenge[0] = 0;
      stopSound();
      shame++; saveStats();
      showShame = true;
      dirty = true;
      Serial.println("[crow] mercy limit reached, shame logged");
    }
  } else {
    lastAccum = now;
  }
}

// ------------------------------------------------------------------ commands from the app
static void handleCommand(char* c) {
  // trim trailing whitespace
  for (int n = strlen(c); n > 0 && isspace((unsigned char)c[n - 1]); n--) c[n - 1] = 0;
  char op = c[0];
  const char* arg = c + 1;
  uint32_t now = nowUnix();

  switch (op) {
    case 'A':   // AUTH: proves this connection holds the key
      if (hasKey && proofOk(key, "auth:", nonce, arg)) { authed = true; lastSeen = now; saveSeen(); }
      break;
    case 'S':   // SOLVE: puzzles done, silence the ring
      if (st == ST_RING && hasKey && proofOk(key, "solve:", challenge, arg)) onSolved();
      break;
    case 'W':   // AWAKE: passed the wake check
      if (st == ST_CHECK && hasKey && proofOk(key, "awake:", challenge, arg)) finishMorning("GOOD MORNING");
      break;
    case 'P':   // PAIRED: the app read the pending key and proves it
      if (pairOpen && proofOk(pendingKey, "paired:", nonce, arg)) commitPair();
      break;
    case 'M':   // MISS: a wrong answer makes it louder (no auth needed, it only hurts)
      if (st == ST_RING && now - lastBump >= MISS_BUMP_COOLDOWN_S && levelFloor < 3) {
        levelFloor = min<uint8_t>(3, level + 1); lastBump = now;
      }
      break;
    case 'T': { // TIME: unix,tzMinutes
      if (!authed) break;
      unsigned long u; int tz;
      if (sscanf(arg, "%lu,%d", &u, &tz) == 2 && u > 1600000000UL && tz >= -840 && tz <= 840) {
        setTimeUnix(u); tzMin = tz; saveConfig();
      }
      break;
    }
    case 'L': { // ALARM: slot,HHMM,mask,on
      if (!authed) break;
      int i, hhmm, mask, on;
      if (sscanf(arg, "%d,%d,%d,%d", &i, &hhmm, &mask, &on) == 4 && i >= 0 && i < MAX_ALARMS &&
          hhmm >= 0 && hhmm / 100 < 24 && hhmm % 100 < 60) {
        alarms[i].h = hhmm / 100; alarms[i].m = hhmm % 100;
        alarms[i].mask = mask & 127; alarms[i].on = (on && (mask & 127)) ? 1 : 0;
        saveAlarms();
      }
      break;
    }
    case 'C': { // CONFIG: wakeCheck,mercyMinutes
      if (!authed) break;
      int w, m;
      if (sscanf(arg, "%d,%d", &w, &m) == 2) {
        wakeCheck = w != 0; mercyMin = constrain(m, MERCY_MIN_MIN, MERCY_MAX_MIN); saveConfig();
      }
      break;
    }
    case 'R':   // TEST CAW
      if (authed && st == ST_IDLE) playPattern(PAT(PAT_TEST), false);
      break;
  }
  dirty = true;
}

// ------------------------------------------------------------------ buttons
Button perch   = {PIN_PERCH, false, false, false, false, 0, 0};
Button pinhole = {PIN_PINHOLE, false, false, false, false, 0, 0};

static void onPerchTap() {
  if (st == ST_SOS && sosPhase == SOS_INPUT) { sosPresses++; sosLastPressMs = millis(); ledFlashUntilMs = millis() + 120; dirty = true; return; }
  if (st == ST_RING) { flash("NO SNOOZE", 1200); return; }
  if (showShame) { showShame = false; return; }
  awakeUntilMs = millis() + 8000;
}
static void onPerchLong() { if (st != ST_SOS) openPairing(); }
static void onPinholeLong() {
  if (st == ST_RING || st == ST_CHECK) startSos();
  else if (st == ST_IDLE || st == ST_NEW) flash("FW " FW_VERSION, 3000);
}
static void onPinholeXLong() {
  if (st != ST_IDLE && st != ST_NEW) return;
  flash("FACTORY RESET", 1500);
  prefs.clear();
  delay(300);
  ESP.restart();
}

static void pollButton(Button& b, uint32_t longMs, uint32_t xlongMs, void (*onTap)(), void (*onLong)(), void (*onXLong)()) {
  bool raw = digitalRead(b.pin) == LOW;
  uint32_t ms = millis();
  if (raw != b.lastRaw) { b.lastRaw = raw; b.changedAt = ms; }
  if (ms - b.changedAt > 25 && raw != b.stable) {
    b.stable = raw;
    if (raw) { b.downAt = ms; b.longDone = false; b.xlongDone = false; }
    else if (!b.longDone && onTap) onTap();
  }
  if (b.stable) {
    if (!b.longDone && longMs && ms - b.downAt >= longMs) { b.longDone = true; if (onLong) onLong(); }
    if (!b.xlongDone && xlongMs && ms - b.downAt >= xlongMs) { b.xlongDone = true; if (onXLong) onXLong(); }
  }
}

// ------------------------------------------------------------------ power
uint32_t lastPowerRead = 0, lastBatteryRead = 0;
static void readPower() {
  uint32_t ms = millis();
  if (ms - lastPowerRead < 500) return;
  lastPowerRead = ms;
#if PIN_USB_SENSE >= 0
  bool usb = analogReadMilliVolts(PIN_USB_SENSE) > USB_SENSE_MV;
  if (usb != usbPower) {
    usbPower = usb;
    if (!usb && (st == ST_RING || st == ST_CHECK)) {
      if (st == ST_CHECK) backToRing(3); else levelFloor = 3;
      flash("NICE TRY", 3000);
    }
    dirty = true;
  }
#endif
#if PIN_BATTERY >= 0
  if (ms - lastBatteryRead >= 10000 || lastBatteryRead == 0) {
    lastBatteryRead = ms;
    float mv = analogReadMilliVolts(PIN_BATTERY) * BATTERY_DIVIDER;
    int pct = constrain((int)((mv - 3300.0f) / 9.0f), 0, 100);
    batteryPct = (batteryPct * 3 + pct) / 4;
  }
#endif
}

// ------------------------------------------------------------------ display

static void drawEye(int cx, int cy, Mood m, int gaze, bool left) {
  if (m == M_SLEEP) {
    display.drawFastHLine(cx - 7, cy + 2, 15, OLED_ON);
    display.drawPixel(cx - 8, cy + 1, OLED_ON);
    display.drawPixel(cx + 8, cy + 1, OLED_ON);
    return;
  }
  int r = (m == M_WIDE) ? 10 : 9;
  display.fillCircle(cx, cy, r, OLED_ON);
  display.fillCircle(cx + gaze, cy + 1, 4, OLED_OFF);
  if (m == M_ANGRY) {
    if (left) display.fillTriangle(cx - r - 2, cy - r - 2, cx + r + 2, cy - r - 2, cx + r + 2, cy - 1, OLED_OFF);
    else      display.fillTriangle(cx - r - 2, cy - r - 2, cx + r + 2, cy - r - 2, cx - r - 2, cy - 1, OLED_OFF);
  } else if (m == M_SAD) {
    if (left) display.fillTriangle(cx - r - 2, cy - r - 2, cx + r + 2, cy - r - 2, cx - r - 2, cy - 1, OLED_OFF);
    else      display.fillTriangle(cx - r - 2, cy - r - 2, cx + r + 2, cy - r - 2, cx + r + 2, cy - 1, OLED_OFF);
  } else if (m == M_SQUINT) {
    display.fillRect(cx - r - 1, cy - r - 1, 2 * r + 3, r, OLED_OFF);
  }
}

static void drawFace(Mood m, int gaze, bool beakOpen) {
  drawEye(44, 22, m, gaze, true);
  drawEye(84, 22, m, gaze, false);
  if (beakOpen) {
    display.fillTriangle(58, 29, 70, 29, 64, 34, OLED_ON);
    display.fillTriangle(60, 36, 68, 36, 64, 41, OLED_ON);
  } else {
    display.fillTriangle(59, 31, 69, 31, 64, 38, OLED_ON);
  }
  if (m == M_SAD) display.fillCircle(37, 36, 2, OLED_ON);
}

static void centerText(const char* s, int y, uint8_t size) {
  display.setTextSize(size);
  int16_t x1, y1; uint16_t w, h;
  display.getTextBounds(s, 0, 0, &x1, &y1, &w, &h);
  display.setCursor((128 - (int)w) / 2, y);
  display.print(s);
}

static void clockText(char* out, size_t n, uint32_t lt, bool colon) {
  uint8_t h = (lt / 3600) % 24, m = (lt / 60) % 60;
#if CLOCK_24H
  snprintf(out, n, colon ? "%02u:%02u" : "%02u %02u", h, m);
#else
  uint8_t h12 = ((h + 11) % 12) + 1;
  snprintf(out, n, colon ? "%u:%02u" : "%u %02u", h12, m);
#endif
}

static uint32_t nextAlarmUnix() {
  if (!timeValid) return 0;
  int32_t off = (int32_t)tzMin * 60;
  uint32_t lt = localUnix(), dayStart = lt - lt % 86400, best = 0;
  for (int d = 0; d < 8; d++) {
    uint32_t ds = dayStart + d * 86400UL;
    uint8_t dow = ((ds / 86400) + 4) % 7;
    for (int i = 0; i < MAX_ALARMS; i++) {
      const Alarm& a = alarms[i];
      if (!a.on || !(a.mask & (1 << dow))) continue;
      uint32_t t = ds + a.h * 3600UL + a.m * 60UL;
      if (t > lt && (!best || t < best)) best = t;
    }
  }
  return best ? (uint32_t)((int64_t)best - off) : 0;
}

static void drawStatusRow() {
  display.setTextSize(1);
  uint32_t na = nextAlarmUnix();
  if (na) {
    char t[10];
    clockText(t, sizeof t, (uint32_t)((int64_t)na + (int32_t)tzMin * 60), true);
    display.setCursor(0, 0); display.print(">"); display.print(t);
  }
  if (connected) display.fillCircle(64, 3, 2, OLED_ON);
  char b[6];
  snprintf(b, sizeof b, "%u%%", batteryPct);
  int bx = 128 - 6 * (int)strlen(b);
  display.setCursor(bx, 0);
  display.print(b);
  if (usbPower) { display.drawFastHLine(bx - 7, 3, 5, OLED_ON); display.drawFastVLine(bx - 3, 1, 5, OLED_ON); }
}

static void drawHoldBar(const Button& b, uint32_t holdMs, bool untilXLong) {
  if (!b.stable || (untilXLong ? b.xlongDone : b.longDone)) return;
  uint32_t held = millis() - b.downAt;
  if (held < 400) return;
  int w = min<uint32_t>(128, held * 128 / holdMs);
  display.fillRect(0, 62, w, 2, OLED_ON);
}

static void render() {
  if (!oledOk) return;
  uint32_t ms = millis();
  uint32_t lt = localUnix();
  int gaze = 0;
  char line[32];
  display.clearDisplay();
  display.setTextColor(OLED_ON);
  bool bright = true;
  bool invert = false;

  switch (st) {
    case ST_NEW:
      gaze = (int)(3 * sin(ms / 600.0));
      drawFace(M_WIDE, gaze, false);
      if (pairOpen) { snprintf(line, sizeof line, "PAIRING %lus", (unsigned long)(pairUntil - nowUnix())); centerText(line, 46, 1); centerText("OPEN THE CROW APP", 56, 1); }
      else { centerText("HOLD PERCH 3s", 46, 1); centerText("TO PAIR", 56, 1); }
      break;

    case ST_IDLE: {
      bool awake = (int32_t)(ms - awakeUntilMs) < 0;
      drawStatusRow();
      if (pairOpen) {
        drawFace(M_WIDE, (int)(3 * sin(ms / 400.0)), false);
        snprintf(line, sizeof line, "PAIRING %lus", (unsigned long)(pairUntil - nowUnix()));
        centerText(line, 46, 1); centerText("OPEN THE CROW APP", 56, 1);
      } else if (showShame) {
        drawFace(M_SAD, 0, false);
        centerText("YOU SLEPT THROUGH", 46, 1); centerText("THE CROW. SHAME.", 56, 1);
      } else if (isOrphan()) {
        drawFace(M_SAD, 0, false);
        centerText("WHERE'S MY APP?", 46, 1);
        clockText(line, sizeof line, lt, true); centerText(line, 56, 1);
      } else if (!timeValid) {
        drawFace(M_OPEN, 0, false);
        centerText("--:--", 46, 1); centerText("OPEN APP TO SET", 56, 1);
      } else {
        bool blink = awake && (ms / 150) % 30 == 0;
        drawFace(awake && !blink ? M_OPEN : M_SLEEP, 0, false);
        clockText(line, sizeof line, lt, true);
        centerText(line, 46, 2);
        bright = awake;
      }
      break;
    }

    case ST_RING:
      drawStatusRow();
      drawFace(M_ANGRY, 0, (ms / 300) % 2);
      if ((ms / 1000) % 2) centerText("CAW!", 46, 2);
      else { clockText(line, sizeof line, lt, true); centerText(line, 46, 2); }
      for (int i = 0; i < 4; i++) {
        int h = 3 + i * 3;
        if (i <= level) display.fillRect(110 + i * 4, 44 - h, 3, h, OLED_ON);
        else display.drawRect(110 + i * 4, 44 - h, 3, h, OLED_ON);
      }
      if (penalty) { display.setTextSize(1); display.setCursor(0, 36); display.print("+2"); }
      if (level >= 2) invert = (ms / (level >= 3 ? 250 : 500)) % 2;
      break;

    case ST_GRACE: {
      drawStatusRow();
      drawFace(M_SQUINT, (int)(3 * sin(ms / 900.0)), false);
      uint32_t left = stateUntil > nowUnix() ? stateUntil - nowUnix() : 0;
      centerText("WATCHING YOU", 46, 1);
      snprintf(line, sizeof line, "WAKE CHECK %lu:%02lu", (unsigned long)(left / 60), (unsigned long)(left % 60));
      centerText(line, 56, 1);
      break;
    }

    case ST_CHECK: {
      drawStatusRow();
      drawFace(M_WIDE, 0, false);
      uint32_t left = stateUntil > nowUnix() ? stateUntil - nowUnix() : 0;
      centerText("STILL UP? OPEN APP", 46, 1);
      snprintf(line, sizeof line, "%lu:%02lu", (unsigned long)(left / 60), (unsigned long)(left % 60));
      centerText(line, 56, 1);
      break;
    }

    case ST_SOS:
      drawFace(M_OPEN, sosPhase == SOS_BEEPING ? 0 : (int)(3 * sin(ms / 300.0)), sosPhase == SOS_BEEPING && (int32_t)(ledFlashUntilMs - ms) > 0);
      snprintf(line, sizeof line, "SOS ROUND %u/%u", sosRound + 1, SOS_ROUNDS);
      centerText(line, 46, 1);
      if (sosPhase == SOS_BEEPING) centerText("COUNT THE CAWS", 56, 1);
      else {
        char dots[16] = "";
        for (int i = 0; i < sosPresses && i < 9; i++) strcat(dots, "o");   // 21 chars fit the screen
        snprintf(line, sizeof line, "PRESS PERCH %s", sosPresses ? dots : "x?");
        centerText(line, 56, 1);
      }
      break;
  }

  if ((int32_t)(flashUntilMs - ms) > 0) {
    display.fillRect(0, 44, 128, 20, OLED_OFF);
    centerText(flashMsg, strlen(flashMsg) <= 10 ? 46 : 51, strlen(flashMsg) <= 10 ? 2 : 1);
    bright = true;
  }
  bool ringing = st == ST_RING || st == ST_CHECK;
  drawHoldBar(perch, PERCH_PAIR_HOLD_MS, false);
  drawHoldBar(pinhole, ringing ? PINHOLE_HOLD_MS : PINHOLE_RESET_MS, !ringing);

#if OLED_SH1106
  display.setContrast(bright ? 0xCF : 0x10);
#else
  display.dim(!bright);
#endif
  display.invertDisplay(invert);
  display.display();
}

static void updateLed() {
  uint32_t ms = millis();
  bool on = false;
  switch (st) {
    case ST_RING:  on = (ms / (level >= 2 ? 120 : 400)) % 2; break;
    case ST_CHECK: on = (ms / 700) % 2; break;
    case ST_SOS:   on = (int32_t)(ledFlashUntilMs - ms) > 0; break;
    default:       on = pairOpen && (ms / 1000) % 2; break;
  }
  digitalWrite(PIN_LED, on ? HIGH : LOW);
}

// ------------------------------------------------------------------ BLE
BLEServer* server = nullptr;
BLECharacteristic *chState, *chCmd, *chKey, *chAlarms;

static portMUX_TYPE qMux = portMUX_INITIALIZER_UNLOCKED;
#define CMD_SLOTS 6
static char cmdQueue[CMD_SLOTS][48];
static volatile uint8_t qHead = 0, qTail = 0;
static volatile bool evConnect = false, evDisconnect = false;

static void enqueueCmd(const uint8_t* d, size_t n) {
  if (!d || n == 0) return;
  if (n > 47) n = 47;
  portENTER_CRITICAL(&qMux);
  uint8_t next = (qHead + 1) % CMD_SLOTS;
  if (next != qTail) { memcpy(cmdQueue[qHead], d, n); cmdQueue[qHead][n] = 0; qHead = next; }
  portEXIT_CRITICAL(&qMux);
}
static bool dequeueCmd(char* out) {
  bool ok = false;
  portENTER_CRITICAL(&qMux);
  if (qTail != qHead) { memcpy(out, cmdQueue[qTail], 48); qTail = (qTail + 1) % CMD_SLOTS; ok = true; }
  portEXIT_CRITICAL(&qMux);
  return ok;
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* s) { evConnect = true; }
  void onDisconnect(BLEServer* s) { evDisconnect = true; }
};
class CmdCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) { enqueueCmd(c->getData(), c->getLength()); }
};

char lastStateStr[240] = "";
char lastAlarmsStr[64] = "x";
char lastKeyStr[33] = "x";
uint32_t lastPublishMs = 0;

static void publish(bool force) {
  uint32_t now = nowUnix();
  uint32_t remaining = (st == ST_GRACE || st == ST_CHECK) && stateUntil > now ? stateUntil - now : 0;
  uint32_t elapsed = st == ST_RING ? now - ringStart : 0;
  char buf[240];
  snprintf(buf, sizeof buf,
           "S=%s;L=%u;C=%s;N=%s;T=%lu;Z=%d;A=%lu;P=%d;H=%d;G=%d;B=%u;U=%d;X=%d;O=%d;W=%lu;E=%lu;V=%d;M=%u;Y=%u;Q=%u;R=%u;J=%u;F=%s",
           STATE_NAMES[st], level, (st == ST_RING || st == ST_CHECK) ? challenge : "", nonce,
           (unsigned long)(timeValid ? now : 0), tzMin, (unsigned long)nextAlarmUnix(), pairOpen, hasKey, authed,
           batteryPct, usbPower, penalty, isOrphan(), (unsigned long)remaining, (unsigned long)elapsed,
           wakeCheck, mercyMin, betrayals, shame, sosEscapes, sosRound, FW_VERSION);
  if (force || strcmp(buf, lastStateStr) != 0) {
    strcpy(lastStateStr, buf);
    chState->setValue((uint8_t*)buf, strlen(buf));
    if (connected) chState->notify();
  }

  char al[64] = "";
  for (int i = 0; i < MAX_ALARMS; i++) {
    char slot[16] = "";
    if (alarms[i].mask) snprintf(slot, sizeof slot, "%02u%02u,%u,%u", alarms[i].h, alarms[i].m, alarms[i].mask, alarms[i].on);
    strcat(al, slot);
    if (i < MAX_ALARMS - 1) strcat(al, ";");
  }
  if (strcmp(al, lastAlarmsStr) != 0) { strcpy(lastAlarmsStr, al); chAlarms->setValue((uint8_t*)al, strlen(al)); }

  const char* k = pairOpen ? pendingHex : "";
  if (strcmp(k, lastKeyStr) != 0) { strcpy(lastKeyStr, k); chKey->setValue((uint8_t*)k, strlen(k)); }
  lastPublishMs = millis();
}

static void setupBle() {
  uint64_t mac = ESP.getEfuseMac();
  snprintf(deviceName, sizeof deviceName, "Crow-%04X", (unsigned)((mac >> 32) & 0xFFFF));
  BLEDevice::init(deviceName);
  BLEDevice::setMTU(185);
  server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  BLEService* svc = server->createService(UUID_SERVICE);
  chState = svc->createCharacteristic(UUID_STATE, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  chState->addDescriptor(new BLE2902());
  chCmd = svc->createCharacteristic(UUID_CMD, BLECharacteristic::PROPERTY_WRITE);
  chCmd->setCallbacks(new CmdCallbacks());
  chKey = svc->createCharacteristic(UUID_KEY, BLECharacteristic::PROPERTY_READ);
  chAlarms = svc->createCharacteristic(UUID_ALARMS, BLECharacteristic::PROPERTY_READ);
  svc->start();
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.printf("[crow] advertising as %s\n", deviceName);
}

static void processBle() {
  if (evConnect) {
    evConnect = false;
    connected = true; authed = false; newNonce();
    dirty = true;
  }
  if (evDisconnect) {
    evDisconnect = false;
    connected = false; authed = false; newNonce();
    delay(50);
    BLEDevice::startAdvertising();
    dirty = true;
  }
  char c[48];
  while (dequeueCmd(c)) handleCommand(c);
}

// ------------------------------------------------------------------ main
uint32_t lastRtcSync = 0, lastRenderMs = 0;

void setup() {
  Serial.begin(115200);
  pinMode(PIN_PERCH, INPUT_PULLUP);
  pinMode(PIN_PINHOLE, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);

  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
#if OLED_SH1106
  oledOk = display.begin(OLED_ADDR, true);
#else
  oledOk = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
#endif
  if (oledOk) { display.clearDisplay(); display.display(); }

  rtcOk = rtc.begin(&Wire);
  if (rtcOk && !rtc.lostPower()) {
    uint32_t u = rtc.now().unixtime();
    if (u > 1700000000UL) { softBaseUnix = u; softBaseMs = millis(); timeValid = true; }
  }

  prefs.begin("crow", false);
  loadAll();
  st = hasKey ? ST_IDLE : ST_NEW;
  if (timeValid) lastFiredMinute = nowUnix() / 60 - 1;
  newNonce();

  setupBle();
  publish(true);
  playPattern(PAT(PAT_OK), false);
  Serial.printf("[crow] boot: key=%d rtc=%d oled=%d time=%d\n", hasKey, rtcOk, oledOk, timeValid);
}

void loop() {
  uint32_t ms = millis();
  processBle();
  pollButton(perch, PERCH_PAIR_HOLD_MS, 0, onPerchTap, onPerchLong, nullptr);
  pollButton(pinhole, PINHOLE_HOLD_MS, PINHOLE_RESET_MS, nullptr, onPinholeLong, onPinholeXLong);
  readPower();

  if (ms - lastRtcSync >= 60000) {
    lastRtcSync = ms;
    if (rtcOk && timeValid) { uint32_t u = rtc.now().unixtime(); if (u > 1700000000UL) { softBaseUnix = u; softBaseMs = millis(); } }
    else rebaseSoftClock();
  }

  updateStateMachine();
  ensureRingSound();
  updateSound();
  updateLed();

  if (ms - lastRenderMs >= 100) { lastRenderMs = ms; render(); }
  bool active = st == ST_RING || st == ST_GRACE || st == ST_CHECK || st == ST_SOS || pairOpen;
  if (dirty || ms - lastPublishMs >= (uint32_t)(active ? 1000 : 5000)) { dirty = false; publish(false); }
  delay(5);
}
