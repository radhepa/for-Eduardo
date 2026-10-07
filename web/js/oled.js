import { drawText, textWidth } from './font5x7.js';

// Draws the clock's 128x64 OLED from SimClock.screen(). Same coordinates as the firmware's
// render(); the result is thresholded to 1-bit so it looks like the real panel.

const W = 128, H = 64;

function eye(ctx, cx, cy, mood, gaze, left) {
  ctx.fillStyle = '#fff';
  if (mood === 'sleep') {
    ctx.fillRect(cx - 7, cy + 2, 15, 1);
    ctx.fillRect(cx - 8, cy + 1, 1, 1);
    ctx.fillRect(cx + 8, cy + 1, 1, 1);
    return;
  }
  const r = mood === 'wide' ? 10 : 9;
  ctx.beginPath(); ctx.arc(cx + 0.5, cy + 0.5, r + 0.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.arc(cx + gaze + 0.5, cy + 1.5, 4.5, 0, Math.PI * 2); ctx.fill();
  const tri = (pts) => { ctx.beginPath(); ctx.moveTo(pts[0], pts[1]); ctx.lineTo(pts[2], pts[3]); ctx.lineTo(pts[4], pts[5]); ctx.closePath(); ctx.fill(); };
  const a = [cx - r - 2, cy - r - 2], b = [cx + r + 3, cy - r - 2];
  if (mood === 'angry') tri([...a, ...b, ...(left ? [cx + r + 3, cy - 1] : [cx - r - 2, cy - 1])]);
  if (mood === 'sad') tri([...a, ...b, ...(left ? [cx - r - 2, cy - 1] : [cx + r + 3, cy - 1])]);
  if (mood === 'squint') ctx.fillRect(cx - r - 1, cy - r - 1, 2 * r + 3, r);
}

function face(ctx, m) {
  eye(ctx, 44, 22, m.mood, m.gaze, true);
  eye(ctx, 84, 22, m.mood, m.gaze, false);
  ctx.fillStyle = '#fff';
  const tri = (x1, y1, x2, y2, x3, y3) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.closePath(); ctx.fill(); };
  if (m.beakOpen) { tri(58, 29, 71, 29, 64.5, 34.5); tri(60, 36, 69, 36, 64.5, 41.5); }
  else tri(59, 31, 70, 31, 64.5, 38.5);
  if (m.mood === 'sad') { ctx.beginPath(); ctx.arc(37.5, 36.5, 2.5, 0, Math.PI * 2); ctx.fill(); }
}

function text(ctx, s, y, size, align = 'center', x = 64) {
  ctx.fillStyle = '#fff';
  const w = textWidth(s, size);
  const left = align === 'center' ? Math.round((128 - w) / 2) : align === 'right' ? x - w : x;
  drawText(ctx, s, left, y, size);
}

export function drawOled(canvas, m, tint = [214, 238, 255]) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  face(ctx, m);
  if (m.status) {
    if (m.status.next) text(ctx, `>${m.status.next}`, 0, 1, 'left', 0);
    if (m.status.ble) { ctx.beginPath(); ctx.arc(64.5, 3.5, 2.2, 0, Math.PI * 2); ctx.fill(); }
    text(ctx, m.status.batt, 0, 1, 'right', 128);
    if (m.status.usb) {
      const bx = 128 - textWidth(m.status.batt, 1);
      ctx.fillRect(bx - 8, 3, 5, 1); ctx.fillRect(bx - 4, 1, 1, 5);
    }
  }
  for (const l of m.lines) text(ctx, l.text, l.y, l.size);
  if (m.bars >= 0) {
    for (let i = 0; i < 4; i++) {
      const h = 3 + i * 3, x = 110 + i * 4;
      if (i <= m.bars) ctx.fillRect(x, 44 - h, 3, h);
      else { ctx.fillRect(x, 44 - h, 3, 1); ctx.fillRect(x, 43, 3, 1); ctx.fillRect(x, 44 - h, 1, h); ctx.fillRect(x + 2, 44 - h, 1, h); }
    }
  }
  if (m.penalty) text(ctx, '+2', 36, 1, 'left', 0);
  if (m.flash) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 44, 128, 20);
    text(ctx, m.flash.text, m.flash.size === 2 ? 46 : 51, m.flash.size);
  }
  if (m.hold) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 62, Math.round(128 * m.hold), 2); }

  // 1-bit threshold + panel tint (+ invert when the firmware would invert)
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let on = d[i] > 110;
    if (m.invert) on = !on;
    d[i] = on ? tint[0] : 0; d[i + 1] = on ? tint[1] : 0; d[i + 2] = on ? tint[2] : 0; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
