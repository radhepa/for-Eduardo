// The Crow companion app. The same code runs inside the simulator's phone and as the real
// Web Bluetooth app (app.html). It holds the key; the clock holds everything else.
//
// new CrowApp(root, { link, storage, env })
//   link:    SimLink or BleLink (connect, read state/key/alarms, send commands)
//   storage: get/set/remove/getJSON/setJSON/clear (the app's private data; gone if the app is deleted)
//   env:     { kind: 'sim'|'real', now(), notify(title, body), log(who, msg), vibrate?(ms) }

import { RULES, APP_VERSION } from './rules.js';
import { cmd, proof, nextAlarmFrom, fmtClock, fmtDur, fmtUntil, daysLabel, dayWord, DAY_LETTERS, pad2, esc } from './proto.js';
import { PUZZLES, PUZZLE_ORDER, DIFFICULTIES, pickPuzzle } from './puzzles.js';
import { crowSVG } from './crow-art.js';

const DEFAULT_SETTINGS = {
  puzzles: { math: true, memory: true, hunt: true, clash: true, scramble: true, odd: true },
  difficulty: 'normal',
  rounds: 2,
  noWeaselH: 8,
};
const DEFAULT_STATS = { wakes: 0, streak: 0, lastWakeDay: '', totalSolveS: 0, fastestS: 0, misses: 0, history: [] };
const NO_WEASEL_OPTIONS = [0, 4, 8, 12];

function dayKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function friendlyError(e) {
  const m = String(e?.message || e || '');
  if (/bluetooth adapter|not available|Bluetooth is not/i.test(m)) return 'Bluetooth is off or missing on this device. Turn it on and try again.';
  if (/GATT|disconnected|NetworkError/i.test(m)) return 'Lost the connection to the crow. Move closer and tap Connect.';
  return m || 'Something went wrong talking to the crow. Try again.';
}

export class CrowApp {
  constructor(root, { link, storage, env }) {
    this.root = root;
    this.link = link;
    this.store = storage;
    this.env = env;

    this.key = storage.get('key') || null;
    this.deviceName = storage.get('device') || '';
    const st = storage.getJSON('settings') || {};
    this.settings = { ...DEFAULT_SETTINGS, ...st, puzzles: { ...DEFAULT_SETTINGS.puzzles, ...(st.puzzles || {}) } };
    this.stats = { ...DEFAULT_STATS, ...(storage.getJSON('stats') || {}) };

    this.s = null;              // last clock state
    this.alarms = [null, null, null, null];
    this.view = 'home';
    this.screenKey = null;
    this.pairing = false;
    this.pairBusy = false;
    this.pairMsg = '';
    this.session = null;
    this.outcome = null;
    this.overlay = null;
    this.editing = null;
    this.authNonce = null;
    this.syncedNonce = null;
    this.keyRejected = false;
    this.connecting = false;
    this.confirmForget = false;
    this.visible = true;
    this.lastMissSent = 0;
    this.cleanupPuzzle = null;
    this.renderSeq = 0;

    root.classList.add('crow-app');
    root.innerHTML = '<div class="ca-stage"></div><div class="ca-toasts" aria-live="polite"></div>';
    this.stage = root.querySelector('.ca-stage');
    this.toasts = root.querySelector('.ca-toasts');
    this.onClickBound = (e) => this.onClick(e);
    this.onChangeBound = (e) => this.onChange(e);
    root.addEventListener('click', this.onClickBound);
    root.addEventListener('change', this.onChangeBound);
    this.unsubs = [
      link.onState((s) => this.onState(s)),
      link.onConnection((c) => this.onConnection(c)),
    ];
    this.update(true);
  }

  async start() {
    if (this.key && !this.link.connected) {
      try { await this.link.reconnect(); } catch { /* stay disconnected; the user can tap Connect */ }
    }
    this.update();
  }

  destroy() {
    this.unsubs.forEach(u => u && u());
    this.cleanupPuzzle?.();
    this.root.removeEventListener('click', this.onClickBound);
    this.root.removeEventListener('change', this.onChangeBound);
    this.root.innerHTML = '';
    this.destroyed = true;
  }

  setVisible(v) { this.visible = v; if (v) this.update(); }

  log(msg) { this.env.log?.('app', msg); }
  saveSettings() { this.store.setJSON('settings', this.settings); }
  saveStats() { this.store.setJSON('stats', this.stats); }

  toast(msg, ms = 2800) {
    const t = document.createElement('div');
    t.className = 'ca-toast';
    t.textContent = msg;
    this.toasts.appendChild(t);
    setTimeout(() => t.classList.add('out'), ms - 300);
    setTimeout(() => t.remove(), ms);
  }

  // ---------------------------------------------------------------- talking to the clock
  async send(c) {
    if (!this.link.connected) throw new Error('Not connected to the crow.');
    await this.link.send(c);
  }

  async refreshAlarms() {
    try { this.alarms = await this.link.readAlarms(); } catch (e) { this.toast(friendlyError(e)); }
  }

  onConnection(connected) {
    if (this.destroyed) return;
    if (!connected) { this.authNonce = null; this.syncedNonce = null; this.s = null; }
    else if (this.link.deviceName) {
      this.deviceName = this.link.deviceName;
      if (this.key) this.store.set('device', this.deviceName);
    }
    this.update();
  }

  async onState(s) {
    if (this.destroyed) return;
    const prev = this.s;
    this.s = s;
    if (prev && this.key && !this.keyRejected) this.detectOutcome(prev, s);
    this.trackSession(s);
    if (this.pairing && s.pairOpen && !this.pairBusy) this.completePairing();
    this.update();
    await this.ensureAuth(s);
  }

