// Crow test suite: node tools/test.mjs
// 1. HMAC proofs match a reference HMAC-SHA256 (what the firmware's mbedTLS computes).
// 2. web/js/rules.js matches firmware/crow/config.h.
// 3. The simulated clock (a port of the firmware) behaves correctly through whole mornings.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RULES } from '../web/js/rules.js';
import { proof, parseState, encodeState, parseAlarms, encodeAlarms, cmd, randomHex, nextAlarmFrom } from '../web/js/proto.js';
import { SimClock } from '../web/js/sim-clock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; } else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
function section(t) { console.log(`\n${t}`); }

// ------------------------------------------------------------- 1. crypto
section('Proofs');
for (let i = 0; i < 20; i++) {
  const key = randomHex(16), data = randomHex(8);
  for (const prefix of ['auth:', 'solve:', 'awake:', 'paired:']) {
    const ref = createHmac('sha256', Buffer.from(key, 'hex')).update(prefix + data).digest('hex').slice(0, 16);
    check(`proof ${prefix}`, (await proof(key, prefix, data)) === ref);
  }
}
// fixed vector (also printed in docs/PROTOCOL.md)
const vec = await proof('000102030405060708090a0b0c0d0e0f', 'solve:', '0011223344556677');
const vecRef = createHmac('sha256', Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')).update('solve:0011223344556677').digest('hex').slice(0, 16);
check('fixed vector', vec === vecRef);
console.log(`  test vector: solve:0011223344556677 with key 00..0f -> ${vec}`);

// ------------------------------------------------------------- 2. rules parity
section('Rules match firmware');
const h = readFileSync(join(root, 'firmware/crow/config.h'), 'utf8');
const def = (name) => {
  const m = new RegExp(`#define\\s+${name}\\s+\\(?([0-9]+)`).exec(h);
  return m ? Number(m[1]) : NaN;
};
const pairs = [
  ['ESCALATE_L1_S', RULES.escalateS[1]], ['ESCALATE_L2_S', RULES.escalateS[2]], ['ESCALATE_L3_S', RULES.escalateS[3]],
  ['GRACE_S', RULES.graceS], ['CHECK_S', RULES.checkS], ['PAIR_WINDOW_S', RULES.pairWindowS],
  ['PERCH_PAIR_HOLD_MS', RULES.perchPairHoldMs], ['PINHOLE_HOLD_MS', RULES.pinholeHoldMs], ['PINHOLE_RESET_MS', RULES.pinholeResetHoldMs],
  ['SOS_ROUNDS', RULES.sosRounds], ['SOS_MIN_BEEPS', RULES.sosMinBeeps], ['SOS_MAX_BEEPS', RULES.sosMaxBeeps],
  ['SOS_LEAD_MS', RULES.sosLeadMs], ['SOS_BEEP_GAP_MS', RULES.sosBeepGapMs], ['SOS_INPUT_TIMEOUT_MS', RULES.sosInputTimeoutMs],
  ['SOS_SETTLE_MS', RULES.sosSettleMs], ['MISS_BUMP_COOLDOWN_S', RULES.missBumpCooldownS], ['MERCY_MIN_MIN', RULES.mercyMinMin],
  ['MERCY_MAX_MIN', RULES.mercyMaxMin], ['DEFAULT_MERCY_MIN', RULES.defaultMercyMin], ['MAX_ALARMS', RULES.maxAlarms],
  ['HEARTBEAT_S', RULES.heartbeatS],
];
for (const [n, v] of pairs) check(n, def(n) === v, `config.h=${def(n)} rules.js=${v}`);
check('ORPHAN_S', /ORPHAN_S\s+\(24UL \* 3600UL\)/.test(h) && RULES.orphanS === 86400);
const ino = readFileSync(join(root, 'firmware/crow/crow.ino'), 'utf8');
const proto = readFileSync(join(root, 'web/js/proto.js'), 'utf8');
for (const u of ['c20a0000', 'c20a0001', 'c20a0002', 'c20a0003', 'c20a0004']) {
  check(`uuid ${u}`, ino.includes(`${u}-0b5e-4d1e-9a1a-0000c20ac20a`) && proto.includes(`${u}-0b5e-4d1e-9a1a-0000c20ac20a`));
}
const fmt = /"S=%s;L=%u;C=%s;N=%s;T=%lu;Z=%d;A=%lu;P=%d;H=%d;G=%d;B=%u;U=%d;X=%d;O=%d;W=%lu;E=%lu;V=%d;M=%u;Y=%u;Q=%u;R=%u;J=%u;F=%s"/.test(ino);
check('firmware state format matches proto field order', fmt);

// ------------------------------------------------------------- wire format
section('Wire format');
const st = { state: 'RING', level: 2, challenge: 'aabbccddeeff0011', nonce: '0123456789abcdef', now: 1759820400, tz: -300, nextAlarm: 0, pairOpen: false, hasKey: true, authed: true, battery: 87, usb: false, penalty: true, orphan: false, remaining: 0, elapsed: 95, wakeCheck: true, mercy: 45, betrayals: 2, shame: 1, sosEscapes: 0, sosRound: 0, fw: '1.0.0' };
const round = parseState(encodeState(st));
check('state round trip', JSON.stringify(round) === JSON.stringify(st), JSON.stringify(round));
check('state string fits a long read', encodeState({ ...st, state: 'GRACE', elapsed: 99999, betrayals: 65535, shame: 65535, sosEscapes: 65535, mercy: 120 }).length < 240);
const al = [{ h: 7, m: 0, mask: 127, on: true }, null, { h: 22, m: 45, mask: 65, on: false }, null];
check('alarms round trip', JSON.stringify(parseAlarms(encodeAlarms(al))) === JSON.stringify(al));
for (const c of [cmd.solve('0123456789abcdef'), cmd.time(1759820400, -300), cmd.alarm(3, { h: 23, m: 59, mask: 127, on: true }), cmd.config(true, 120)]) {
  check(`command "${c}" fits 20-byte MTU`, c.length <= 20);
}

// ------------------------------------------------------------- 3. the clock
section('Clock scenarios');
const T0 = new Date(2026, 9, 8, 22, 30, 0).getTime();   // Thu 8 Oct 2026, 10:30 pm local
function rig(start = T0) {
  const log = [];
  const sounds = [];
  const sound = { ring: l => sounds.push(`ring${l}`), check: () => sounds.push('check'), stop: () => sounds.push('stop'), test: () => sounds.push('test'), ok: () => sounds.push('ok'), bad: () => sounds.push('bad'), sos: () => sounds.push('sos') };
  const r = { sim: start, real: 0, log, sounds };
  r.clock = new SimClock({ simMs: start, realMs: 0, sound, log: (w, m) => log.push(m) });
  r.adv = (sec, dt = 100) => { const end = r.real + sec * 1000; while (r.real < end) { r.sim += dt; r.real += dt; r.clock.tick(r.sim, r.real); } };
  r.s = () => parseState(r.clock.stateString());
  r.hold = (which, ms) => { r.clock.press(which, true, r.real); r.adv(ms / 1000); r.clock.press(which, false, r.real); };
  r.tap = () => { r.clock.press('perch', true, r.real); r.adv(0.2); r.clock.press('perch', false, r.real); };
  r.pair = async () => {
    r.clock.bleConnect();
    r.hold('perch', RULES.perchPairHoldMs + 200);
    const key = r.clock.keyValue();
    await r.clock.command(cmd.paired(await proof(key, 'paired:', r.s().nonce)));
    return key;
  };
  r.auth = async (key) => { await r.clock.command(cmd.auth(await proof(key, 'auth:', r.s().nonce))); return r.s().authed; };
  r.solve = async (key) => r.clock.command(cmd.solve(await proof(key, 'solve:', r.s().challenge)));
  r.awake = async (key) => r.clock.command(cmd.awake(await proof(key, 'awake:', r.s().challenge)));
  return r;
}

{ // first night: pair, set alarm, wake up properly
  const r = rig();
  check('fresh clock is NEW', r.s().state === 'NEW' && !r.s().hasKey);
  r.clock.bleConnect();
  check('key hidden before pairing', r.clock.keyValue() === '');
  await r.clock.command(cmd.alarm(0, { h: 7, m: 0, mask: 127, on: true }));
  check('unauthenticated alarm write ignored', r.clock.alarms[0] === null);
  r.clock.bleDisconnect();
  const key = await r.pair();
  check('paired', r.s().hasKey && r.s().authed && r.s().state === 'IDLE' && r.s().betrayals === 0);
  check('key hidden after pairing', r.clock.keyValue() === '');
  await r.clock.command(cmd.alarm(0, { h: 7, m: 0, mask: 127, on: true }));
  check('alarm stored', JSON.stringify(r.clock.alarms[0]) === JSON.stringify({ h: 7, m: 0, mask: 127, on: true }));
  const next = r.s().nextAlarm * 1000;
  check('next alarm is tomorrow 7:00', next === new Date(2026, 9, 9, 7, 0, 0).getTime(), new Date(next).toString());
  check('app agrees on next alarm', nextAlarmFrom(parseAlarms(r.clock.alarmsString()), r.sim) === next);

  r.sim = new Date(2026, 9, 9, 6, 59, 55).getTime(); r.adv(1);
  check('quiet before 7:00', r.s().state === 'IDLE');
  r.adv(5);
  check('rings at 7:00', r.s().state === 'RING' && r.s().level === 0 && /^[0-9a-f]{16}$/.test(r.s().challenge));
  check('ring sound started', r.sounds.includes('ring0'));
  r.tap();
  check('perch is not a snooze', r.s().state === 'RING' && r.clock.flashMsg === 'NO SNOOZE');
  r.adv(31, 500); check('level 2 after 30 s', r.s().level === 1);
  r.adv(60, 500); check('level 3 after 90 s', r.s().level === 2);
  r.adv(90, 500); check('level 4 after 180 s', r.s().level === 3);
  await r.clock.command(cmd.solve('0000000000000000'));
  check('bad proof refused', r.s().state === 'RING');
  const oldChallenge = r.s().challenge;
  await r.clock.command(cmd.solve(await proof(key, 'solve:', 'ffffffffffffffff')));
  check('proof for another challenge refused', r.s().state === 'RING' && r.s().challenge === oldChallenge);
  await r.solve(key);
  check('solved -> GRACE', r.s().state === 'GRACE' && r.s().remaining === RULES.graceS && r.s().challenge === '');
  r.adv(RULES.graceS + 1, 1000);
  check('wake check starts', r.s().state === 'CHECK' && r.s().challenge !== '' && r.s().challenge !== oldChallenge);
  await r.solve(key);
  check('SOLVE does not pass a wake check', r.s().state === 'CHECK');
  await r.awake(key);
  check('awake -> IDLE', r.s().state === 'IDLE');
  r.adv(30, 1000);
  check('no re-ring in the same minute', r.s().state === 'IDLE');
}

{ // the app gets deleted: the clock keeps its alarms and keeps ringing; re-pair costs a betrayal + penalty
  const r = rig();
  const key1 = await r.pair();
  await r.clock.command(cmd.alarm(0, { h: 7, m: 0, mask: 127, on: true }));
  r.clock.bleDisconnect();   // app deleted
  r.sim = new Date(2026, 9, 9, 6, 59, 59).getTime(); r.adv(2);
  check('rings with no app', r.s().state === 'RING');
  r.adv(600, 1000);
  check('still ringing 10 min later', r.s().state === 'RING' && r.s().level === 3);
  r.clock.bleConnect();
  check('old key still works if the app comes back', await r.auth(key1));
  r.clock.bleDisconnect();
  r.clock.bleConnect();
  check('wrong key refused', !(await r.auth(randomHex(16))));
  const key2 = await r.pair();
  check('re-pair while ringing = betrayal + penalty', r.s().betrayals === 1 && r.s().penalty && r.s().state === 'RING');
  r.clock.bleDisconnect(); r.clock.bleConnect();
  check('old key is dead after re-pair', !(await r.auth(key1)));
  await r.solve(key2);
  check('new key silences it', r.s().state === 'GRACE');
}

{ // orphan: no check-in for 24 h means the next ring starts loud with a penalty
  const r = rig();
  await r.pair();
  await r.clock.command(cmd.alarm(0, { h: 7, m: 0, mask: 127, on: true }));
  r.clock.bleDisconnect();
  r.sim = new Date(2026, 9, 10, 6, 59, 59).getTime(); r.adv(2);
  check('orphan ring: penalty + loud start', r.s().state === 'RING' && r.s().penalty && r.s().level === 2 && r.s().orphan);
}

{ // a connected app keeps the heartbeat alive
  const r = rig();
  await r.pair();
  await r.clock.command(cmd.alarm(0, { h: 7, m: 0, mask: 127, on: true }));
  r.adv(26 * 3600, 30000);
  check('connected app is never an orphan', !r.s().orphan);
}

{ // mercy limit: it gives up after 45 min and logs a shame
  const r = rig();
  await r.pair();
  await r.clock.command(cmd.alarm(0, { h: 7, m: 0, mask: 127, on: true }));
  r.sim = new Date(2026, 9, 9, 6, 59, 59).getTime(); r.adv(2);
  r.adv(44 * 60, 1000);
  check('still ringing at 44 min', r.s().state === 'RING');
  r.adv(70, 1000);
  check('mercy limit -> IDLE + shame', r.s().state === 'IDLE' && r.s().shame === 1 && r.clock.showShame);
}

{ // missed wake check goes back to RING; unplugging makes it worse
  const r = rig();
  const key = await r.pair();
  await r.clock.command(cmd.alarm(0, { h: 7, m: 0, mask: 127, on: true }));
  r.sim = new Date(2026, 9, 9, 6, 59, 59).getTime(); r.adv(2);
  await r.solve(key);
  r.adv(RULES.graceS + RULES.checkS + 2, 1000);
  check('missed wake check -> RING level 3', r.s().state === 'RING' && r.s().level === 2);
  r.clock.setUsb(false);
  check('unplugged while ringing -> level 4', r.s().level === 3 || (r.adv(1), r.s().level === 3));
  check('nice try', r.clock.flashMsg === 'NICE TRY');
  await r.clock.command(cmd.miss());
  check('miss at max stays at max', r.s().level === 3);
}

{ // wrong answers make it louder (with a cooldown)
  const r = rig();
  await r.pair();
  await r.clock.command(cmd.alarm(0, { h: 7, m: 0, mask: 127, on: true }));
  r.sim = new Date(2026, 9, 9, 6, 59, 59).getTime(); r.adv(2);
  await r.clock.command(cmd.miss()); r.adv(0.5);
  check('miss bumps level', r.s().level === 1);
  await r.clock.command(cmd.miss()); r.adv(0.5);
  check('miss cooldown', r.s().level === 1);
  r.adv(3.5); await r.clock.command(cmd.miss()); r.adv(0.5);
  check('second miss after cooldown', r.s().level === 2);
}

{ // SOS count-off: phone lost, still escapable while awake
  const r = rig();
  await r.pair();
  await r.clock.command(cmd.alarm(0, { h: 7, m: 0, mask: 127, on: true }));
  r.clock.bleDisconnect();
  r.sim = new Date(2026, 9, 9, 6, 59, 59).getTime(); r.adv(2);
  r.hold('pin', RULES.pinholeHoldMs - 1000);
  check('short pinhole hold does nothing', r.s().state === 'RING');
  r.hold('pin', RULES.pinholeHoldMs + 200);
  check('SOS starts', r.s().state === 'SOS');
  for (let round = 0; round < RULES.sosRounds; round++) {
    let guard = 0;
    while (r.clock.sos.phase !== 'INPUT' && guard++ < 200) r.adv(0.1);
    for (let i = 0; i < r.clock.sos.target; i++) { r.tap(); r.adv(0.2); }
    r.adv(RULES.sosSettleMs / 1000 + 0.3);
  }
  check('SOS passed -> IDLE + escape logged', r.s().state === 'IDLE' && r.s().sosEscapes === 1);

  r.sim = new Date(2026, 9, 10, 6, 59, 59).getTime(); r.adv(2);
  r.hold('pin', RULES.pinholeHoldMs + 200);
  let guard = 0;
  while (r.clock.sos.phase !== 'INPUT' && guard++ < 200) r.adv(0.1);
  for (let i = 0; i < r.clock.sos.target + 1; i++) { r.tap(); r.adv(0.2); }
  r.adv(RULES.sosSettleMs / 1000 + 0.3);
  check('wrong SOS count -> RING at full volume', r.s().state === 'RING' && r.s().level === 3);
  r.hold('pin', RULES.pinholeHoldMs + 200);
  r.adv(RULES.sosLeadMs / 1000 + RULES.sosMaxBeeps * RULES.sosBeepGapMs / 1000 + RULES.sosInputTimeoutMs / 1000 + 1);
  check('no SOS input -> RING', r.s().state === 'RING');
}

{ // factory reset only works while idle
  const r = rig();
  await r.pair();
  await r.clock.command(cmd.alarm(0, { h: 7, m: 0, mask: 127, on: true }));
  r.sim = new Date(2026, 9, 9, 6, 59, 59).getTime(); r.adv(2);
  r.clock.bleDisconnect();
  r.hold('pin', RULES.pinholeResetHoldMs + 500);
  check('no factory reset while ringing', r.clock.key !== null);
  const r2 = rig();
  await r2.pair();
  r2.hold('pin', RULES.pinholeResetHoldMs + 500);
  check('factory reset while idle', r2.clock.key === null && r2.s().state === 'NEW');
}

{ // weekday mask
  const r = rig(new Date(2026, 9, 9, 22, 0, 0).getTime());   // Friday night
  await r.pair();
  await r.clock.command(cmd.alarm(1, { h: 7, m: 30, mask: 62, on: true }));   // weekdays
  const next = new Date(r.s().nextAlarm * 1000);
  check('weekday alarm skips the weekend', next.getDay() === 1 && next.getHours() === 7 && next.getMinutes() === 30, next.toString());
  await r.clock.command(cmd.alarm(1, null));
  check('alarm deleted', r.clock.alarms[1] === null && r.s().nextAlarm === 0);
}

// ------------------------------------------------------------- 4. printable files
section('STL files (run `npm run cad` first)');
import { readdirSync, existsSync } from 'node:fs';
const stlDir = join(root, 'cad/stl');
if (!existsSync(stlDir)) check('cad/stl exists', false);
else for (const f of readdirSync(stlDir).filter(f => f.endsWith('.stl'))) {
  const buf = readFileSync(join(stlDir, f));
  const n = buf.readUInt32LE(80);
  check(`${f} size matches its triangle count`, buf.length === 84 + n * 50);
  const key = (o) => buf.toString('hex', o, o + 12);   // exact float32 bits
  const edges = new Map();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    const v = [key(o), key(o + 12), key(o + 24)];
    for (let k = 0; k < 3; k++) {
      const e = `${v[k]}|${v[(k + 1) % 3]}`;
      edges.set(e, (edges.get(e) || 0) + 1);
      for (let a = 0; a < 3; a++) { const x = buf.readFloatLE(o + k * 12 + a * 4); lo[a] = Math.min(lo[a], x); hi[a] = Math.max(hi[a], x); }
    }
  }
  let open = 0, multi = 0;
  for (const [e, c] of edges) { const [a, b] = e.split('|'); if (!edges.has(`${b}|${a}`)) open++; if (c > 1) multi++; }
  check(`${f} is watertight`, open === 0 && multi === 0, `open=${open} multi=${multi}`);
  check(`${f} sits on the print bed`, Math.abs(lo[2]) < 0.01, `min z=${lo[2]}`);
  const size = hi.map((h, k) => +(h - lo[k]).toFixed(1));
  if (f === 'crow-shell.stl') check('shell is 96 x 70 x 78 mm', size[0] === 96 && size[1] === 70 && size[2] === 78, size.join(' x '));
  console.log(`  ${f}: ${n} triangles, ${size.join(' x ')} mm`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
