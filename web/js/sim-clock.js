// A line-by-line JavaScript port of firmware/crow/crow.ino, so the simulator behaves like the
// real clock. Same states, same timings (rules.js), same HMAC proofs, same wire format.
// Time comes from outside: simMs is the simulated wall clock, realMs drives buttons and SOS.

import { RULES, FW_VERSION } from './rules.js';
import { encodeState, encodeAlarms, proof, randomHex, fmtClock } from './proto.js';

const NOOP_SOUND = { ring() {}, check() {}, stop() {}, test() {}, ok() {}, bad() {}, sos() {} };

export class SimClock {
  constructor({ name = 'Crow-7F3A', simMs = Date.now(), realMs = 0, tzMin, sound = NOOP_SOUND, log = () => {} } = {}) {
    this.name = name;
    this.sound = sound;
    this.log = log;
    this.simMs = simMs;
    this.realMs = realMs;

    // persisted on the clock (NVS)
    this.key = null;
    this.alarms = [null, null, null, null];
    this.wakeCheck = true;
    this.mercyMin = RULES.defaultMercyMin;
    this.tzMin = tzMin ?? -new Date(simMs).getTimezoneOffset();
    this.lastSeen = 0;
    this.betrayals = 0;
    this.shame = 0;
    this.sosEscapes = 0;

    // runtime
    this.state = 'NEW';
    this.level = 0;
    this.levelFloor = 0;
    this.penalty = false;
    this.challenge = '';
    this.nonce = randomHex(8);
    this.ringStart = 0;
    this.ringAccumS = 0;
    this.lastAccum = 0;
    this.stateUntil = 0;
    this.lastFiredMinute = Math.floor(simMs / 60000) - 1;
    this.lastBump = 0;
    this.pendingKey = '';
    this.pairOpen = false;
    this.pairUntil = 0;
    this.connected = false;
    this.authed = false;
    this.usb = true;
    this.battery = 100;
    this.showShame = false;
    this.flashMsg = '';
    this.flashUntil = 0;
    this.awakeUntil = 0;
    this.timeValid = true;   // the sim's RTC was set at the factory

    this.sos = { phase: 'BEEPING', round: 0, target: 0, beepsLeft: 0, presses: 0, nextMs: 0, lastPressMs: 0, deadlineMs: 0, ledUntil: 0 };
    this.perch = { down: false, at: 0, longDone: false, xlongDone: false };
    this.pin = { down: false, at: 0, longDone: false, xlongDone: false };

    this.soundMode = null;
    this.listeners = new Set();
    this.dirty = true;
    this.lastEmitSec = -1;
    this.lastEmitReal = -1e9;
    this.lastBattSec = Math.floor(simMs / 1000);
  }

  // ---------------------------------------------------------------- basics
  now() { return Math.floor(this.simMs / 1000); }
  localUnix() { return this.now() + this.tzMin * 60; }
  isOrphan() { return !!this.key && this.lastSeen > 0 && this.timeValid && this.now() > this.lastSeen + RULES.orphanS; }
  flash(msg, ms) { this.flashMsg = msg; this.flashUntil = this.realMs + ms; }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  // ---------------------------------------------------------------- state machine
  newChallenge() { this.challenge = randomHex(8); }

  startRing() {
    this.state = 'RING';
    this.level = 0; this.levelFloor = 0; this.penalty = false;
    const orphan = this.isOrphan();
    if (orphan) { this.penalty = true; this.levelFloor = 2; }
    this.newChallenge();
    this.ringStart = this.now(); this.ringAccumS = 0; this.lastAccum = this.ringStart;
    this.showShame = false;
    this.dirty = true;
    this.log('crow', orphan
      ? `Alarm! No app check-in for over 24 h, so it starts at level 3 with a penalty round. Challenge ${this.challenge.slice(0, 6)}…`
      : `Alarm! RING at level 1. New challenge ${this.challenge.slice(0, 6)}…`);
  }

  finishMorning(msg, why) {
    this.state = 'IDLE'; this.level = 0; this.levelFloor = 0; this.penalty = false; this.challenge = '';
    this.sound.stop(); this.soundMode = null;
    this.sound.ok();
    this.flash(msg, 4000);
    this.dirty = true;
    this.log('crow', why);
  }

