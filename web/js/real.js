// Entry point for the real companion app (app.html): the Crow app over Web Bluetooth.
import { CrowApp } from './app.js';
import { BleLink } from './ble-link.js';
import { CrowAudio } from './audio.js';

class LocalStore {
  constructor(prefix) { this.p = prefix; }
  get(k) { try { return localStorage.getItem(this.p + k); } catch { return null; } }
  set(k, v) { try { localStorage.setItem(this.p + k, String(v)); } catch { /* storage blocked */ } }
  remove(k) { try { localStorage.removeItem(this.p + k); } catch { /* storage blocked */ } }
  getJSON(k) { try { return JSON.parse(this.get(k)); } catch { return null; } }
  setJSON(k, v) { this.set(k, JSON.stringify(v)); }
  clear() { try { Object.keys(localStorage).filter(k => k.startsWith(this.p)).forEach(k => localStorage.removeItem(k)); } catch { /* storage blocked */ } }
}

const audio = new CrowAudio();
const root = document.getElementById('app');
const link = new BleLink();

const app = new CrowApp(root, {
  link,
  storage: new LocalStore('crow.'),
  env: {
    kind: 'real',
    now: () => Date.now(),
    notify: (title, body) => {
      navigator.vibrate?.([400, 150, 400, 150, 400]);
      try {
        if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, icon: 'icons/icon-192.png', tag: 'crow' });
      } catch { /* some browsers only allow notifications from a service worker */ }
    },
    log: (who, msg) => console.info(`[crow:${who}] ${msg}`),
    vibrate: (ms) => navigator.vibrate?.(ms),
    blip: (i) => audio.blip(i),
    afterPair: () => {
      try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ }
    },
  },
});

document.addEventListener('pointerdown', () => audio.unlock(), { once: true });
document.addEventListener('visibilitychange', () => {
  const visible = document.visibilityState === 'visible';
  app.setVisible(visible);
  if (visible && !link.connected) app.start();
});
app.start();

if (!BleLink.supported()) document.getElementById('nobt').hidden = false;

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// debugging handle (harmless): window.__crowApp
window.__crowApp = app;
