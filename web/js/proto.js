// Crow BLE protocol: shared by the companion app, the simulator and the tests.
// Spec: docs/PROTOCOL.md. Firmware side: firmware/crow/crow.ino.

export const UUIDS = Object.freeze({
  service: 'c20a0000-0b5e-4d1e-9a1a-0000c20ac20a',
  state:   'c20a0001-0b5e-4d1e-9a1a-0000c20ac20a', // read + notify
  cmd:     'c20a0002-0b5e-4d1e-9a1a-0000c20ac20a', // write
  key:     'c20a0003-0b5e-4d1e-9a1a-0000c20ac20a', // read (only filled while pairing is open)
  alarms:  'c20a0004-0b5e-4d1e-9a1a-0000c20ac20a', // read
});

export const NAME_PREFIX = 'Crow';

// State string field letters -> names. Order is the wire order.
const FIELDS = [
  ['S', 'state', 'str'], ['L', 'level', 'int'], ['C', 'challenge', 'str'], ['N', 'nonce', 'str'],
  ['T', 'now', 'int'], ['Z', 'tz', 'int'], ['A', 'nextAlarm', 'int'], ['P', 'pairOpen', 'bool'],
  ['H', 'hasKey', 'bool'], ['G', 'authed', 'bool'], ['B', 'battery', 'int'], ['U', 'usb', 'bool'],
  ['X', 'penalty', 'bool'], ['O', 'orphan', 'bool'], ['W', 'remaining', 'int'], ['E', 'elapsed', 'int'],
  ['V', 'wakeCheck', 'bool'], ['M', 'mercy', 'int'], ['Y', 'betrayals', 'int'], ['Q', 'shame', 'int'],
  ['R', 'sosEscapes', 'int'], ['J', 'sosRound', 'int'], ['F', 'fw', 'str'],
];

export function parseState(text) {
  const raw = {};
  for (const part of String(text || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) raw[part.slice(0, i)] = part.slice(i + 1);
  }
  const out = {};
  for (const [k, name, type] of FIELDS) {
    const v = raw[k];
    if (type === 'str') out[name] = v || '';
    else if (type === 'bool') out[name] = v === '1';
    else out[name] = Number.parseInt(v, 10) || 0;
  }
  if (!out.state) out.state = 'IDLE';
  return out;
}

export function encodeState(s) {
  return FIELDS.map(([k, name, type]) => {
    const v = s[name];
    if (type === 'bool') return `${k}=${v ? 1 : 0}`;
    if (type === 'int') return `${k}=${Math.trunc(v || 0)}`;
    return `${k}=${v || ''}`;
  }).join(';');
}

// Alarms: 4 slots joined by ';'. Slot = "HHMM,mask,on" or "" when empty.
// mask bit 0 = Sunday ... bit 6 = Saturday (same as Date.getDay()).
export function parseAlarms(text) {
  const slots = String(text || '').split(';');
  const out = [];
  for (let i = 0; i < 4; i++) {
    const [hhmm, mask, on] = (slots[i] || '').split(',');
    if (!/^\d{4}$/.test(hhmm || '') || !(Number(mask) & 127)) { out.push(null); continue; }
    out.push({ h: Number(hhmm.slice(0, 2)), m: Number(hhmm.slice(2)), mask: Number(mask) & 127, on: on === '1' });
  }
  return out;
}

export function encodeAlarms(list) {
  return [0, 1, 2, 3].map(i => {
    const a = list[i];
    return a && a.mask ? `${pad2(a.h)}${pad2(a.m)},${a.mask},${a.on ? 1 : 0}` : '';
  }).join(';');
}

// ---- commands (each one write, kept under 20 bytes so it fits the default BLE MTU) ----
export const cmd = {
  auth:   (proofHex) => 'A' + proofHex,
  solve:  (proofHex) => 'S' + proofHex,
  awake:  (proofHex) => 'W' + proofHex,
  paired: (proofHex) => 'P' + proofHex,
  miss:   () => 'M',
  test:   () => 'R',
  time:   (unix, tzMin) => `T${Math.floor(unix)},${Math.round(tzMin)}`,
  alarm:  (i, a) => a ? `L${i},${pad2(a.h)}${pad2(a.m)},${a.mask & 127},${a.on ? 1 : 0}` : `L${i},0000,0,0`,
  config: (wakeCheck, mercyMin) => `C${wakeCheck ? 1 : 0},${Math.round(mercyMin)}`,
};

// ---- crypto ----
export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
export function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
export function randomHex(nBytes) {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

// proof = first 8 bytes of HMAC-SHA256(key, prefix + data), as 16 lowercase hex chars.
export async function proof(keyHex, prefix, data) {
  const key = await crypto.subtle.importKey('raw', hexToBytes(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(prefix + data));
  return bytesToHex(new Uint8Array(sig).slice(0, 8));
}

// ---- time helpers (local time, same rule the clock uses) ----
export function pad2(n) { return String(n).padStart(2, '0'); }

export function nextAlarmFrom(alarms, nowMs) {
  let best = 0;
  const base = new Date(nowMs);
  for (let d = 0; d < 8; d++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + d);
    for (const a of alarms) {
      if (!a || !a.on || !(a.mask & (1 << day.getDay()))) continue;
      const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), a.h, a.m, 0, 0).getTime();
      if (t > nowMs && (!best || t < best)) best = t;
    }
  }
  return best;
}

export function fmtClock(h, m) {
  const h12 = ((h + 11) % 12) + 1;
  return { time: `${h12}:${pad2(m)}`, ampm: h < 12 ? 'AM' : 'PM' };
}

export function fmtDur(totalS) {
  totalS = Math.max(0, Math.round(totalS));
  const m = Math.floor(totalS / 60), s = totalS % 60;
  return `${m}:${pad2(s)}`;
}

export function fmtUntil(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h >= 24) return `in ${Math.floor(h / 24)} d ${h % 24} h`;
  if (h > 0) return `in ${h} h ${m} m`;
  return m <= 0 ? 'in under a minute' : `in ${m} min`;
}

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export { DAY_LETTERS, DAY_SHORT };

export function daysLabel(mask) {
  mask &= 127;
  if (mask === 127) return 'Every day';
  if (mask === 62) return 'Weekdays';
  if (mask === 65) return 'Weekends';
  const days = [];
  for (let i = 0; i < 7; i++) if (mask & (1 << i)) days.push(DAY_SHORT[i]);
  return days.join(' ');
}

export function dayWord(targetMs, nowMs) {
  const a = new Date(nowMs), b = new Date(targetMs);
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  const diff = Math.round((db - da) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return DAY_SHORT[b.getDay()];
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
