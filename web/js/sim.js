// The simulator page: a virtual Crow clock (sim-clock.js, a port of the firmware) next to a
// virtual phone running the real companion app (app.js) over a fake Bluetooth link.

import { SimClock } from './sim-clock.js';
import { CrowApp } from './app.js';
import { parseState, parseAlarms, fmtClock, pad2, randomHex, nextAlarmFrom, DAY_SHORT, esc } from './proto.js';
import { RULES } from './rules.js';
import { CrowAudio } from './audio.js';
import { drawOled } from './oled.js';
import { crowSVG } from './crow-art.js';

const $ = (id) => document.getElementById(id);
const audio = new CrowAudio();
const world = { sim: 0, speed: 1, paused: true, lastReal: performance.now() };
let clock = null;
let lastState = '';
const DEVICE_NAME = 'Crow-7F3A';

// ------------------------------------------------------------------ log
const logEl = $('log');
const WHO = { crow: 'Crow', app: 'App', link: 'App → Crow', phone: 'Phone', you: 'You', sim: 'Sim' };
function log(who, msg) {
  const d = new Date(world.sim || Date.now());
  const li = document.createElement('li');
  li.className = `lg-${who}`;
  li.innerHTML = `<time>${fmtClock(d.getHours(), d.getMinutes()).time}:${pad2(d.getSeconds())}</time><b>${WHO[who] || who}</b><span>${esc(msg)}</span>`;
  logEl.prepend(li);
  while (logEl.children.length > 80) logEl.lastChild.remove();
}

// ------------------------------------------------------------------ fake Bluetooth link
class SimLink {
  constructor(clk, { remembered = false } = {}) {
    this.clock = clk;
    this.kind = 'sim';
    this.connected = false;
    this.remembered = remembered;
    this.stateCbs = new Set();
    this.connCbs = new Set();
  }
  get deviceName() { return this.clock.name; }
  canReconnect() { return this.remembered; }
  onState(cb) { this.stateCbs.add(cb); return () => this.stateCbs.delete(cb); }
  onConnection(cb) { this.connCbs.add(cb); return () => this.connCbs.delete(cb); }
  wait(ms = 45) { return new Promise(r => setTimeout(r, ms)); }
  async scanAndConnect() {
    const ok = await chooseDevice(this.clock.name);
    if (!ok) { const e = new Error('User cancelled the chooser.'); e.name = 'NotFoundError'; throw e; }
    this.remembered = true;
    await this.wait(350);
    this.open();
  }
  async reconnect() {
    if (!this.remembered) throw new Error('No crow remembered yet.');
    await this.wait(200);
    this.open();
  }
  open() {
    if (this.connected) return;
    this.connected = true;
    this.unsub = this.clock.subscribe(() => this.emitState());
    this.clock.bleConnect();
    log('phone', `Bluetooth connected to ${this.clock.name}.`);
    this.connCbs.forEach(cb => cb(true));
    this.emitState();
  }
  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.unsub?.();
    this.clock.bleDisconnect();
    this.connCbs.forEach(cb => cb(false));
  }
  emitState() {
    if (!this.connected) return;
    const s = parseState(this.clock.stateString());
    this.stateCbs.forEach(cb => cb(s));
  }
  async readState() { await this.wait(20); return parseState(this.clock.stateString()); }
  async readKey() { await this.wait(); return this.clock.keyValue(); }
  async readAlarms() { await this.wait(); return parseAlarms(this.clock.alarmsString()); }
  async send(c) {
    if (!this.connected) throw new Error('Not connected to the crow.');
    await this.wait();
    const pretty = { A: 'AUTH', S: 'SOLVE', W: 'AWAKE', P: 'PAIRED', M: 'MISS', T: 'TIME', L: 'ALARM', C: 'CONFIG', R: 'TEST' }[c[0]] || c[0];
    if (c[0] !== 'T') log('link', `${pretty} ${c.length > 1 ? (/^[0-9a-f]{16}$/.test(c.slice(1)) ? c.slice(1, 9) + '…' : c.slice(1)) : ''}`.trim());
    await this.clock.command(c);
  }
}

