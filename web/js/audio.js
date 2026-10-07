// Web Audio stand-in for the clock's buzzer: a synthesized crow caw that escalates like the
// firmware's patterns (level 1 chirps, level 4 non-stop). Volume is capped for laptop speakers.

export class CrowAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.on = true;
    this.timer = null;
    this.mode = null;
    this.level = 0;
    this.noise = null;
  }

  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.32;
        this.master.connect(this.ctx.destination);
        const len = this.ctx.sampleRate * 0.4;
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch { /* no audio, the sim still works */ }
  }

  setOn(v) {
    this.on = v;
    if (this.master) this.master.gain.setTargetAtTime(v ? 0.32 : 0, this.ctx.currentTime, 0.02);
  }

  get ready() { return !!this.ctx && this.on; }

  caw(gain = 0.6, pitch = 1, when = 0) {
    if (!this.ready) return;
    const c = this.ctx, t = c.currentTime + when;
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(gain, t + 0.025);
    out.gain.setValueAtTime(gain, t + 0.15);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1300 * pitch; bp.Q.value = 1.1;
    bp.connect(out); out.connect(this.master);

    const lfo = c.createOscillator(), lg = c.createGain();
    lfo.frequency.value = 46; lg.gain.value = 55 * pitch;
    lfo.connect(lg);
    for (const [type, detune] of [['sawtooth', 1], ['square', 1.012]]) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(700 * pitch * detune, t);
      o.frequency.exponentialRampToValueAtTime(430 * pitch * detune, t + 0.26);
      lg.connect(o.frequency);
      o.connect(bp);
      o.start(t); o.stop(t + 0.34);
    }
    lfo.start(t); lfo.stop(t + 0.34);

    const n = c.createBufferSource(), hp = c.createBiquadFilter(), ng = c.createGain();
    n.buffer = this.noise; hp.type = 'highpass'; hp.frequency.value = 1800;
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(gain * 0.35, t + 0.02);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    n.connect(hp); hp.connect(ng); ng.connect(this.master);
    n.start(t); n.stop(t + 0.3);
  }

  beep(freq, dur, gain = 0.25, when = 0, type = 'square') {
    if (!this.ready) return;
    const c = this.ctx, t = c.currentTime + when;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.setValueAtTime(gain, t + dur - 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  clearLoop() { clearTimeout(this.timer); this.timer = null; this.mode = null; }

  // level 0..3, same rhythm as the firmware's PAT_L0..PAT_L3
  ring(level) {
    this.clearLoop();
    this.mode = 'ring'; this.level = level;
    const loop = () => {
      if (this.mode !== 'ring') return;
      const L = this.level;
      let next;
      if (L === 0) { this.beep(2200, 0.07, 0.12); this.beep(2200, 0.07, 0.12, 0.18); next = 4000; }
      else if (L === 1) { this.caw(0.45, 1); this.caw(0.45, 0.92, 0.38); next = 2100; }
      else if (L === 2) { this.caw(0.7, 1.08); this.caw(0.7, 0.95, 0.26); this.caw(0.7, 1.08, 0.52); this.caw(0.7, 0.95, 0.78); next = 1550; }
      else { this.caw(0.95, 1.15); this.caw(0.95, 1.0, 0.22); this.caw(0.95, 1.15, 0.44); next = 760; }
      this.timer = setTimeout(loop, next);
    };
    loop();
  }

  check() {
    this.clearLoop();
    this.mode = 'check';
    const loop = () => {
      if (this.mode !== 'check') return;
      for (let i = 0; i < 3; i++) this.beep(2400, 0.06, 0.12, i * 0.14);
      this.timer = setTimeout(loop, 10000);
    };
    loop();
  }

  stop() { this.clearLoop(); }
  test() { this.caw(0.45, 1); this.caw(0.45, 0.92, 0.38); this.caw(0.45, 1, 1.0); this.caw(0.45, 0.92, 1.38); }
  ok() { this.beep(1800, 0.08, 0.12, 0, 'triangle'); this.beep(2400, 0.08, 0.12, 0.09, 'triangle'); this.beep(3000, 0.14, 0.12, 0.18, 'triangle'); }
  bad() { this.beep(420, 0.38, 0.2, 0, 'sawtooth'); }
  sos() { this.beep(1000, 0.25, 0.2); }
  blip(i) { this.beep([523, 659, 784, 988][i % 4], 0.16, 0.12, 0, 'triangle'); }
}