  onSolved() {
    this.challenge = '';
    this.sound.stop(); this.soundMode = null;
    if (this.wakeCheck) {
      this.state = 'GRACE';
      this.stateUntil = this.now() + RULES.graceS;
      this.sound.ok();
      this.dirty = true;
      this.log('crow', `Proof accepted. Quiet for ${RULES.graceS / 60} min, then a wake check.`);
    } else {
      this.finishMorning('GOOD MORNING', 'Proof accepted. Back to idle.');
    }
  }

  backToRing(floorLevel, why) {
    this.state = 'RING';
    this.newChallenge();
    this.ringStart = this.now(); this.lastAccum = this.ringStart;
    this.levelFloor = floorLevel; this.level = floorLevel;
    this.dirty = true;
    this.log('crow', `${why} Back to RING at level ${floorLevel + 1}.`);
  }

  openPairing() {
    this.pendingKey = randomHex(16);
    this.pairOpen = true;
    this.pairUntil = this.now() + RULES.pairWindowS;
    this.flash('PAIRING', 2000);
    this.dirty = true;
    this.log('crow', `Pairing open for ${RULES.pairWindowS} s. A fresh key is waiting to be read.`);
  }

  closePairing() { this.pairOpen = false; this.pendingKey = ''; this.dirty = true; }

  commitPair() {
    const hadKey = !!this.key;
    this.key = this.pendingKey;
    this.closePairing();
    if (hadKey) this.betrayals++;
    if (this.state === 'RING') this.penalty = true;
    if (this.state === 'NEW') this.state = 'IDLE';
    this.authed = true;
    this.lastSeen = this.now();
    this.flash(hadKey ? 'NEW PHONE?' : 'PAIRED', 2500);
    this.dirty = true;
    this.log('crow', hadKey
      ? `Re-paired. The old key is dead. Betrayal #${this.betrayals} saved on the clock${this.penalty ? ', and this ring now needs +2 puzzles' : ''}.`
      : 'Paired. The key is saved on the clock and in the app.');
  }

  sosStartRound() {
    const s = this.sos;
    s.target = RULES.sosMinBeeps + Math.floor(Math.random() * (RULES.sosMaxBeeps - RULES.sosMinBeeps + 1));
    s.beepsLeft = s.target; s.presses = 0;
    s.phase = 'BEEPING';
    s.nextMs = this.realMs + RULES.sosLeadMs;
    this.dirty = true;
  }

  startSos() {
    this.state = 'SOS';
    this.sound.stop(); this.soundMode = null;
    this.sos.round = 0;
    this.sosStartRound();
    this.log('crow', `SOS count-off. Count the beeps, press the perch that many times. ${RULES.sosRounds} rounds.`);
  }

  sosFail() { this.sound.bad(); this.flash('WRONG', 2000); this.backToRing(3, 'SOS count was wrong.'); }

  updateSos() {
    const s = this.sos, ms = this.realMs;
    if (s.phase === 'BEEPING') {
      if (ms >= s.nextMs) {
        if (s.beepsLeft > 0) {
          this.sound.sos();
          s.ledUntil = ms + 250;
          s.beepsLeft--;
          s.nextMs = ms + RULES.sosBeepGapMs;
        } else {
          s.phase = 'INPUT'; s.deadlineMs = ms + RULES.sosInputTimeoutMs; s.lastPressMs = 0;
          this.dirty = true;
        }
      }
      return;
    }
    if (s.presses > 0 && ms - s.lastPressMs >= RULES.sosSettleMs) {
      if (s.presses === s.target) {
        s.round++;
        if (s.round >= RULES.sosRounds) {
          this.sosEscapes++;
          this.finishMorning('ESCAPED', `SOS passed. Escape #${this.sosEscapes} saved on the clock.`);
        } else {
          this.sound.ok();
          this.log('crow', `SOS round ${s.round} of ${RULES.sosRounds} correct.`);
          this.sosStartRound();
        }
      } else {
        this.sosFail();
      }
    } else if (s.presses === 0 && ms >= s.deadlineMs) {
      this.sosFail();
    }
  }