// ------------------------------------------------------------------ phone OS
class MemStore {
  constructor() { this.m = new Map(); }
  get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  set(k, v) { this.m.set(k, String(v)); }
  remove(k) { this.m.delete(k); }
  getJSON(k) { try { return JSON.parse(this.get(k)); } catch { return null; } }
  setJSON(k, v) { this.set(k, JSON.stringify(v)); }
  clear() { this.m.clear(); }
}

const phone = { installed: false, installing: false, screen: 'home', store: new MemStore(), app: null, link: null };
const phApp = $('phApp'), phHome = $('phHome'), phStore = $('phStore'), phNotif = $('phNotif'), phSheet = $('phSheet');

const appIcon = (size = 52) => `<span class="ph-appicon crowicon" style="--s:${size}px">${crowSVG('open', size * 0.86)}</span>`;
const DECOYS = [
  ['Clock', '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>', 'clock'],
  ['Notes', '<svg viewBox="0 0 24 24"><path d="M6 4h12v16H6z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 9h6M9 13h6M9 17h3" stroke="currentColor" stroke-width="2"/></svg>', 'notes'],
  ['Photos', '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" fill="currentColor"/><circle cx="12" cy="6" r="3" fill="currentColor" opacity=".5"/><circle cx="12" cy="18" r="3" fill="currentColor" opacity=".5"/><circle cx="6" cy="12" r="3" fill="currentColor" opacity=".5"/><circle cx="18" cy="12" r="3" fill="currentColor" opacity=".5"/></svg>', 'photos'],
  ['Weather', '<svg viewBox="0 0 24 24"><circle cx="9" cy="10" r="4" fill="currentColor"/><path d="M8 18h9a3 3 0 0 0 0-6 5 5 0 0 0-9 1" fill="none" stroke="currentColor" stroke-width="2"/></svg>', 'weather'],
];

function renderHome() {
  const icons = [];
  if (phone.installed) icons.push(`<button type="button" class="ph-icon" id="crowIcon" aria-label="Crow app. Long-press to delete.">${appIcon()}<span>Crow</span></button>`);
  else if (phone.installing) icons.push(`<div class="ph-icon installing">${appIcon()}<span>Installing…</span></div>`);
  for (const [n, svg, cls] of DECOYS) icons.push(`<button type="button" class="ph-icon decoy" data-decoy="${n}"><span class="ph-appicon ${cls}">${svg}</span><span>${n}</span></button>`);
  icons.push(`<button type="button" class="ph-icon" id="storeIcon"><span class="ph-appicon store"><svg viewBox="0 0 24 24"><path d="M5 8h14l-1 12H6z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 8a3 3 0 0 1 6 0" fill="none" stroke="currentColor" stroke-width="2"/></svg></span><span>Store</span></button>`);
  const d = new Date(world.sim);
  phHome.innerHTML = `
    <div class="ph-widget"><span>${DAY_SHORT[d.getDay()]}day</span><b id="phWidgetTime">${fmtClock(d.getHours(), d.getMinutes()).time}</b><span>${phone.installed ? 'Crow is installed' : 'No alarm app installed'}</span></div>
    <div class="ph-grid">${icons.join('')}</div>
    ${!phone.installed && !phone.installing ? '<p class="ph-hint">The Crow app lives in the Store.</p>' : ''}`;
  const icon = $('crowIcon');
  if (icon) bindLongPress(icon, () => openApp(), () => askDelete());
  $('storeIcon')?.addEventListener('click', () => showScreen('store'));
  phHome.querySelectorAll('.decoy').forEach(b => b.addEventListener('click', () => {
    b.classList.remove('wiggle'); void b.offsetWidth; b.classList.add('wiggle');
  }));
}

function renderStore() {
  phStore.innerHTML = `
    <header class="st-top"><button type="button" class="st-back" id="stBack">‹ Back</button></header>
    <div class="st-head">${appIcon(76)}<div><b>Crow</b><span>The unsnoozable alarm clock</span>
      <button type="button" class="st-get" id="stGet" ${phone.installing ? 'disabled' : ''}>${phone.installed ? 'Open' : phone.installing ? '…' : 'Get'}</button></div></div>
    <p class="st-desc">Companion app for the Crow alarm clock. Pair it once and it becomes the only way to silence your clock: solve a couple of quick puzzles every morning and the app hands the clock its key.</p>
    <ul class="st-facts"><li><b>Requires</b><span>A Crow clock</span></li><li><b>Data</b><span>Stays on device</span></li><li><b>Size</b><span>2.1 MB</span></li></ul>
    <p class="st-note">Deleting this app does not stop your Crow. It will keep ringing.</p>`;
  $('stBack').onclick = () => showScreen('home');
  $('stGet').onclick = () => {
    if (phone.installed) { openApp(); return; }
    phone.installing = true; renderStore(); renderHome();
    setTimeout(() => { phone.installing = false; installApp(); log('phone', 'Crow app installed. It has no key yet.'); renderStore(); }, 1200);
  };
}

