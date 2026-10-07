// Web Bluetooth link to a real Crow clock (Chrome/Edge on Android, Windows, macOS, ChromeOS;
// on iPhone use a Web Bluetooth browser such as Bluefy). Same interface as the simulator's SimLink.
import { UUIDS, NAME_PREFIX, parseState, parseAlarms } from './proto.js';

export class BleLink {
  constructor() {
    this.kind = 'ble';
    this.device = null;
    this.connected = false;
    this.chars = {};
    this.stateCbs = new Set();
    this.connCbs = new Set();
    this.queue = Promise.resolve();
    this.pollTimer = null;
    this.retryTimer = null;
    this.refreshing = false;
    this.refreshAgain = false;
    this.onNotify = () => this.refresh().catch(() => {});
  }

  static supported() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }
  get deviceName() { return this.device?.name || ''; }
  canReconnect() { return !!this.device; }
  onState(cb) { this.stateCbs.add(cb); return () => this.stateCbs.delete(cb); }
  onConnection(cb) { this.connCbs.add(cb); return () => this.connCbs.delete(cb); }

  async scanAndConnect() {
    if (!BleLink.supported()) throw new Error('This browser has no Bluetooth support. Use Chrome on Android or a computer, or the Bluefy browser on iPhone.');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: NAME_PREFIX }],
      optionalServices: [UUIDS.service],
    });
    this.attach(device);
    await this.open();
  }

  // Reconnect without the chooser: works for a device picked earlier in this page session, and
  // after a reload where the browser supports getDevices() (Chrome with the permissions backend).
  async reconnect() {
    if (!this.device && navigator.bluetooth?.getDevices) {
      const known = await navigator.bluetooth.getDevices();
      const d = known.find(x => (x.name || '').startsWith(NAME_PREFIX));
      if (d) this.attach(d);
    }
    if (!this.device) throw new Error('No crow remembered yet. Tap Connect.');
    await this.open();
  }

  attach(device) {
    if (this.device === device) return;
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => this.onDrop());
  }

  async open() {
    clearTimeout(this.retryTimer);
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(UUIDS.service);
    for (const k of ['state', 'cmd', 'key', 'alarms']) this.chars[k] = await svc.getCharacteristic(UUIDS[k]);
    try {
      await this.chars.state.startNotifications();
      this.chars.state.removeEventListener('characteristicvaluechanged', this.onNotify);
      this.chars.state.addEventListener('characteristicvaluechanged', this.onNotify);
    } catch { /* notifications unavailable: polling below still keeps us current */ }
    this.connected = true;
    this.connCbs.forEach(cb => cb(true));
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.refresh().catch(() => {}), 2000);
    await this.refresh();
  }

  onDrop() {
    clearInterval(this.pollTimer);
    if (!this.connected) return;
    this.connected = false;
    this.connCbs.forEach(cb => cb(false));
    if (this.device) this.retryTimer = setTimeout(() => this.reconnect().catch(() => {}), 2500);
  }

  disconnect() {
    clearTimeout(this.retryTimer);
    clearInterval(this.pollTimer);
    const d = this.device;
    this.device = null;
    if (this.connected) {
      this.connected = false;
      this.connCbs.forEach(cb => cb(false));
    }
    if (d?.gatt?.connected) d.gatt.disconnect();
  }

  // GATT allows one operation at a time; queue them.
  run(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  async readText(name) {
    const v = await this.run(() => this.chars[name].readValue());
    return new TextDecoder().decode(v);
  }

  // The notification payload can be cut at the MTU, so it's only a "something changed" signal:
  // read the full value (long read) instead.
  async refresh() {
    if (!this.connected) return null;
    if (this.refreshing) { this.refreshAgain = true; return null; }
    this.refreshing = true;
    try {
      let s;
      do {
        this.refreshAgain = false;
        s = parseState(await this.readText('state'));
        this.stateCbs.forEach(cb => cb(s));
      } while (this.refreshAgain && this.connected);
      return s;
    } finally {
      this.refreshing = false;
    }
  }

  async readState() { return parseState(await this.readText('state')); }
  async readKey() { return (await this.readText('key')).trim(); }
  async readAlarms() { return parseAlarms(await this.readText('alarms')); }

  async send(c) {
    if (!this.connected) throw new Error('Not connected to the crow.');
    const data = new TextEncoder().encode(c);
    const ch = this.chars.cmd;
    await this.run(() => (ch.writeValueWithResponse ? ch.writeValueWithResponse(data) : ch.writeValue(data)));
    await this.refresh();
  }
}