  updateStateMachine() {
    const now = this.now();
    if (this.pairOpen && now >= this.pairUntil) { this.closePairing(); this.log('crow', 'Pairing window closed.'); }
    if (this.connected && this.authed && now - this.lastSeen >= RULES.heartbeatS) this.lastSeen = now;

    switch (this.state) {
      case 'IDLE': {
        if (!this.timeValid) break;
        const minute = Math.floor(now / 60);
        if (minute === this.lastFiredMinute) break;
        const lt = this.localUnix();
        const h = Math.floor(lt / 3600) % 24, m = Math.floor(lt / 60) % 60, dow = (Math.floor(lt / 86400) + 4) % 7;
        for (const a of this.alarms) {
          if (a && a.on && (a.mask & (1 << dow)) && a.h === h && a.m === m) {
            this.lastFiredMinute = minute;
            this.startRing();
            break;
          }
        }
        break;
      }
      case 'RING': {
        const el = now - this.ringStart;
        const E = RULES.escalateS;
        const base = el >= E[3] ? 3 : el >= E[2] ? 2 : el >= E[1] ? 1 : 0;
        const lv = Math.max(base, this.levelFloor);
        if (lv !== this.level) { this.level = lv; this.dirty = true; this.log('crow', `Louder: level ${lv + 1} of 4.`); }
        break;
      }
      case 'GRACE':
        if (now >= this.stateUntil) {
          this.newChallenge();
          this.state = 'CHECK'; this.stateUntil = now + RULES.checkS; this.dirty = true;
          this.log('crow', `Wake check! Chirping. The app has ${RULES.checkS / 60} min to prove you're up.`);
        }
        break;
      case 'CHECK':
        if (now >= this.stateUntil) { this.flash('BACK TO BED?', 2000); this.backToRing(2, 'Wake check missed.'); }
        break;
      case 'SOS':
        this.updateSos();
        break;
    }

    if (this.state === 'RING' || this.state === 'CHECK') {
      if (now > this.lastAccum) { this.ringAccumS += now - this.lastAccum; this.lastAccum = now; }
      if (this.ringAccumS >= this.mercyMin * 60) {
        this.state = 'IDLE'; this.level = 0; this.levelFloor = 0; this.penalty = false; this.challenge = '';
        this.sound.stop(); this.soundMode = null;
        this.shame++;
        this.showShame = true;
        this.dirty = true;
        this.log('crow', `Mercy limit (${this.mercyMin} min) reached. The crow gives up. Shame #${this.shame} saved on the clock.`);
      }
    } else {
      this.lastAccum = now;
    }
  }

  ensureRingSound() {
    if (this.state === 'RING') {
      if (this.soundMode !== this.level) { this.soundMode = this.level; this.sound.ring(this.level); }
    } else if (this.state === 'CHECK') {
      if (this.soundMode !== 'check') { this.soundMode = 'check'; this.sound.check(); }
    } else if (this.soundMode !== null) {
      this.soundMode = null; this.sound.stop();
    }
  }