function showScreen(name) {
  phone.screen = name;
  phHome.hidden = name !== 'home';
  phStore.hidden = name !== 'store';
  phApp.hidden = name !== 'app';
  if (name === 'home') renderHome();
  if (name === 'store') renderStore();
  phone.app?.setVisible(name === 'app');
  if (name === 'app') hideNotif();
}

function installApp() {
  phone.installed = true;
  $('appToggle').checked = true;
  createApp();
  renderHome();
}

function createApp() {
  phone.app?.destroy();
  phone.link = new SimLink(clock, { remembered: !!phone.store.get('device') });
  phone.app = new CrowApp(phApp, {
    link: phone.link,
    storage: phone.store,
    env: {
      kind: 'sim',
      now: () => world.sim,
      notify: (title, body) => showNotif(title, body),
      log: (who, msg) => log(who, msg),
      blip: (i) => audio.blip(i),
      vibrate: () => { const p = $('phone'); p.classList.remove('buzz'); void p.offsetWidth; p.classList.add('buzz'); },
    },
  });
  phone.app.setVisible(phone.screen === 'app');
  phone.app.start();
}

function openApp() {
  if (!phone.installed) return;
  if (!phone.app) createApp();
  showScreen('app');
}

function deleteApp() {
  if (!phone.installed) return;
  phone.app?.destroy();
  phone.link?.disconnect();
  phone.app = null; phone.link = null;
  phone.store.clear();
  phone.installed = false;
  $('appToggle').checked = false;
  hideNotif();
  showScreen('home');
  log('phone', 'Crow app deleted, along with its key. The clock still has its alarms.');
}

function askDelete() {
  phSheet.innerHTML = `
    <div class="sh-card" role="dialog" aria-label="Delete Crow">
      <b>Delete “Crow”?</b>
      <p>Deleting this app also deletes its data, including the key your clock trusts.</p>
      <button type="button" class="sh-danger" id="shDel">Delete App</button>
      <button type="button" id="shCancel">Cancel</button>
    </div>`;
  phSheet.hidden = false;
  $('shDel').onclick = () => { phSheet.hidden = true; deleteApp(); };
  $('shCancel').onclick = () => { phSheet.hidden = true; };
}

let chooserResolve = null;
function chooseDevice(name) {
  return new Promise((resolve) => {
    chooserResolve = resolve;
    phSheet.innerHTML = `
      <div class="sh-card" role="dialog" aria-label="Choose a device">
        <b>“Crow” wants to pair</b>
        <p>Nearby devices</p>
        <button type="button" class="sh-dev" id="shDev"><span class="sh-sig" aria-hidden="true"><i></i><i></i><i></i></span>${esc(name)}</button>
        <button type="button" id="shCancel">Cancel</button>
      </div>`;
    phSheet.hidden = false;
    $('shDev').onclick = () => { phSheet.hidden = true; chooserResolve = null; resolve(true); };
    $('shCancel').onclick = () => { phSheet.hidden = true; chooserResolve = null; resolve(false); };
  });
}

let notifTimer = null;
function showNotif(title, body) {
  if (!phone.installed) return;
  phNotif.innerHTML = `${appIcon(30)}<span class="nt-txt"><b>CROW · now</b><strong>${esc(title)}</strong><span>${esc(body)}</span></span>`;
  phNotif.hidden = false;
  phNotif.classList.remove('in'); void phNotif.offsetWidth; phNotif.classList.add('in');
  clearTimeout(notifTimer);
  notifTimer = setTimeout(hideNotif, 12000);
  log('phone', `Notification: ${title}`);
}
function hideNotif() { phNotif.hidden = true; clearTimeout(notifTimer); }
phNotif.addEventListener('click', () => openApp());
$('phHomebar').addEventListener('click', () => { if (!phSheet.hidden && !chooserResolve) phSheet.hidden = true; showScreen('home'); });