  async ensureAuth(s) {
    if (!this.key || !this.link.connected || this.pairBusy) return;
    if (s.authed) {
      this.keyRejected = false;
      if (this.syncedNonce !== s.nonce) {
        this.syncedNonce = s.nonce;
        try {
          const now = this.env.now();
          await this.send(cmd.time(now / 1000, -new Date(now).getTimezoneOffset()));
          await this.refreshAlarms();
        } catch (e) { this.syncedNonce = null; }
        this.update(true);
      }
      return;
    }
    if (this.authNonce === s.nonce) return;
    this.authNonce = s.nonce;
    try {
      await this.send(cmd.auth(await proof(this.key, 'auth:', s.nonce)));
      const s2 = await this.link.readState();
      if (!s2.authed && s2.nonce === s.nonce) {
        this.keyRejected = true;
        this.log('The clock does not recognize this phone\'s key.');
        this.update(true);
      }
    } catch (e) { this.authNonce = null; }
  }

  trackSession(s) {
    const notify = (title, body) => { if (!this.visible) this.env.notify?.(title, body); };
    if (s.state === 'RING' && (!this.session || this.session.ringChallenge !== s.challenge)) {
      const carry = this.session && !this.session.done ? this.session : null;
      this.session = {
        ringChallenge: s.challenge, checkChallenge: '', solved: 0, inPuzzle: false, submitting: false,
        puzzleId: null, lastPuzzle: carry?.lastPuzzle || null, misses: carry?.misses || 0,
        relapse: !!carry, solveElapsed: carry?.solveElapsed || 0, done: false, startedAt: this.env.now(),
      };
      this.checkTaps = 0;
      if (this.key) notify(carry ? 'Back to ringing' : 'CAW. Your alarm is ringing', carry ? 'You missed the wake check. New puzzles, louder crow.' : 'Open Crow and solve your way to silence.');
    }
    if (s.state === 'CHECK' && this.session && this.session.checkChallenge !== s.challenge) {
      this.session.checkChallenge = s.challenge;
      this.checkTaps = 0;
      notify('Wake check', 'The crow wants proof you are still up. Tap within 2 minutes.');
    }
  }

  detectOutcome(prev, s) {
    const wasActive = ['RING', 'GRACE', 'CHECK', 'SOS'].includes(prev.state);
    if (!wasActive || s.state !== 'IDLE') return;
    const sess = this.session;
    if (s.shame > prev.shame) {
      this.outcome = { kind: 'shame', shame: s.shame, mercy: s.mercy };
      if (sess) sess.done = true;
      this.stats.streak = 0; this.saveStats();
      this.log('Shame recorded. Streak reset.');
    } else if (s.sosEscapes > prev.sosEscapes) {
      this.outcome = { kind: 'escaped', count: s.sosEscapes };
      if (sess) sess.done = true;
    } else if (prev.state === 'GRACE' || prev.state === 'CHECK' || (prev.state === 'RING' && sess?.submitting)) {
      this.recordWake();
    }
  }

  recordWake() {
    const sess = this.session || { solveElapsed: 0, misses: 0 };
    if (sess.done) return;
    sess.done = true;
    const st = this.stats, today = dayKey(this.env.now());
    const yesterday = dayKey(this.env.now() - 86400000);
    if (st.lastWakeDay !== today) st.streak = st.lastWakeDay === yesterday ? st.streak + 1 : 1;
    st.lastWakeDay = today;
    st.wakes++;
    st.totalSolveS += sess.solveElapsed;
    st.fastestS = st.fastestS ? Math.min(st.fastestS, sess.solveElapsed) : sess.solveElapsed;
    st.history = [{ day: today, solveS: sess.solveElapsed, misses: sess.misses, relapse: !!sess.relapse }, ...(st.history || [])].slice(0, 14);
    this.saveStats();
    this.outcome = { kind: 'morning', solveS: sess.solveElapsed, misses: sess.misses, streak: st.streak, relapse: !!sess.relapse };
    this.log(`Good morning logged. Streak ${st.streak}.`);
  }

  neededPuzzles() {
    return this.settings.rounds + (this.s?.penalty ? RULES.penaltyExtraPuzzles : 0);
  }

  // ---------------------------------------------------------------- pairing
  async startPairing() {
    this.pairing = true;
    this.pairMsg = '';
    this.update(true);
    if (!this.link.connected) await this.connect();
    else if (this.s?.pairOpen) this.completePairing();
  }

  async connect() {
    this.connecting = true;
    this.update(true);
    try {
      if (this.link.canReconnect?.()) await this.link.reconnect();
      else await this.link.scanAndConnect();
    } catch (e) {
      if (e?.name !== 'NotFoundError' && !/cancel/i.test(String(e?.message))) this.toast(friendlyError(e));
    } finally {
      this.connecting = false;
      this.update(true);
    }
  }