  // ---------------------------------------------------------------- commands (from the app over BLE)
  async command(raw) {
    const c = String(raw).trim();
    const op = c[0], arg = c.slice(1);
    const now = this.now();
    const ok = async (key, prefix, data) => !!key && !!data && arg.length === 16 && (await proof(key, prefix, data)) === arg.toLowerCase();

    switch (op) {
      case 'A':
        if (this.key && await ok(this.key, 'auth:', this.nonce)) { this.authed = true; this.lastSeen = now; }
        else this.log('crow', 'AUTH refused: that key is not the one I know.');
        break;
      case 'S':
        if (this.state === 'RING' && await ok(this.key, 'solve:', this.challenge)) this.onSolved();
        else this.log('crow', 'SOLVE refused: wrong proof for this challenge.');
        break;
      case 'W':
        if (this.state === 'CHECK' && await ok(this.key, 'awake:', this.challenge)) this.finishMorning('GOOD MORNING', 'Wake check passed. Back to idle.');
        break;
      case 'P':
        if (this.pairOpen && await ok(this.pendingKey, 'paired:', this.nonce)) this.commitPair();
        break;
      case 'M':
        if (this.state === 'RING' && now - this.lastBump >= RULES.missBumpCooldownS && this.levelFloor < 3) {
          this.levelFloor = Math.min(3, this.level + 1); this.lastBump = now;
          this.log('crow', 'Wrong answer reported. Getting louder.');
        }
        break;
      case 'T': {
        if (!this.authed) break;
        const m = /^(\d+),(-?\d+)$/.exec(arg);
        // The sim's clock and phone share one world clock, so only the timezone needs taking.
        if (m && +m[1] > 1600000000 && Math.abs(+m[2]) <= 840) { this.tzMin = +m[2]; this.timeValid = true; }
        break;
      }
      case 'L': {
        if (!this.authed) break;
        const m = /^(\d),(\d{1,4}),(\d+),(\d)$/.exec(arg);
        if (!m) break;
        const i = +m[1], hhmm = +m[2], mask = +m[3] & 127, on = +m[4];
        if (i >= 4 || Math.floor(hhmm / 100) >= 24 || hhmm % 100 >= 60) break;
        this.alarms[i] = mask ? { h: Math.floor(hhmm / 100), m: hhmm % 100, mask, on: !!(on && mask) } : null;
        break;
      }
      case 'C': {
        if (!this.authed) break;
        const m = /^(\d),(\d+)$/.exec(arg);
        if (m) { this.wakeCheck = m[1] !== '0'; this.mercyMin = Math.min(RULES.mercyMaxMin, Math.max(RULES.mercyMinMin, +m[2])); }
        break;
      }
      case 'R':
        if (this.authed && this.state === 'IDLE') this.sound.test();
        break;
    }
    this.dirty = true;
    this.emit();
  }

  // ---------------------------------------------------------------- BLE link events
  bleConnect() { this.connected = true; this.authed = false; this.nonce = randomHex(8); this.dirty = true; this.emit(); }
  bleDisconnect() { this.connected = false; this.authed = false; this.nonce = randomHex(8); this.dirty = true; this.emit(); }

  // ---------------------------------------------------------------- buttons
  onPerchTap() {
    const s = this.sos;
    if (this.state === 'SOS' && s.phase === 'INPUT') { s.presses++; s.lastPressMs = this.realMs; s.ledUntil = this.realMs + 120; this.dirty = true; return; }
    if (this.state === 'RING') { this.flash('NO SNOOZE', 1200); this.log('crow', 'Perch pressed while ringing. There is no snooze.'); return; }
    if (this.showShame) { this.showShame = false; return; }
    this.awakeUntil = this.realMs + 8000;
  }
  onPerchLong() { if (this.state !== 'SOS') this.openPairing(); }
  onPinholeLong() {
    if (this.state === 'RING' || this.state === 'CHECK') this.startSos();
    else if (this.state === 'IDLE' || this.state === 'NEW') this.flash('FW ' + FW_VERSION, 3000);
  }
  onPinholeXLong() {
    if (this.state !== 'IDLE' && this.state !== 'NEW') return;
    this.log('crow', 'Factory reset: key, alarms and stats wiped.');
    this.key = null; this.alarms = [null, null, null, null]; this.wakeCheck = true; this.mercyMin = RULES.defaultMercyMin;
    this.lastSeen = 0; this.betrayals = 0; this.shame = 0; this.sosEscapes = 0;
    this.state = 'NEW'; this.authed = false; this.showShame = false;
    this.dirty = true;
  }

  press(which, down, realMs = this.realMs) {
    const b = which === 'perch' ? this.perch : this.pin;
    this.realMs = Math.max(this.realMs, realMs);
    if (down) { b.down = true; b.at = this.realMs; b.longDone = false; b.xlongDone = false; }
    else {
      if (b.down && !b.longDone && which === 'perch') this.onPerchTap();
      b.down = false;
    }
    this.dirty = true;
    this.emit();
  }

  pollButtons() {
    const ms = this.realMs;
    const p = this.perch, q = this.pin;
    if (p.down && !p.longDone && ms - p.at >= RULES.perchPairHoldMs) { p.longDone = true; this.onPerchLong(); }
    if (q.down && !q.longDone && ms - q.at >= RULES.pinholeHoldMs) { q.longDone = true; this.onPinholeLong(); }
    if (q.down && !q.xlongDone && ms - q.at >= RULES.pinholeResetHoldMs) { q.xlongDone = true; this.onPinholeXLong(); }
  }