function bindLongPress(el, onTap, onLong) {
  let t = null, longFired = false;
  const start = (e) => {
    longFired = false;
    el.classList.add('pressing');
    t = setTimeout(() => { longFired = true; el.classList.remove('pressing'); onLong(); }, 650);
  };
  const end = () => { clearTimeout(t); el.classList.remove('pressing'); };
  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointerleave', end);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!longFired) { end(); longFired = true; onLong(); } });
  el.addEventListener('click', () => { if (!longFired) onTap(); });
}

// ------------------------------------------------------------------ the clock's buttons
function bindHold(el, which) {
  const down = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    audio.unlock();
    try { el.setPointerCapture?.(e.pointerId); } catch { /* capture is a nicety; the press still counts */ }
    el.classList.add('down');
    clock.press(which, true, performance.now());
  };
  const up = () => {
    if (!el.classList.contains('down')) return;
    el.classList.remove('down');
    clock.press(which, false, performance.now());
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); el.classList.add('down'); clock.press(which, true, performance.now()); } });
  el.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') up(); });
}
bindHold($('perch'), 'perch');
bindHold($('pinhole'), 'pin');

// ------------------------------------------------------------------ scenarios
function at(h, m, s, dayOffset = 0) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, h, m, s).getTime();
}

function makeClock(simMs) {
  const sound = {
    ring: (l) => audio.ring(l), check: () => audio.check(), stop: () => audio.stop(),
    test: () => audio.test(), ok: () => audio.ok(), bad: () => audio.bad(), sos: () => audio.sos(),
  };
  return new SimClock({ name: DEVICE_NAME, simMs, realMs: performance.now(), sound, log });
}

function scenario(name) {
  audio.stop();
  phone.app?.destroy();
  phone.link?.disconnect();
  phone.app = null; phone.link = null;
  phone.store = new MemStore();
  phone.installed = false;
  hideNotif();
  phSheet.hidden = true;
  if (chooserResolve) { chooserResolve(false); chooserResolve = null; }
  logEl.innerHTML = '';
  document.querySelectorAll('#scenarios button').forEach(b => b.classList.toggle('on', b.dataset.sc === name));
  setSpeed(1);
  $('usbToggle').checked = true;

  if (name === 'fresh') {
    world.sim = at(22, 30, 0);
    clock = makeClock(world.sim);
    log('sim', 'Bedtime. A new Crow is out of the box and the phone has no app. Get it from the Store, pair, and set an alarm.');
    showScreen('home');
  } else {
    world.sim = name === 'morning' ? at(6, 59, 40) : at(6, 59, 45);
    clock = makeClock(world.sim);
    const key = randomHex(16);
    clock.key = key;
    clock.state = 'IDLE';
    clock.alarms[0] = { h: 7, m: 0, mask: 127, on: true };
    if (name === 'morning') {
      clock.lastSeen = Math.floor(world.sim / 1000);
      phone.store.set('key', key);
      phone.store.set('device', DEVICE_NAME);
      installApp();
      showScreen('home');
      log('sim', 'Morning. The alarm is set for 7:00 every day and the app is paired. Press start, then try to make it stop.');
    } else {
      clock.lastSeen = Math.floor(world.sim / 1000) - 8 * 3600;
      showScreen('home');
      log('sim', 'You deleted the Crow app last night, hoping to sleep in. The clock kept its 7:00 alarm. Good luck.');
    }
  }
  $('appToggle').checked = phone.installed;
  lastState = '';
  world.lastReal = performance.now();
  $('startOverlay').querySelector('p').textContent = name === 'fresh'
    ? "It's 10:30 pm. Your Crow is unboxed and plugged in. The phone has no app yet."
    : name === 'morning'
      ? "It's 6:59:40. The alarm is set for 7:00 and the app is paired. Sound on, volume moderate."
      : "It's 6:59:45. You deleted the app last night. The alarm is still set for 7:00.";
  setPaused(true);
  $('startOverlay').hidden = false;
  render();
}

// ------------------------------------------------------------------ controls
function setPaused(p) {
  world.paused = p;
  $('playBtn').textContent = p ? '▶' : '❚❚';
  $('playBtn').setAttribute('aria-label', p ? 'Play' : 'Pause');
}
function setSpeed(v) {
  world.speed = v;
  document.querySelectorAll('#speeds button').forEach(b => b.classList.toggle('on', Number(b.dataset.speed) === v));
}

