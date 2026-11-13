// Local persistence: rating, history, puzzle pool, games, in-progress game.
// Primary copy lives on disk in data/state.json (via server.py, this machine only);
// localStorage is a backup so nothing is lost if the server isn't running.
const KEY = 'chesscoach.v1';

const fresh = () => ({
  rating: 800,
  ratingHistory: [{ t: Date.now(), r: 800 }],
  puzzlesDone: 0,
  puzzlesSolved: 0,
  themeStats: {}, // theme -> { s, f }
  pool: [], // generated puzzles waiting to be served
  review: [], // puzzles built from your own game mistakes
  seen: [], // recent puzzle ids
  games: [], // { t, result, accuracy, level, color, counts }
  days: {}, // 'YYYY-MM-DD' -> { puzzles, games }
  settings: { level: 3, color: 'w', theme: 'any', coach: true },
});

let local = null;
try { local = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { local = null; }

let disk = null;
export let diskSync = false; // true when data/state.json is reachable
try {
  const r = await fetch('/api/state', { cache: 'no-store' });
  if (r.ok) { diskSync = true; disk = await r.json(); }
} catch { diskSync = false; }

// Prefer whichever copy was saved most recently
const newest = [disk, local].filter(Boolean).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))[0];
const state = { ...fresh(), ...(newest || {}) };
state.settings = { ...fresh().settings, ...(state.settings || {}) };

let saveTimer = null;
function writeNow() {
  state.savedAt = Date.now();
  const body = JSON.stringify(state);
  try { localStorage.setItem(KEY, body); } catch (e) { console.warn('local backup failed', e); }
  if (diskSync) {
    fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: body.length < 60000 })
      .catch(() => {});
  }
}
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 300);
}
// Flush pending changes when the tab closes
window.addEventListener('pagehide', () => { if (saveTimer) { clearTimeout(saveTimer); writeNow(); } });
if (diskSync && !disk && local) save(); // first run with the server: copy browser data to disk

export const store = state;

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function bumpDay(field) {
  const d = today();
  state.days[d] = state.days[d] || { puzzles: 0, games: 0 };
  state.days[d][field]++;
}

export function streak() {
  let n = 0;
  const d = new Date();
  // today counts if active; otherwise streak continues from yesterday
  const key = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  if (!state.days[key(d)]) d.setDate(d.getDate() - 1);
  while (state.days[key(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

/** Elo update for a puzzle attempt. Returns rating delta. */
export function recordPuzzle(puzzle, solved) {
  const k = state.puzzlesDone < 20 ? 48 : state.puzzlesDone < 60 ? 32 : 20;
  const expected = 1 / (1 + 10 ** ((puzzle.rating - state.rating) / 400));
  const delta = Math.round(k * ((solved ? 1 : 0) - expected));
  state.rating = Math.max(100, state.rating + delta);
  state.ratingHistory.push({ t: Date.now(), r: state.rating });
  if (state.ratingHistory.length > 400) state.ratingHistory.splice(0, state.ratingHistory.length - 400);
  state.puzzlesDone++;
  if (solved) state.puzzlesSolved++;
  for (const t of puzzle.themes) {
    const s = (state.themeStats[t] = state.themeStats[t] || { s: 0, f: 0 });
    solved ? s.s++ : s.f++;
  }
  state.seen.push(puzzle.id);
  if (state.seen.length > 300) state.seen.shift();
  bumpDay('puzzles');
  save();
  return delta;
}

export function recordGame(game) {
  state.games.push(game);
  if (state.games.length > 200) state.games.shift();
  bumpDay('games');
  save();
}

export function addToPool(p) {
  if (state.pool.some((x) => x.fen === p.fen)) return;
  state.pool.push(p);
  if (state.pool.length > 80) state.pool.shift();
  save();
}

export function addReview(p) {
  if (state.review.some((x) => x.fen === p.fen)) return;
  state.review.push(p);
  if (state.review.length > 100) state.review.shift();
  save();
}

/** Themes ranked weakest first (needs a few attempts to count). */
export function weakThemes(min = 3) {
  return Object.entries(state.themeStats)
    .filter(([, v]) => v.s + v.f >= min)
    .map(([t, v]) => ({ theme: t, rate: v.s / (v.s + v.f), n: v.s + v.f }))
    .sort((a, b) => a.rate - b.rate);
}

export async function resetAll() {
  localStorage.removeItem(KEY);
  if (diskSync) {
    await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...fresh(), savedAt: Date.now() }) }).catch(() => {});
  }
  location.reload();
}