  setUsb(on) {
    if (on === this.usb) return;
    this.usb = on;
    if (!on && (this.state === 'RING' || this.state === 'CHECK')) {
      this.flash('NICE TRY', 3000);
      if (this.state === 'CHECK') this.backToRing(3, 'Unplugged during the wake check.');
      else { this.levelFloor = 3; this.log('crow', 'Unplugged while ringing. Running on battery at full volume.'); }
    } else {
      this.log('crow', on ? 'USB power back. Charging.' : 'Unplugged. Running on battery; the alarms still work.');
    }
    this.dirty = true;
    this.emit();
  }

  // ---------------------------------------------------------------- main tick
  tick(simMs, realMs) {
    this.simMs = simMs;
    this.realMs = realMs;
    const sec = this.now();
    if (sec > this.lastBattSec) {
      const d = Math.min(sec - this.lastBattSec, 3600);
      const ringing = this.state === 'RING' || this.state === 'CHECK';
      this.battery = this.usb ? Math.min(100, this.battery + d / 60) : Math.max(0, this.battery - d * (ringing ? 1 / 120 : 1 / 2400));
      this.lastBattSec = sec;
    }
    this.pollButtons();
    this.updateStateMachine();
    this.ensureRingSound();
    const active = ['RING', 'GRACE', 'CHECK', 'SOS'].includes(this.state) || this.pairOpen;
    if (this.dirty || (sec !== this.lastEmitSec && (active || realMs - this.lastEmitReal > 1000) && realMs - this.lastEmitReal >= 150)) {
      this.dirty = false;
      this.lastEmitSec = sec;
      this.lastEmitReal = realMs;
      this.emit();
    }
  }

  // ---------------------------------------------------------------- what the app reads over BLE
  nextAlarmUnix() {
    if (!this.timeValid) return 0;
    const off = this.tzMin * 60, lt = this.localUnix(), dayStart = lt - (lt % 86400);
    let best = 0;
    for (let d = 0; d < 8; d++) {
      const ds = dayStart + d * 86400, dow = (Math.floor(ds / 86400) + 4) % 7;
      for (const a of this.alarms) {
        if (!a || !a.on || !(a.mask & (1 << dow))) continue;
        const t = ds + a.h * 3600 + a.m * 60;
        if (t > lt && (!best || t < best)) best = t;
      }
    }
    return best ? best - off : 0;
  }

  stateString() {
    const now = this.now();
    const ringing = this.state === 'RING' || this.state === 'CHECK';
    return encodeState({
      state: this.state, level: this.level, challenge: ringing ? this.challenge : '', nonce: this.nonce,
      now: this.timeValid ? now : 0, tz: this.tzMin, nextAlarm: this.nextAlarmUnix(), pairOpen: this.pairOpen,
      hasKey: !!this.key, authed: this.authed, battery: Math.round(this.battery), usb: this.usb, penalty: this.penalty,
      orphan: this.isOrphan(),
      remaining: (this.state === 'GRACE' || this.state === 'CHECK') && this.stateUntil > now ? this.stateUntil - now : 0,
      elapsed: this.state === 'RING' ? now - this.ringStart : 0,
      wakeCheck: this.wakeCheck, mercy: this.mercyMin, betrayals: this.betrayals, shame: this.shame,
      sosEscapes: this.sosEscapes, sosRound: this.sos.round, fw: FW_VERSION,
    });
  }
  alarmsString() { return encodeAlarms(this.alarms); }
  keyValue() { return this.pairOpen ? this.pendingKey : ''; }

  // ---------------------------------------------------------------- what the OLED shows (mirror of render())
  clockText(lt) {
    const h = Math.floor(lt / 3600) % 24, m = Math.floor(lt / 60) % 60;
    return fmtClock(h, m).time;
  }