$('startBtn').addEventListener('click', () => { audio.unlock(); $('startOverlay').hidden = true; setPaused(false); });
$('playBtn').addEventListener('click', () => { audio.unlock(); $('startOverlay').hidden = true; setPaused(!world.paused); });
document.querySelectorAll('#speeds button').forEach(b => b.addEventListener('click', () => setSpeed(Number(b.dataset.speed))));
document.querySelectorAll('#scenarios button').forEach(b => b.addEventListener('click', () => scenario(b.dataset.sc)));
$('skipBtn').addEventListener('click', () => {
  const next = nextAlarmFrom(clock.alarms, world.sim);
  if (!next) { log('sim', 'No alarm is set on the clock yet.'); return; }
  if (clock.state !== 'IDLE') { log('sim', 'The crow is busy right now. Skipping is for quiet times.'); return; }
  world.sim = next - 10000;
  log('sim', 'Skipped ahead to 10 seconds before the alarm.');
});
$('dayBtn').addEventListener('click', () => {
  if (clock.state !== 'IDLE' && clock.state !== 'NEW') { log('sim', "Can't skip a day while the crow is awake."); return; }
  world.sim += 86400000;
  clock.lastFiredMinute = Math.floor(world.sim / 60000);
  log('sim', `A day passes. ${phone.link?.connected ? 'The app stayed connected, so the clock knows it still exists.' : 'No app checked in.'}`);
});
$('usbToggle').addEventListener('change', (e) => clock.setUsb(e.target.checked));
$('appToggle').addEventListener('change', (e) => {
  if (e.target.checked) { showScreen('store'); e.target.checked = false; }
  else deleteApp();
});
$('soundToggle').addEventListener('change', (e) => { audio.unlock(); audio.setOn(e.target.checked); });

// ------------------------------------------------------------------ render loop
const oled = $('oled'), device = $('device'), led = $('led');
function render() {
  const m = clock.screen();
  drawOled(oled, m);
  device.dataset.state = clock.state;
  device.dataset.level = clock.level;
  device.classList.toggle('dim', !m.bright);
  device.classList.toggle('unplugged', !clock.usb);
  led.classList.toggle('on', !!m.led);
  $('perchHold').style.setProperty('--p', clock.perch.down && !clock.perch.longDone ? Math.min(1, (performance.now() - clock.perch.at) / RULES.perchPairHoldMs) : 0);
  const ringing = clock.state === 'RING' || clock.state === 'CHECK';
  const pinTarget = ringing ? RULES.pinholeHoldMs : RULES.pinholeResetHoldMs;
  $('pinHold').style.setProperty('--p', clock.pin.down ? Math.min(1, (performance.now() - clock.pin.at) / pinTarget) : 0);

  const d = new Date(world.sim);
  const c = fmtClock(d.getHours(), d.getMinutes());
  $('simDay').textContent = DAY_SHORT[d.getDay()];
  $('simTime').textContent = `${c.time}:${pad2(d.getSeconds())}`;
  $('simAmpm').textContent = c.ampm;
  $('phTime').textContent = c.time;
  const wt = $('phWidgetTime');
  if (wt) wt.textContent = c.time;
  $('phIcons').textContent = `●●● ${Math.max(5, 82 - Math.floor((world.sim % 86400000) / 3600000))}%`;
}

function tick() {
  const now = performance.now();
  const dt = Math.min(250, now - world.lastReal);
  world.lastReal = now;
  if (!world.paused) world.sim += dt * world.speed;
  clock.tick(world.sim, now);
  if (clock.state !== lastState) {
    if (clock.state === 'RING' && world.speed !== 1) { setSpeed(1); log('sim', 'Speed back to 1× for the alarm.'); }
    lastState = clock.state;
  }
  render();
}

// ------------------------------------------------------------------ boot
$('mastMark').innerHTML = crowSVG('angry', 72, { label: 'Crow' });
$('footMark').innerHTML = crowSVG('sleep', 40);
scenario('morning');
setInterval(tick, 50);


// for testing from the console: __crow.clock, __crow.phone, __crow.world
window.__crow = { get clock() { return clock; }, phone, world, scenario, log };
