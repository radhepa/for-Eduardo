// Wake-up puzzles: easy, quick, but they need a working brain.
// Each mount(host, opts) draws into host and returns a cleanup function.
// opts: { difficulty: 'chill'|'normal'|'spicy', onSolve(), onMiss(), blip?(i) }

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function shake(el) { el.classList.remove('pz-shake'); void el.offsetWidth; el.classList.add('pz-shake'); }
function pulse(el, cls = 'pz-good') { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
function steps(n, done) {
  return `<div class="pz-steps" aria-label="${done} of ${n} done">${Array.from({ length: n }, (_, i) => `<i class="${i < done ? 'on' : ''}"></i>`).join('')}</div>`;
}

// ------------------------------------------------------------------ Quick Math
function genMath(d) {
  const kinds = {
    chill: [
      () => { const a = rnd(11, 49), b = rnd(2, 9); return [`${a} + ${b}`, a + b]; },
      () => { const a = rnd(20, 60), b = rnd(2, 9); return [`${a} − ${b}`, a - b]; },
      () => { const a = rnd(2, 5), b = rnd(2, 9); return [`${a} × ${b}`, a * b]; },
    ],
    normal: [
      () => { const a = rnd(12, 79), b = rnd(12, 49); return [`${a} + ${b}`, a + b]; },
      () => { const a = rnd(40, 99), b = rnd(11, a - 10); return [`${a} − ${b}`, a - b]; },
      () => { const a = rnd(3, 9), b = rnd(3, 9); return [`${a} × ${b}`, a * b]; },
    ],
    spicy: [
      () => { const a = rnd(11, 19), b = rnd(3, 9); return [`${a} × ${b}`, a * b]; },
      () => { const a = rnd(20, 60), b = rnd(20, 60), c = rnd(5, 30); return [`${a} + ${b} − ${c}`, a + b - c]; },
      () => { const a = rnd(3, 9), b = rnd(3, 9), c = rnd(5, 25); return [`${a} × ${b} + ${c}`, a * b + c]; },
    ],
  };
  const [text, ans] = pick(kinds[d] || kinds.normal)();
  return { text, ans };
}

function mountMath(host, { difficulty, onSolve, onMiss }) {
  const total = { chill: 2, normal: 3, spicy: 4 }[difficulty] || 3;
  let done = 0, typed = '', prob = genMath(difficulty);
  host.innerHTML = `
    <div class="pz pz-math">
      <p class="pz-ask">Solve it. No calculator.</p>
      <div class="pz-stepbox"></div>
      <div class="pz-q" aria-live="polite"></div>
      <div class="pz-a" aria-label="Your answer"></div>
      <div class="pz-keys">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button type="button" data-k="${n}">${n}</button>`).join('')}
        <button type="button" data-k="del" aria-label="Delete">⌫</button>
        <button type="button" data-k="0">0</button>
        <button type="button" data-k="ok" class="pz-ok" aria-label="Check answer">✓</button>
      </div>
    </div>`;
  const root = host.firstElementChild;
  const q = root.querySelector('.pz-q'), a = root.querySelector('.pz-a'), sb = root.querySelector('.pz-stepbox');
  const draw = () => { sb.innerHTML = steps(total, done); q.textContent = `${prob.text} =`; a.textContent = typed || ' '; };
  const press = (k) => {
    if (k === 'del') typed = typed.slice(0, -1);
    else if (k === 'ok') {
      if (!typed) return;
      if (Number(typed) === prob.ans) {
        done++; pulse(a);
        if (done >= total) { draw(); onSolve(); return; }
      } else { onMiss(); shake(root); }
      prob = genMath(difficulty); typed = '';
    } else if (typed.length < 4) typed += k;
    draw();
  };
  root.querySelector('.pz-keys').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) press(b.dataset.k); });
  const onKey = (e) => {
    if (!root.isConnected || root.offsetParent === null) return;
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('del');
    else if (e.key === 'Enter') press('ok');
    else return;
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  draw();
  return () => window.removeEventListener('keydown', onKey);
}

// ------------------------------------------------------------------ Crow's Memory (Simon)
function mountMemory(host, { difficulty, onSolve, onMiss, blip }) {
  const len = { chill: 3, normal: 4, spicy: 6 }[difficulty] || 4;
  let seq = [], idx = 0, phase = 'watch', timers = [];
  host.innerHTML = `
    <div class="pz pz-memory">
      <p class="pz-ask" aria-live="polite">Watch the pattern…</p>
      <div class="pz-pads">${[0, 1, 2, 3].map(i => `<button type="button" class="pz-pad p${i}" data-p="${i}" aria-label="Pad ${i + 1}"></button>`).join('')}</div>
      <div class="pz-stepbox"></div>
    </div>`;
  const root = host.firstElementChild;
  const ask = root.querySelector('.pz-ask'), pads = [...root.querySelectorAll('.pz-pad')], sb = root.querySelector('.pz-stepbox');
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  const light = (i, ms = 380) => { pads[i].classList.add('lit'); blip?.(i); later(() => pads[i].classList.remove('lit'), ms); };
  const play = () => {
    phase = 'watch'; idx = 0;
    root.classList.add('watching');
    ask.textContent = 'Watch the pattern…';
    sb.innerHTML = steps(len, 0);
    seq = Array.from({ length: len }, () => rnd(0, 3));
    seq.forEach((p, i) => later(() => light(p), 700 + i * 600));
    later(() => { phase = 'input'; root.classList.remove('watching'); ask.textContent = 'Your turn. Repeat it.'; }, 700 + len * 600);
  };
  root.querySelector('.pz-pads').addEventListener('click', e => {
    const b = e.target.closest('[data-p]');
    if (!b || phase !== 'input') return;
    const p = Number(b.dataset.p);
    light(p, 200);
    if (p === seq[idx]) {
      idx++; sb.innerHTML = steps(len, idx);
      if (idx >= len) { phase = 'done'; ask.textContent = 'Got it.'; later(onSolve, 300); }
    } else {
      onMiss(); shake(root); ask.textContent = 'Nope. Watch again.';
      phase = 'wait'; later(play, 900);
    }
  });
  play();
  return () => timers.forEach(clearTimeout);
}

// ------------------------------------------------------------------ Number Hunt (Schulte grid)
function mountHunt(host, { difficulty, onSolve, onMiss }) {
  const n = { chill: 3, normal: 4, spicy: 5 }[difficulty] || 4;
  const total = n * n;
  let next = 1;
  const nums = shuffle(Array.from({ length: total }, (_, i) => i + 1));
  host.innerHTML = `
    <div class="pz pz-hunt">
      <p class="pz-ask" aria-live="polite">Tap <b>1</b> to <b>${total}</b> in order. Find <b class="pz-next">1</b></p>
      <div class="pz-grid" style="--n:${n}">${nums.map(v => `<button type="button" data-v="${v}">${v}</button>`).join('')}</div>
    </div>`;
  const root = host.firstElementChild, nx = root.querySelector('.pz-next');
  root.querySelector('.pz-grid').addEventListener('click', e => {
    const b = e.target.closest('[data-v]');
    if (!b || b.classList.contains('found')) return;
    if (Number(b.dataset.v) === next) {
      b.classList.add('found'); next++;
      if (next > total) { nx.textContent = '✓'; onSolve(); } else nx.textContent = next;
    } else { onMiss(); pulse(b, 'pz-bad'); }
  });
  return () => {};
}

// ------------------------------------------------------------------ Color Clash (Stroop)
const COLORS = [
  { n: 'RED', c: 'var(--pz-red)' }, { n: 'BLUE', c: 'var(--pz-blue)' }, { n: 'GREEN', c: 'var(--pz-green)' },
  { n: 'YELLOW', c: 'var(--pz-yellow)' }, { n: 'PURPLE', c: 'var(--pz-purple)' },
];
function mountClash(host, { difficulty, onSolve, onMiss }) {
  const rounds = { chill: 4, normal: 6, spicy: 8 }[difficulty] || 6;
  const palette = difficulty === 'chill' ? COLORS.slice(0, 4) : COLORS;
  let done = 0, item;
  host.innerHTML = `
    <div class="pz pz-clash ${difficulty}">
      <p class="pz-ask" aria-live="polite"></p>
      <div class="pz-word"></div>
      <div class="pz-stepbox"></div>
      <div class="pz-swatches"></div>
    </div>`;
  const root = host.firstElementChild;
  const ask = root.querySelector('.pz-ask'), word = root.querySelector('.pz-word'), sw = root.querySelector('.pz-swatches'), sb = root.querySelector('.pz-stepbox');
  const next = () => {
    const w = pick(palette);
    let ink = pick(palette);
    while (ink === w) ink = pick(palette);
    const askFor = difficulty === 'spicy' && Math.random() < 0.4 ? 'word' : 'ink';
    item = { w, ink, askFor };
    ask.innerHTML = askFor === 'ink' ? 'Tap the <b>ink color</b>, not the word.' : 'Now tap what the <b>word says</b>.';
    word.textContent = w.n;
    word.style.color = ink.c;
    sb.innerHTML = steps(rounds, done);
    sw.innerHTML = shuffle(palette).map(c => difficulty === 'chill'
      ? `<button type="button" data-c="${c.n}"><span style="background:${c.c}"></span>${c.n.toLowerCase()}</button>`
      : `<button type="button" data-c="${c.n}">${c.n.toLowerCase()}</button>`).join('');
  };
  sw.addEventListener('click', e => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    const want = item.askFor === 'ink' ? item.ink.n : item.w.n;
    if (b.dataset.c === want) { done++; if (done >= rounds) { sb.innerHTML = steps(rounds, done); onSolve(); return; } }
    else { onMiss(); shake(root); }
    next();
  });
  next();
  return () => {};
}

// ------------------------------------------------------------------ Unscramble
// Words picked so none of them has a common anagram.
const WORDS = {
  chill: ['AWAKE', 'BACON', 'SUNNY', 'HONEY', 'JUICE', 'TOWEL', 'CROW', 'LIGHT', 'YAWN', 'FRUIT', 'CLOCK', 'EGGS'],
  normal: ['COFFEE', 'MORNING', 'BRIGHT', 'SUNRISE', 'WAFFLE', 'BLANKET', 'PILLOW', 'KETTLE', 'YAWNING', 'STRETCH', 'MUFFIN', 'OATMEAL', 'BUTTER'],
  spicy: ['BREAKFAST', 'SUNSHINE', 'PANCAKES', 'TOOTHBRUSH', 'BLUEBERRY', 'MARMALADE', 'DAYBREAK', 'CROISSANT', 'SLIPPERS', 'STRETCHING'],
};
function mountScramble(host, { difficulty, onSolve, onMiss }) {
  const target = pick(WORDS[difficulty] || WORDS.normal);
  const locked = difficulty === 'chill' ? 1 : 0;
  let tiles = [];
  do { tiles = shuffle(target.slice(locked).split('')); } while (tiles.join('') === target.slice(locked) && target.length > 3);
  let chosen = [];   // indexes into tiles
  host.innerHTML = `
    <div class="pz pz-scramble">
      <p class="pz-ask">A sleepy word got scrambled. Fix it.${locked ? ' First letter is free.' : ''}</p>
      <div class="pz-slots" style="--n:${target.length}"></div>
      <div class="pz-tiles"></div>
      <button type="button" class="pz-clear">Clear</button>
    </div>`;
  const root = host.firstElementChild;
  const slots = root.querySelector('.pz-slots'), tl = root.querySelector('.pz-tiles');
  const draw = () => {
    const letters = [...target.slice(0, locked)].map(c => `<span class="lock">${c}</span>`)
      .concat(Array.from({ length: target.length - locked }, (_, i) => chosen[i] !== undefined
        ? `<button type="button" data-s="${i}">${tiles[chosen[i]]}</button>` : '<span class="empty"></span>'));
    slots.innerHTML = letters.join('');
    tl.innerHTML = tiles.map((c, i) => `<button type="button" data-t="${i}" ${chosen.includes(i) ? 'disabled' : ''}>${c}</button>`).join('');
  };
  const check = () => {
    if (chosen.length < tiles.length) return;
    const guess = target.slice(0, locked) + chosen.map(i => tiles[i]).join('');
    if (guess === target) { root.classList.add('solved'); onSolve(); }
    else { onMiss(); shake(root); chosen = []; draw(); }
  };
  tl.addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (!b) return; chosen.push(Number(b.dataset.t)); draw(); check(); });
  slots.addEventListener('click', e => { const b = e.target.closest('[data-s]'); if (!b) return; chosen.splice(Number(b.dataset.s), 1); draw(); });
  root.querySelector('.pz-clear').addEventListener('click', () => { chosen = []; draw(); });
  draw();
  return () => {};
}

// ------------------------------------------------------------------ Odd One Out
const ODD_PAIRS = {
  chill: [['O', 'Q'], ['E', 'F'], ['P', 'R'], ['C', 'G'], ['T', 'Y']],
  normal: [['b', 'd'], ['p', 'q'], ['M', 'N'], ['6', '9'], ['V', 'Y'], ['u', 'n']],
  spicy: [['m', 'rn'], ['8', 'B'], ['5', 'S'], ['2', 'Z'], ['w', 'vv'], ['d', 'cl']],
};
function mountOdd(host, { difficulty, onSolve, onMiss }) {
  const n = { chill: 4, normal: 5, spicy: 6 }[difficulty] || 5;
  const rounds = { chill: 2, normal: 3, spicy: 3 }[difficulty] || 3;
  let done = 0;
  host.innerHTML = `
    <div class="pz pz-odd">
      <p class="pz-ask">One of these is not like the others. Tap it.</p>
      <div class="pz-stepbox"></div>
      <div class="pz-grid odd" style="--n:${n}"></div>
    </div>`;
  const root = host.firstElementChild, grid = root.querySelector('.pz-grid'), sb = root.querySelector('.pz-stepbox');
  let oddAt = 0;
  const next = () => {
    let [a, b] = pick(ODD_PAIRS[difficulty] || ODD_PAIRS.normal);
    if (Math.random() < 0.5) [a, b] = [b, a];
    oddAt = rnd(0, n * n - 1);
    sb.innerHTML = steps(rounds, done);
    grid.innerHTML = Array.from({ length: n * n }, (_, i) => `<button type="button" data-i="${i}">${i === oddAt ? b : a}</button>`).join('');
  };
  grid.addEventListener('click', e => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    if (Number(b.dataset.i) === oddAt) { done++; if (done >= rounds) { sb.innerHTML = steps(rounds, done); onSolve(); return; } next(); }
    else { onMiss(); pulse(b, 'pz-bad'); }
  });
  next();
  return () => {};
}

// ------------------------------------------------------------------ catalog
export const PUZZLES = {
  math:     { id: 'math', name: 'Quick Math', blurb: 'A few sums, no calculator.', icon: '×', mount: mountMath },
  memory:   { id: 'memory', name: "Crow's Memory", blurb: 'Repeat the pattern the pads flash.', icon: '▚', mount: mountMemory },
  hunt:     { id: 'hunt', name: 'Number Hunt', blurb: 'Tap the numbers in order.', icon: '#', mount: mountHunt },
  clash:    { id: 'clash', name: 'Color Clash', blurb: 'Tap the ink color, not the word.', icon: 'Aa', mount: mountClash, note: 'Hard to play with color blindness. Turn it off if so.' },
  scramble: { id: 'scramble', name: 'Unscramble', blurb: 'Fix a sleepy, scrambled word.', icon: 'ab', mount: mountScramble },
  odd:      { id: 'odd', name: 'Odd One Out', blurb: "Find the letter that doesn't belong.", icon: 'Q', mount: mountOdd },
};
export const PUZZLE_ORDER = ['math', 'memory', 'hunt', 'clash', 'scramble', 'odd'];
export const DIFFICULTIES = [
  { id: 'chill', name: 'Chill' }, { id: 'normal', name: 'Normal' }, { id: 'spicy', name: 'Spicy' },
];

export function pickPuzzle(enabled, lastId) {
  const pool = PUZZLE_ORDER.filter(id => enabled[id]);
  if (!pool.length) return 'math';
  const choices = pool.length > 1 ? pool.filter(id => id !== lastId) : pool;
  return pick(choices);
}