  screen() {
    const ms = this.realMs, now = this.now(), lt = this.localUnix();
    const out = { mood: 'open', gaze: 0, beakOpen: false, status: null, lines: [], bars: -1, penalty: false, invert: false, bright: true, hold: 0, led: false };
    const line = (text, y, size = 1) => out.lines.push({ text, y, size });
    const status = () => {
      const na = this.nextAlarmUnix();
      out.status = { next: na ? this.clockText(na + this.tzMin * 60) : '', ble: this.connected, batt: `${Math.round(this.battery)}%`, usb: this.usb };
    };
    const s = this.sos;

    switch (this.state) {
      case 'NEW':
        out.mood = 'wide'; out.gaze = Math.round(3 * Math.sin(ms / 600));
        if (this.pairOpen) { line(`PAIRING ${this.pairUntil - now}s`, 46); line('OPEN THE CROW APP', 56); }
        else { line('HOLD PERCH 3s', 46); line('TO PAIR', 56); }
        break;
      case 'IDLE': {
        const awake = ms < this.awakeUntil;
        status();
        if (this.pairOpen) {
          out.mood = 'wide'; out.gaze = Math.round(3 * Math.sin(ms / 400));
          line(`PAIRING ${this.pairUntil - now}s`, 46); line('OPEN THE CROW APP', 56);
        } else if (this.showShame) {
          out.mood = 'sad'; line('YOU SLEPT THROUGH', 46); line('THE CROW. SHAME.', 56);
        } else if (this.isOrphan()) {
          out.mood = 'sad'; line("WHERE'S MY APP?", 46); line(this.clockText(lt), 56);
        } else {
          const blink = awake && Math.floor(ms / 150) % 30 === 0;
          out.mood = awake && !blink ? 'open' : 'sleep';
          line(this.clockText(lt), 46, 2);
          out.bright = awake;
        }
        break;
      }
      case 'RING':
        status();
        out.mood = 'angry'; out.beakOpen = Math.floor(ms / 300) % 2 === 1;
        line(Math.floor(ms / 1000) % 2 ? 'CAW!' : this.clockText(lt), 46, 2);
        out.bars = this.level; out.penalty = this.penalty;
        if (this.level >= 2) out.invert = Math.floor(ms / (this.level >= 3 ? 250 : 500)) % 2 === 1;
        out.led = Math.floor(ms / (this.level >= 2 ? 120 : 400)) % 2 === 1;
        break;
      case 'GRACE': {
        status();
        out.mood = 'squint'; out.gaze = Math.round(3 * Math.sin(ms / 900));
        const left = Math.max(0, this.stateUntil - now);
        line('WATCHING YOU', 46); line(`WAKE CHECK ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`, 56);
        break;
      }
      case 'CHECK': {
        status();
        out.mood = 'wide';
        const left = Math.max(0, this.stateUntil - now);
        line('STILL UP? OPEN APP', 46); line(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`, 56);
        out.led = Math.floor(ms / 700) % 2 === 1;
        break;
      }
      case 'SOS':
        out.mood = 'open';
        out.gaze = s.phase === 'BEEPING' ? 0 : Math.round(3 * Math.sin(ms / 300));
        out.beakOpen = s.phase === 'BEEPING' && s.ledUntil > ms;
        line(`SOS ROUND ${s.round + 1}/${RULES.sosRounds}`, 46);
        line(s.phase === 'BEEPING' ? 'COUNT THE CAWS' : `PRESS PERCH ${s.presses ? 'o'.repeat(Math.min(9, s.presses)) : 'x?'}`, 56);
        out.led = s.ledUntil > ms;
        break;
    }
    if (this.state !== 'RING' && this.state !== 'CHECK' && this.state !== 'SOS') out.led = this.pairOpen && Math.floor(ms / 1000) % 2 === 1;

    if (ms < this.flashUntil) {
      out.lines = out.lines.filter(l => l.y < 44);
      out.flash = { text: this.flashMsg, size: this.flashMsg.length <= 10 ? 2 : 1 };
      out.bright = true;
    }
    const ringing = this.state === 'RING' || this.state === 'CHECK';
    if (this.perch.down && !this.perch.longDone && ms - this.perch.at >= 400) out.hold = Math.min(1, (ms - this.perch.at) / RULES.perchPairHoldMs);
    const pinTarget = ringing ? RULES.pinholeHoldMs : RULES.pinholeResetHoldMs;
    const pinDone = ringing ? this.pin.longDone : this.pin.xlongDone;
    if (this.pin.down && !pinDone && ms - this.pin.at >= 400) out.hold = Math.min(1, (ms - this.pin.at) / pinTarget);
    return out;
  }
}
