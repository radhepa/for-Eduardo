// The Crow mascot: a round, front-facing crow with the same face the clock's OLED draws.
// Moods: open, angry, sad, squint, sleep, wide, happy.

const EYE = { l: 35, r: 65, y: 50, rr: 11 };

function eye(cx, mood, left, ink, bodyFill) {
  const { y, rr } = EYE;
  if (mood === 'sleep') return `<path d="M${cx - 9} ${y + 1} q9 7 18 0" fill="none" stroke="${ink}" stroke-width="3.2" stroke-linecap="round"/>`;
  if (mood === 'happy') return `<path d="M${cx - 9} ${y + 3} q9 -10 18 0" fill="none" stroke="${ink}" stroke-width="3.2" stroke-linecap="round"/>`;
  const r = mood === 'wide' ? rr + 1.5 : rr;
  let s = `<circle cx="${cx}" cy="${y}" r="${r}" fill="${ink}"/><circle class="crow-pupil" cx="${cx + (left ? 1.5 : -1.5)}" cy="${y + 1.5}" r="${mood === 'wide' ? 4.2 : 5}" fill="${bodyFill}"/>`;
  const t = y - r - 3, b = y - 1;
  if (mood === 'angry') s += left
    ? `<polygon points="${cx - r - 3},${t} ${cx + r + 3},${t} ${cx + r + 3},${b}" fill="${bodyFill}"/>`
    : `<polygon points="${cx - r - 3},${t} ${cx + r + 3},${t} ${cx - r - 3},${b}" fill="${bodyFill}"/>`;
  if (mood === 'sad') s += left
    ? `<polygon points="${cx - r - 3},${t} ${cx + r + 3},${t} ${cx - r - 3},${b}" fill="${bodyFill}"/>`
    : `<polygon points="${cx - r - 3},${t} ${cx + r + 3},${t} ${cx + r + 3},${b}" fill="${bodyFill}"/>`;
  if (mood === 'squint') s += `<rect x="${cx - r - 2}" y="${y - r - 2}" width="${2 * r + 4}" height="${r + 1}" fill="${bodyFill}"/>`;
  return s;
}

export function crowSVG(mood = 'open', size = 96, { body = '#1b1922', ink = '#f7f3ea', beak = '#ffb347', label = '' } = {}) {
  const open = mood === 'angry';
  const beakPath = open
    ? `<path d="M41 61 L59 61 L50 68 Z" fill="${beak}"/><path d="M44 72 L56 72 L50 79 Z" fill="${beak}"/>`
    : `<path d="M41 62 L59 62 L50 75 Z" fill="${beak}"/>`;
  const tear = mood === 'sad' ? `<path d="M27 64 q-3 5 0 7 q3 -2 0 -7 Z" fill="#7cc4ff"/>` : '';
  return `<svg class="crow crow-${mood}" viewBox="0 0 100 100" width="${size}" height="${size}" ${label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"'}>
    <path d="M45 18 C44 9 49 4 55 2 C52 8 53 12 57 17 Z" fill="${body}"/>
    <path d="M52 18 C55 11 61 9 66 9 C61 12 60 15 61 19 Z" fill="${body}"/>
    <ellipse cx="50" cy="56" rx="39" ry="37" fill="${body}"/>
    <path d="M14 66 C6 70 5 78 9 84 C13 79 17 76 22 75 Z" fill="${body}"/>
    <path d="M86 66 C94 70 95 78 91 84 C87 79 83 76 78 75 Z" fill="${body}"/>
    ${eye(EYE.l, mood, true, ink, body)}${eye(EYE.r, mood, false, ink, body)}
    ${beakPath}${tear}
    <g stroke="${beak}" stroke-width="3" stroke-linecap="round" fill="none">
      <path d="M40 92 v6 M40 92 l-5 6 M40 92 l5 6"/><path d="M60 92 v6 M60 92 l-5 6 M60 92 l5 6"/>
    </g>
  </svg>`;
}