  async completePairing() {
    if (this.pairBusy) return;
    this.pairBusy = true;
    this.pairMsg = '';
    this.update(true);
    try {
      const k = String(await this.link.readKey() || '').trim().toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(k)) throw new Error('The crow did not hand over a key. Hold the perch for 3 seconds and try again.');
      const before = await this.link.readState();
      await this.send(cmd.paired(await proof(k, 'paired:', before.nonce)));
      const after = await this.link.readState();
      if (!after.hasKey || !after.authed) throw new Error('The crow refused. Hold the perch again and stay close.');
      this.key = k;
      this.store.set('key', k);
      this.deviceName = this.link.deviceName || this.deviceName;
      this.store.set('device', this.deviceName);
      this.pairing = false;
      this.keyRejected = false;
      this.authNonce = after.nonce;
      this.syncedNonce = null;
      const betrayed = after.betrayals > before.betrayals;
      this.log(`Paired with ${this.deviceName}. Key saved in this app's storage.`);
      this.env.afterPair?.();
      this.repairedMidRing = after.state === 'RING';
      if (after.state === 'RING') this.toast(`Paired. Penalty round: +${RULES.penaltyExtraPuzzles} puzzles.`, 4000);
      else this.outcome = { kind: 'paired', betrayed, betrayals: after.betrayals };
      this.s = after;
      await this.ensureAuth(after);
    } catch (e) {
      this.pairMsg = e.message || String(e);
    } finally {
      this.pairBusy = false;
      this.update(true);
    }
  }

  forget() {
    this.key = null;
    this.store.remove('key');
    this.store.remove('device');
    this.keyRejected = false;
    this.confirmForget = false;
    this.view = 'home';
    this.log('Key deleted from this phone. The clock keeps its alarms.');
    this.link.disconnect?.();
    this.update(true);
  }

  // ---------------------------------------------------------------- the morning
  beginPuzzle() {
    const sess = this.session;
    if (!sess) return;
    sess.inPuzzle = true;
    sess.puzzleId = pickPuzzle(this.settings.puzzles, sess.lastPuzzle);
    sess.lastPuzzle = sess.puzzleId;
    this.update(true);
  }

  puzzleSolved() {
    const sess = this.session;
    if (!sess || sess.submitting || !sess.inPuzzle) return;
    sess.solved++;
    this.log(`Puzzle solved (${PUZZLES[sess.puzzleId].name}). ${sess.solved} of ${this.neededPuzzles()}.`);
    if (sess.solved >= this.neededPuzzles()) { sess.inPuzzle = false; this.submitSolve(); }
    else { sess.puzzleId = pickPuzzle(this.settings.puzzles, sess.lastPuzzle); sess.lastPuzzle = sess.puzzleId; }
    this.update(true);
  }

  puzzleMissed() {
    if (this.session) this.session.misses++;
    this.stats.misses++;
    this.saveStats();
    this.env.vibrate?.(120);
    const now = this.env.now();
    if (now - this.lastMissSent > RULES.missBumpCooldownS * 1000 && this.s?.state === 'RING') {
      this.lastMissSent = now;
      this.send(cmd.miss()).catch(() => {});
    }
  }

  async submitSolve() {
    const sess = this.session, s = this.s;
    if (!sess || !s || s.state !== 'RING' || sess.submitting) return;
    sess.submitting = true;
    sess.solveElapsed = s.elapsed;
    this.update(true);
    try {
      this.log('All puzzles solved. Sending the proof for this challenge.');
      await this.send(cmd.solve(await proof(this.key, 'solve:', s.challenge)));
      const after = await this.link.readState();
      if (after.state === 'RING' && after.challenge === s.challenge) {
        sess.submitting = false;
        this.toast('The crow refused the key. It may have been re-paired with another phone.', 4000);
      }
    } catch (e) {
      sess.submitting = false;
      this.toast(friendlyError(e));
    }
    this.update(true);
  }

  async checkTap(btn) {
    this.checkTaps = (this.checkTaps || 0) + 1;
    const area = btn.parentElement;
    const dots = this.stage.querySelector('.ca-taps');
    if (dots) dots.innerHTML = [0, 1, 2].map(i => `<i class="${i < this.checkTaps ? 'on' : ''}"></i>`).join('');
    if (this.checkTaps >= 3) {
      btn.disabled = true;
      try { await this.send(cmd.awake(await proof(this.key, 'awake:', this.s.challenge))); }
      catch (e) { this.toast(friendlyError(e)); btn.disabled = false; this.checkTaps = 2; }
      return;
    }
    const w = area.clientWidth - btn.offsetWidth, h = area.clientHeight - btn.offsetHeight;
    btn.style.left = `${Math.round(Math.random() * Math.max(0, w))}px`;
    btn.style.top = `${Math.round(Math.random() * Math.max(0, h))}px`;
  }

  // ---------------------------------------------------------------- alarms
  isWeasel(newAlarms) {
    const hrs = this.settings.noWeaselH;
    if (!hrs) return false;
    const now = this.env.now();
    const before = nextAlarmFrom(this.alarms, now);
    if (!before || before - now > hrs * 3600000) return false;
    const after = nextAlarmFrom(newAlarms, now);
    return !after || after > before;
  }

  withGate(newAlarms, why, action) {
    if (!this.isWeasel(newAlarms)) return action();
    const until = nextAlarmFrom(this.alarms, this.env.now()) - this.env.now();
    this.overlay = {
      kind: 'gate', seq: ++this.renderSeq, puzzleId: pickPuzzle(this.settings.puzzles, null),
      title: 'Prove it',
      reason: `Your next alarm rings ${fmtUntil(until)}. ${why} inside the ${this.settings.noWeaselH}-hour no-weasel window costs one Spicy puzzle.`,
      onDone: action,
    };
    this.update(true);
  }

  async writeAlarm(i, a) {
    try {
      await this.send(cmd.alarm(i, a));
      await this.refreshAlarms();
      this.log(a ? `Alarm ${fmtClock(a.h, a.m).time} ${fmtClock(a.h, a.m).ampm} (${daysLabel(a.mask)}) ${a.on ? 'on' : 'off'}, saved on the clock.` : 'Alarm deleted from the clock.');
      return true;
    } catch (e) { this.toast(friendlyError(e)); return false; }
  }

  saveEdit() {
    const ed = this.editing;
    if (!ed) return;
    const t = this.stage.querySelector('#ca-time')?.value || `${pad2(ed.h)}:${pad2(ed.m)}`;
    const [h, m] = t.split(':').map(Number);
    if (!ed.mask) { this.toast('Pick at least one day.'); return; }
    const a = { h, m, mask: ed.mask, on: true };
    const next = this.alarms.slice(); next[ed.i] = a;
    this.withGate(next, 'Moving an alarm later', async () => {
      if (await this.writeAlarm(ed.i, a)) { this.toast('Saved to the clock'); this.editing = null; this.view = 'home'; this.update(true); }
    });
  }

  toggleAlarm(i, on) {
    const a = this.alarms[i];
    if (!a) return;
    const na = { ...a, on };
    const next = this.alarms.slice(); next[i] = na;
    if (!on) {
      this.withGate(next, 'Turning an alarm off', () => this.writeAlarm(i, na).then(() => this.update(true)));
      this.update(true);
    } else {
      this.writeAlarm(i, na).then(() => this.update(true));
    }
  }

  deleteAlarm(i) {
    const next = this.alarms.slice(); next[i] = null;
    this.withGate(next, 'Deleting an alarm', async () => {
      if (await this.writeAlarm(i, null)) { this.editing = null; this.view = 'home'; this.update(true); }
    });
  }

  // ---------------------------------------------------------------- screen choice
  pickScreen() {
    if (this.overlay) return `${this.overlay.kind}:${this.overlay.seq}`;
    const s = this.link.connected ? this.s : null;
    if (!this.key) {
      if (!this.pairing) return `welcome:${s && (s.state === 'RING' || s.state === 'CHECK') ? 'ring' : ''}`;
      return `pair:${!this.link.connected ? 'connect' : this.pairBusy ? 'busy' : 'hold'}:${this.pairMsg}`;
    }
    if (this.keyRejected) return 'rejected';
    if (s) {
      const sess = this.session;
      if (s.state === 'RING') {
        if (sess?.inPuzzle && !sess.submitting) return `puzzle:${sess.ringChallenge}:${sess.solved}`;
        return `ring:${sess?.ringChallenge}:${sess?.solved}:${sess?.submitting}:${s.penalty}`;
      }
      if (s.state === 'GRACE') return 'silenced';
      if (s.state === 'CHECK') return `check:${s.challenge}`;
      if (s.state === 'SOS') return `sos:${s.sosRound}`;
    }
    if (this.outcome) return `outcome:${this.outcome.kind}`;
    if (this.view === 'home') {
      return `home:${this.link.connected}:${this.connecting}:${JSON.stringify(this.alarms)}:${!!s}`;
    }
    return `${this.view}:${this.connecting}`;
  }

  update(force = false) {
    if (this.destroyed) return;
    const key = this.pickScreen();
    if (force || key !== this.screenKey) this.render(key);
    else this.live();
  }

  render(key) {
    this.cleanupPuzzle?.();
    this.cleanupPuzzle = null;
    this.screenKey = key;
    const name = key.split(':')[0];
    const fn = this[`v_${name}`];
    this.stage.innerHTML = fn ? fn.call(this) : '';
    this.stage.dataset.screen = name;
    this.afterRender(name);
    this.live();
  }

  afterRender(name) {
    const host = this.stage.querySelector('.ca-pz-host');
    if (!host) return;
    const blip = this.env.blip;
    // A puzzle counts once: after it is solved, further taps (double taps, fast fingers) do nothing.
    let solved = false;
    const once = (fn) => () => { if (solved) return; solved = true; host.inert = true; setTimeout(fn, 350); };
    const miss = (fn) => () => { if (!solved) fn(); };
    if (name === 'puzzle') {
      const sess = this.session;
      this.cleanupPuzzle = PUZZLES[sess.puzzleId].mount(host, {
        difficulty: this.settings.difficulty, blip,
        onSolve: once(() => this.puzzleSolved()),
        onMiss: miss(() => this.puzzleMissed()),
      });
    } else if (name === 'practice') {
      const o = this.overlay;
      this.cleanupPuzzle = PUZZLES[o.puzzleId].mount(host, {
        difficulty: this.settings.difficulty, blip,
        onSolve: once(() => { o.solved = true; this.update(true); }),
        onMiss: () => {},
      });
    } else if (name === 'gate') {
      const o = this.overlay;
      this.cleanupPuzzle = PUZZLES[o.puzzleId].mount(host, {
        difficulty: 'spicy', blip,
        onSolve: once(() => { this.overlay = null; o.onDone(); this.update(true); }),
        onMiss: () => {},
      });
    }
  }

  // live bits that change every second without redrawing the screen
  live() {
    const s = this.s, $ = (sel) => this.stage.querySelector(sel);
    const set = (sel, text) => { const el = $(sel); if (el && el.textContent !== text) el.textContent = text; };
    if (!s) return;
    set('[data-live="remaining"]', fmtDur(s.remaining));
    set('[data-live="elapsed"]', `Ringing for ${fmtDur(s.elapsed)}`);
    set('[data-live="level"]', `Level ${s.level + 1} of 4`);
    const meter = $('.ca-meter');
    if (meter) [...meter.children].forEach((b, i) => b.classList.toggle('on', i <= s.level));
    const ring = $('.ca-ring');
    if (ring) ring.dataset.level = s.level;
    set('[data-live="battery"]', `${s.battery}%${s.usb ? ' · charging' : ' · on battery'}`);
    if (this.view === 'home' && $('[data-live="next"]')) {
      const next = nextAlarmFrom(this.alarms, this.env.now());
      set('[data-live="next"]', next ? `${dayWord(next, this.env.now())} · ${fmtUntil(next - this.env.now())}` : 'No alarms on');
    }
    set('[data-live="pair-hint"]', s.pairOpen ? 'The crow is looking around. Pairing…' : 'Waiting for the perch hold…');
  }

  // ---------------------------------------------------------------- views
  top(title, back = 'home', right = '') {
    return `<header class="ca-top"><button type="button" class="ca-back" data-act="nav" data-to="${back}" aria-label="Back">‹</button><h1>${title}</h1><div class="ca-top-right">${right}</div></header>`;
  }

  v_welcome() {
    const ringing = this.screenKey.endsWith(':ring');
    return `<div class="ca-screen ca-welcome ${ringing ? 'is-ringing' : ''}">
      <div class="ca-hero-crow">${crowSVG(ringing ? 'angry' : 'open', 132)}</div>
      <h1 class="ca-wordmark">Crow</h1>
      <p class="ca-lede">The alarm clock you can't snooze, unplug, or uninstall your way out of.</p>
      ${ringing ? `<div class="ca-alert">Your crow is ringing and doesn't know this phone. Pair it to get your puzzles. Re-pairing mid-ring costs +${RULES.penaltyExtraPuzzles} puzzles.</div>` : ''}
      <button type="button" class="ca-btn primary" data-act="start-pair">Pair my Crow</button>
      <p class="ca-fine">No account, no cloud. The key lives on this phone and on the clock, nowhere else.</p>
    </div>`;
  }

  v_pair() {
    const step = this.screenKey.split(':')[1];
    const n = step === 'connect' ? 1 : 2;
    const li = (i, title, body) => `<li class="${i < n ? 'done' : i === n ? 'now' : ''}"><b>${title}</b><span>${body}</span></li>`;
    return `<div class="ca-screen ca-pair">
      ${this.top('Pair your Crow', 'welcome')}
      <ol class="ca-steps">
        ${li(1, 'Connect', 'Phone and clock within a few meters, Bluetooth on.')}
        ${li(2, 'Hold the perch 3 seconds', 'The button on top. Let go when the crow starts looking around.')}
        ${li(3, 'Done', 'The crow hands this phone a fresh key.')}
      </ol>
      ${step === 'connect'
        ? `<button type="button" class="ca-btn primary" data-act="connect" ${this.connecting ? 'disabled' : ''}>${this.connecting ? 'Looking…' : 'Find my Crow'}</button>`
        : `<div class="ca-wait">${crowSVG('wide', 64)}<p data-live="pair-hint">${step === 'busy' ? 'Pairing…' : 'Waiting for the perch hold…'}</p></div>`}
      ${this.pairMsg ? `<p class="ca-error">${esc(this.pairMsg)}</p>` : ''}
      <p class="ca-fine">Pairing a new phone kills the old key. The crow notices, and keeps count.</p>
    </div>`;
  }

  v_rejected() {
    return `<div class="ca-screen ca-welcome">
      <div class="ca-hero-crow">${crowSVG('squint', 112)}</div>
      <h1>Who are you?</h1>
      <p class="ca-lede">This crow doesn't recognize this phone's key. It was re-paired with another phone or factory reset.</p>
      <button type="button" class="ca-btn primary" data-act="repair">Pair again</button>
    </div>`;
  }

  v_home() {
    const s = this.link.connected ? this.s : null;
    const now = this.env.now();
    const next = nextAlarmFrom(this.alarms, now);
    const nc = next ? fmtClock(new Date(next).getHours(), new Date(next).getMinutes()) : null;
    const rows = this.alarms.map((a, i) => {
      if (!a) return '';
      const c = fmtClock(a.h, a.m);
      return `<div class="ca-alarm ${a.on ? '' : 'off'}">
        <button type="button" class="ca-alarm-main" data-act="edit" data-i="${i}"><span class="t">${c.time}<small>${c.ampm}</small></span><span class="d">${daysLabel(a.mask)}</span></button>
        <label class="ca-switch"><input type="checkbox" data-act="toggle" data-i="${i}" ${a.on ? 'checked' : ''} aria-label="Alarm ${c.time} ${c.ampm} on"><span></span></label>
      </div>`;
    }).join('');
    const count = this.alarms.filter(Boolean).length;
    const conn = this.link.connected
      ? (s?.authed ? '<span class="ca-conn ok">Connected</span>' : '<span class="ca-conn">Checking key…</span>')
      : '<span class="ca-conn bad">Not connected</span>';
    const avg = this.stats.wakes ? Math.round(this.stats.totalSolveS / this.stats.wakes) : 0;
    return `<div class="ca-screen ca-home">
      <header class="ca-bar">
        <div class="ca-dev">${crowSVG('open', 34)}<div><b>${esc(this.deviceName || 'Your Crow')}</b>${conn}</div></div>
        <div class="ca-batt" data-live="battery">${s ? `${s.battery}%` : ''}</div>
      </header>
      ${!this.link.connected ? `<div class="ca-banner"><span>${this.env.kind === 'real' ? 'Open the app near the clock to manage alarms.' : 'The clock is out of reach.'}</span><button type="button" data-act="connect" ${this.connecting ? 'disabled' : ''}>${this.connecting ? '…' : 'Connect'}</button></div>` : ''}
      <section class="ca-next">
        <span class="ca-label">Next caw</span>
        <div class="ca-next-time">${nc ? `${nc.time}<small>${nc.ampm}</small>` : '—'}</div>
        <div class="ca-next-sub" data-live="next">${next ? `${dayWord(next, now)} · ${fmtUntil(next - now)}` : 'No alarms on'}</div>
      </section>
      <section class="ca-list">
        <div class="ca-list-head"><h2>Alarms</h2><button type="button" data-act="add-alarm" ${count >= RULES.maxAlarms || !this.link.connected ? 'disabled' : ''}>+ Add</button></div>
        ${rows || '<p class="ca-empty">No alarms yet. The crow is bored.</p>'}
        <p class="ca-fine">Alarms are stored on the clock. Deleting this app doesn't delete them.</p>
      </section>
      <nav class="ca-tiles">
        <button type="button" data-act="nav" data-to="puzzles"><b>Puzzles</b><span>${this.settings.rounds} per alarm · ${DIFFICULTIES.find(d => d.id === this.settings.difficulty).name}</span></button>
        <button type="button" data-act="nav" data-to="stats"><b>Stats</b><span>${this.stats.streak ? `${this.stats.streak}-day streak` : 'No streak yet'}${avg ? ` · ${fmtDur(avg)} avg` : ''}</span></button>
        <button type="button" data-act="nav" data-to="settings"><b>Settings</b><span>Wake check ${s?.wakeCheck === false ? 'off' : 'on'}</span></button>
        <button type="button" data-act="test" ${!s?.authed ? 'disabled' : ''}><b>Test caw</b><span>A short one</span></button>
      </nav>
    </div>`;
  }

  v_edit() {
    const ed = this.editing;
    return `<div class="ca-screen ca-edit">
      <header class="ca-top"><button type="button" class="ca-text" data-act="nav" data-to="home">Cancel</button><h1>${ed.isNew ? 'New alarm' : 'Edit alarm'}</h1><button type="button" class="ca-text strong" data-act="save-alarm">Save</button></header>
      <label class="ca-label" for="ca-time">Time</label>
      <input type="time" id="ca-time" class="ca-timeinput" value="${pad2(ed.h)}:${pad2(ed.m)}" required>
      <span class="ca-label">Days</span>
      <div class="ca-days">${DAY_LETTERS.map((d, i) => `<button type="button" data-act="day" data-d="${i}" class="${ed.mask & (1 << i) ? 'on' : ''}" aria-pressed="${!!(ed.mask & (1 << i))}" aria-label="${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]}">${d}</button>`).join('')}</div>
      <div class="ca-presets">
        <button type="button" data-act="days" data-mask="127">Every day</button>
        <button type="button" data-act="days" data-mask="62">Weekdays</button>
        <button type="button" data-act="days" data-mask="65">Weekends</button>
      </div>
      <p class="ca-fine">The crow keeps this alarm even if this app is deleted. There is no snooze.</p>
      ${!ed.isNew ? '<button type="button" class="ca-btn danger" data-act="delete-alarm">Delete alarm</button>' : ''}
    </div>`;
  }

  v_puzzles() {
    const st = this.settings;
    return `<div class="ca-screen ca-puzzles">
      ${this.top('Puzzles')}
      <span class="ca-label">Difficulty</span>
      <div class="ca-seg" role="group" aria-label="Difficulty">${DIFFICULTIES.map(d => `<button type="button" data-act="diff" data-v="${d.id}" class="${st.difficulty === d.id ? 'on' : ''}" aria-pressed="${st.difficulty === d.id}">${d.name}</button>`).join('')}</div>
      <div class="ca-stepper">
        <div><b>Puzzles per alarm</b><span>Penalty rounds add +${RULES.penaltyExtraPuzzles}.</span></div>
        <div class="ca-step-ctl"><button type="button" data-act="rounds" data-d="-1" aria-label="Fewer" ${st.rounds <= 1 ? 'disabled' : ''}>−</button><output>${st.rounds}</output><button type="button" data-act="rounds" data-d="1" aria-label="More" ${st.rounds >= 4 ? 'disabled' : ''}>+</button></div>
      </div>
      <div class="ca-pz-list">
        ${PUZZLE_ORDER.map(id => {
          const p = PUZZLES[id];
          return `<div class="ca-pz-row">
            <span class="ca-pz-ico">${p.icon}</span>
            <div class="ca-pz-txt"><b>${p.name}</b><span>${p.blurb}${p.note ? ` ${p.note}` : ''}</span></div>
            <button type="button" class="ca-try" data-act="try" data-id="${id}">Try</button>
            <label class="ca-switch"><input type="checkbox" data-act="pz-toggle" data-id="${id}" ${st.puzzles[id] ? 'checked' : ''} aria-label="Use ${p.name}"><span></span></label>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  v_settings() {
    const s = this.link.connected ? this.s : null;
    const dis = !s?.authed ? 'disabled' : '';
    return `<div class="ca-screen ca-settings">
      ${this.top('Settings')}
      <div class="ca-set">
        <div><b>Wake check</b><span>${RULES.graceS / 60} min after you silence it, the crow chirps. Prove you're up within ${RULES.checkS / 60} min or it starts over.</span></div>
        <label class="ca-switch"><input type="checkbox" data-act="wake" ${s?.wakeCheck !== false ? 'checked' : ''} ${dis} aria-label="Wake check"><span></span></label>
      </div>
      <div class="ca-set">
        <div><b>Mercy limit</b><span>After this much screaming the crow gives up and logs a shame. It can't be turned off.</span></div>
        <select id="ca-mercy" data-act="mercy" ${dis}>${RULES.mercyOptions.map(m => `<option value="${m}" ${(s?.mercy || RULES.defaultMercyMin) === m ? 'selected' : ''}>${m} min</option>`).join('')}</select>
      </div>
      <div class="ca-set">
        <div><b>No-weasel window</b><span>This close to an alarm, turning it off or moving it later costs a Spicy puzzle.</span></div>
        <select id="ca-weasel" data-act="weasel">${NO_WEASEL_OPTIONS.map(h => `<option value="${h}" ${this.settings.noWeaselH === h ? 'selected' : ''}>${h ? `${h} hours` : 'Off'}</option>`).join('')}</select>
      </div>
      <div class="ca-set col">
        <div><b>${esc(this.deviceName || 'Your Crow')}</b><span>Firmware ${esc(s?.fw || '?')} · app ${APP_VERSION}${this.env.kind === 'sim' ? ' · simulator' : ''}</span></div>
        <button type="button" class="ca-btn danger" data-act="forget">${this.confirmForget ? 'Tap again to delete the key' : 'Forget this Crow'}</button>
        <p class="ca-fine">Forgetting deletes the key from this phone, same as deleting the app. The clock keeps its alarms and keeps ringing.</p>
      </div>
    </div>`;
  }

  v_stats() {
    const st = this.stats, s = this.s;
    const avg = st.wakes ? Math.round(st.totalSolveS / st.wakes) : 0;
    const tile = (n, l) => `<div class="ca-stat"><b>${n}</b><span>${l}</span></div>`;
    return `<div class="ca-screen ca-stats">
      ${this.top('Stats')}
      <div class="ca-streak">${crowSVG(st.streak >= 3 ? 'happy' : 'open', 64)}<div><b>${st.streak}</b><span>day streak</span></div></div>
      <div class="ca-stat-grid">
        ${tile(st.wakes, 'mornings won')}
        ${tile(avg ? fmtDur(avg) : '—', 'avg ring time')}
        ${tile(st.fastestS ? fmtDur(st.fastestS) : '—', 'fastest')}
        ${tile(st.misses, 'wrong answers')}
      </div>
      <span class="ca-label">The crow remembers</span>
      <p class="ca-fine">Saved on the clock, so they survive deleting the app.</p>
      <div class="ca-stat-grid three">
        ${tile(s ? s.betrayals : '—', 'betrayals')}
        ${tile(s ? s.shame : '—', 'shames')}
        ${tile(s ? s.sosEscapes : '—', 'SOS escapes')}
      </div>
      ${st.history?.length ? `<span class="ca-label">Recent mornings</span><ul class="ca-history">${st.history.slice(0, 7).map(h => `<li><span>${h.day.slice(5).replace('-', '/')}</span><span>${fmtDur(h.solveS)}</span><span>${h.misses} miss${h.misses === 1 ? '' : 'es'}${h.relapse ? ' · relapse' : ''}</span></li>`).join('')}</ul>` : ''}
    </div>`;
  }

  v_ring() {
    const s = this.s, sess = this.session || { solved: 0 };
    const need = this.neededPuzzles();
    return `<div class="ca-screen ca-ring" data-level="${s.level}">
      <div class="ca-ring-crow">${crowSVG('angry', 128)}</div>
      <h1 class="ca-caw">CAW!</h1>
      <div class="ca-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <p class="ca-ring-meta"><span data-live="level">Level ${s.level + 1} of 4</span> · <span data-live="elapsed">Ringing for ${fmtDur(s.elapsed)}</span></p>
      ${s.penalty ? `<div class="ca-penalty">Penalty round: +${RULES.penaltyExtraPuzzles} puzzles. ${this.repairedMidRing ? 'You re-paired in the middle of an alarm.' : 'The app had not checked in for over a day.'}</div>` : (sess.relapse ? '<div class="ca-penalty">You missed the wake check. Start over.</div>' : '')}
      <div class="ca-dots" aria-label="${sess.solved} of ${need} puzzles solved">${Array.from({ length: need }, (_, i) => `<i class="${i < sess.solved ? 'on' : ''}"></i>`).join('')}</div>
      ${sess.submitting
        ? '<button type="button" class="ca-btn primary big" disabled>Handing over the key…</button>'
        : `<button type="button" class="ca-btn primary big" data-act="begin">${sess.solved ? 'Next puzzle' : 'Solve to silence'}</button>`}
      <p class="ca-fine">No snooze. Wrong answers make it louder.</p>
    </div>`;
  }

  v_puzzle() {
    const sess = this.session, need = this.neededPuzzles();
    const p = PUZZLES[sess.puzzleId];
    return `<div class="ca-screen ca-puzzle">
      <header class="ca-pz-head">
        <div><span class="ca-label">Puzzle ${sess.solved + 1} of ${need}</span><b>${p.name}</b></div>
        <div class="ca-meter small" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      </header>
      <div class="ca-pz-host"></div>
    </div>`;
  }

  v_silenced() {
    const sess = this.session || { solveElapsed: 0, misses: 0 };
    return `<div class="ca-screen ca-silenced">
      <div class="ca-hero-crow">${crowSVG('squint', 116)}</div>
      <h1>Silenced.</h1>
      <p class="ca-lede">Done in ${fmtDur(sess.solveElapsed)} with ${sess.misses} wrong answer${sess.misses === 1 ? '' : 's'}.</p>
      <div class="ca-countdown"><span class="ca-label">Wake check in</span><b data-live="remaining">${fmtDur(this.s.remaining)}</b></div>
      <p class="ca-fine">The crow is watching. When it chirps, open the app and prove you're up. Back to bed and it starts over.</p>
    </div>`;
  }

  v_check() {
    const taps = this.checkTaps || 0;
    return `<div class="ca-screen ca-check">
      <h1>Still up?</h1>
      <p class="ca-lede">Tap the crow three times.</p>
      <div class="ca-countdown"><span class="ca-label">Time left</span><b data-live="remaining">${fmtDur(this.s.remaining)}</b></div>
      <div class="ca-target-area"><button type="button" class="ca-target" data-act="tap-target" aria-label="Tap the crow">${crowSVG('wide', 60)}</button></div>
      <div class="ca-taps">${[0, 1, 2].map(i => `<i class="${i < taps ? 'on' : ''}"></i>`).join('')}</div>
    </div>`;
  }

  v_sos() {
    return `<div class="ca-screen ca-sos">
      <div class="ca-hero-crow">${crowSVG('wide', 96)}</div>
      <h1>SOS count-off</h1>
      <p class="ca-lede">Round ${this.s.sosRound + 1} of ${RULES.sosRounds}, on the clock itself. Count its beeps, then press the perch that many times.</p>
      <p class="ca-fine">A wrong count sends it back to full volume with fresh puzzles.</p>
    </div>`;
  }

  v_outcome() {
    const o = this.outcome;
    let art = 'happy', title = '', body = '', extra = '';
    if (o.kind === 'morning') {
      title = 'Good morning.';
      body = `Silenced in ${fmtDur(o.solveS)} with ${o.misses} wrong answer${o.misses === 1 ? '' : 's'}.${o.relapse ? ' It took a relapse, but you made it.' : ''}`;
      extra = `<div class="ca-streak">${crowSVG('happy', 52)}<div><b>${o.streak}</b><span>day streak</span></div></div>`;
    } else if (o.kind === 'shame') {
      art = 'sad'; title = 'The crow gave up.';
      body = `You slept through ${o.mercy} minutes of cawing. Shame #${o.shame} is saved on the clock for good. Streak reset.`;
    } else if (o.kind === 'escaped') {
      art = 'squint'; title = 'You escaped.';
      body = `SOS count-off passed. The crow logged it: ${o.count} escape${o.count === 1 ? '' : 's'} so far. It will remember.`;
    } else if (o.kind === 'paired') {
      art = o.betrayed ? 'squint' : 'happy';
      title = o.betrayed ? 'Paired. Noted.' : 'Paired.';
      body = o.betrayed
        ? `This is a new key, so the old one is dead. Betrayal #${o.betrayals} is on the clock's permanent record.`
        : 'The crow trusts this phone now. Set your first alarm. There is no snooze.';
    }
    return `<div class="ca-screen ca-outcome ${o.kind}">
      <div class="ca-hero-crow">${crowSVG(art, 120)}</div>
      <h1>${title}</h1>
      <p class="ca-lede">${body}</p>
      ${extra}
      ${o.kind === 'paired' && !o.betrayed && !this.alarms.some(Boolean) ? '<button type="button" class="ca-btn primary" data-act="first-alarm">Set an alarm</button>' : ''}
      <button type="button" class="ca-btn ${o.kind === 'paired' && !o.betrayed && !this.alarms.some(Boolean) ? '' : 'primary'}" data-act="done">Done</button>
    </div>`;
  }

  v_practice() {
    const o = this.overlay, p = PUZZLES[o.puzzleId];
    return `<div class="ca-screen ca-puzzle">
      <header class="ca-top"><button type="button" class="ca-text" data-act="close-overlay">Close</button><h1>${p.name}</h1><div class="ca-top-right"><span class="ca-tag">Practice</span></div></header>
      ${o.solved
        ? `<div class="ca-practice-done">${crowSVG('happy', 96)}<p class="ca-lede">Solved. On a real morning that's one down.</p><button type="button" class="ca-btn primary" data-act="practice-again">Another one</button></div>`
        : '<div class="ca-pz-host"></div>'}
    </div>`;
  }

  v_gate() {
    const o = this.overlay;
    return `<div class="ca-screen ca-puzzle">
      <header class="ca-top"><button type="button" class="ca-text" data-act="close-overlay">Cancel</button><h1>${o.title}</h1><div class="ca-top-right"></div></header>
      <p class="ca-fine gate">${esc(o.reason)}</p>
      <div class="ca-pz-host"></div>
    </div>`;
  }

  // ---------------------------------------------------------------- input
  onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b || b.tagName === 'INPUT' || b.tagName === 'SELECT' || b.disabled) return;
    const act = b.dataset.act;
    const i = Number(b.dataset.i);
    switch (act) {
      case 'nav':
        if (b.dataset.to === 'welcome') { this.pairing = false; this.pairMsg = ''; }
        this.view = b.dataset.to === 'welcome' ? 'home' : b.dataset.to;
        this.confirmForget = false;
        this.editing = null;
        this.update(true);
        break;
      case 'start-pair': this.startPairing(); break;
      case 'repair': this.key = null; this.store.remove('key'); this.keyRejected = false; this.startPairing(); break;
      case 'connect': this.connect(); break;
      case 'add-alarm': {
        const slot = this.alarms.findIndex(a => !a);
        if (slot < 0) return;
        this.editing = { i: slot, h: 7, m: 0, mask: 62, isNew: true };
        this.view = 'edit'; this.update(true);
        break;
      }
      case 'first-alarm':
        this.outcome = null;
        this.editing = { i: 0, h: 7, m: 0, mask: 127, isNew: true };
        this.view = 'edit'; this.update(true);
        break;
      case 'edit': {
        const a = this.alarms[i];
        this.editing = { i, h: a.h, m: a.m, mask: a.mask, isNew: false };
        this.view = 'edit'; this.update(true);
        break;
      }
      case 'day': {
        const t = this.stage.querySelector('#ca-time');
        if (t?.value) { const [h, m] = t.value.split(':').map(Number); this.editing.h = h; this.editing.m = m; }
        this.editing.mask ^= 1 << Number(b.dataset.d);
        this.update(true);
        break;
      }
      case 'days': {
        const t = this.stage.querySelector('#ca-time');
        if (t?.value) { const [h, m] = t.value.split(':').map(Number); this.editing.h = h; this.editing.m = m; }
        this.editing.mask = Number(b.dataset.mask);
        this.update(true);
        break;
      }
      case 'save-alarm': this.saveEdit(); break;
      case 'delete-alarm': this.deleteAlarm(this.editing.i); break;
      case 'test': this.send(cmd.test()).then(() => this.toast('Caw.')).catch(e => this.toast(friendlyError(e))); break;
      case 'diff': this.settings.difficulty = b.dataset.v; this.saveSettings(); this.update(true); break;
      case 'rounds': this.settings.rounds = Math.min(4, Math.max(1, this.settings.rounds + Number(b.dataset.d))); this.saveSettings(); this.update(true); break;
      case 'try': this.overlay = { kind: 'practice', seq: ++this.renderSeq, puzzleId: b.dataset.id, solved: false }; this.update(true); break;
      case 'practice-again': this.overlay.solved = false; this.overlay.seq = ++this.renderSeq; this.update(true); break;
      case 'close-overlay': this.overlay = null; this.update(true); break;
      case 'forget':
        if (this.confirmForget) this.forget();
        else { this.confirmForget = true; this.update(true); }
        break;
      case 'begin': this.beginPuzzle(); break;
      case 'tap-target': this.checkTap(b); break;
      case 'done': this.outcome = null; this.view = 'home'; this.update(true); break;
    }
  }

  onChange(e) {
    const el = e.target;
    const act = el.dataset.act;
    if (!act) return;
    if (act === 'toggle') this.toggleAlarm(Number(el.dataset.i), el.checked);
    else if (act === 'pz-toggle') {
      const on = el.checked;
      const others = PUZZLE_ORDER.filter(id => id !== el.dataset.id && this.settings.puzzles[id]);
      if (!on && !others.length) { el.checked = true; this.toast('Keep at least one puzzle on.'); return; }
      this.settings.puzzles[el.dataset.id] = on; this.saveSettings();
    } else if (act === 'wake' || act === 'mercy') {
      const wake = act === 'wake' ? el.checked : this.s.wakeCheck;
      const mercy = act === 'mercy' ? Number(el.value) : this.s.mercy;
      this.send(cmd.config(wake, mercy)).then(() => this.toast('Saved to the clock')).catch(err => this.toast(friendlyError(err)));
    } else if (act === 'weasel') {
      this.settings.noWeaselH = Number(el.value); this.saveSettings();
    }
  }
}
