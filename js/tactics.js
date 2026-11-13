// Tactic detection + human explanations. Everything here works on chess.js
// positions so the coach can describe *why* a move works, not just that it does.
import { Chess } from '../lib/chess.js';
import { winPct } from './engine.js';

export const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
export const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const FILES = 'abcdefgh';

export const sqToXY = (sq) => [FILES.indexOf(sq[0]), +sq[1] - 1];
export const xyToSq = (x, y) => (x >= 0 && x < 8 && y >= 0 && y < 8 ? FILES[x] + (y + 1) : null);
export const opp = (c) => (c === 'w' ? 'b' : 'w');
export const colorName = (c) => (c === 'w' ? 'White' : 'Black');

export function uciToMove(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined };
}
export function moveToUci(m) { return m.from + m.to + (m.promotion || ''); }

/** Play a UCI move on a fresh copy; returns { game, move } or null if illegal. */
export function playUci(fen, uci) {
  const g = new Chess(fen);
  try { const move = g.move(uciToMove(uci)); return { game: g, move }; } catch { return null; }
}

export function sanOf(fen, uci) { const r = playUci(fen, uci); return r ? r.move.san : uci; }

/** Convert a UCI pv into SAN with move numbers, e.g. "23. Nf7+ Kg8 24. Nxd8". */
export function pvToSan(fen, pv, max = 6) {
  const g = new Chess(fen);
  const out = [];
  for (const uci of pv.slice(0, max)) {
    const num = g.moveNumber();
    const white = g.turn() === 'w';
    let m;
    try { m = g.move(uciToMove(uci)); } catch { break; }
    if (white) out.push(`${num}. ${m.san}`);
    else out.push(out.length === 0 ? `${num}… ${m.san}` : m.san);
  }
  return out.join(' ');
}

export function material(g, color) {
  let sum = 0;
  for (const row of g.board()) for (const p of row) if (p && p.color === color && p.type !== 'k') sum += VALUE[p.type];
  return sum;
}

function pieces(g, color) {
  const out = [];
  for (const row of g.board()) for (const p of row) if (p && (!color || p.color === color)) out.push(p);
  return out;
}

/** Squares attacked by the piece on `sq` (uses chess.js attackers, so it respects blockers). */
function attackedBy(g, sq) {
  const p = g.get(sq);
  if (!p) return [];
  const out = [];
  for (const row of g.board()) for (const t of row) {
    if (t && t.color !== p.color && g.attackers(t.square, p.color).includes(sq)) out.push(t);
  }
  return out;
}

const defended = (g, sq, byColor) => g.attackers(sq, byColor).length > 0;

/** Walk a ray from `sq` and return the first two pieces hit. */
function rayHits(g, sq, dx, dy) {
  const [x0, y0] = sqToXY(sq);
  const hits = [];
  for (let i = 1; i < 8 && hits.length < 2; i++) {
    const s = xyToSq(x0 + dx * i, y0 + dy * i);
    if (!s) break;
    const p = g.get(s);
    if (p) hits.push({ ...p, square: s });
  }
  return hits;
}

const DIRS = { b: [[1, 1], [1, -1], [-1, 1], [-1, -1]], r: [[1, 0], [-1, 0], [0, 1], [0, -1]] };
DIRS.q = [...DIRS.b, ...DIRS.r];

/** Find pins/skewers created by the player's slider on `sq`. */
function lineTactics(g, sq) {
  const p = g.get(sq);
  if (!p || !DIRS[p.type]) return [];
  const found = [];
  for (const [dx, dy] of DIRS[p.type]) {
    const [a, b] = rayHits(g, sq, dx, dy);
    if (!a || !b || a.color === p.color || b.color === p.color) continue;
    const va = VALUE[a.type], vb = VALUE[b.type];
    if (va < 3 && vb !== 100) continue; // pinning a pawn is rarely the point
    if (vb > va && (b.type === 'k' || vb >= VALUE[p.type] || !defended(g, b.square, b.color))) {
      found.push({ kind: 'pin', front: a, back: b, by: p, sq });
    } else if (va > vb && (a.type === 'k' || va > VALUE[p.type])) {
      found.push({ kind: 'skewer', front: a, back: b, by: p, sq });
    }
  }
  return found;
}

/** Facts about one move: forks, pins, discovered attacks, sacrifices, etc. */
export function describeMove(fenBefore, uci) {
  const before = new Chess(fenBefore);
  const r = playUci(fenBefore, uci);
  if (!r) return { tags: [], notes: [] };
  const { game: g, move } = r;
  const me = move.color, them = opp(me);
  const tags = new Set();
  const notes = [];

  if (g.isCheckmate()) tags.add('mate');
  if (move.promotion) { tags.add('promotion'); notes.push(`promotes to a ${NAME[move.promotion]}`); }

  // Captures: hanging piece vs trade
  if (move.captured) {
    const wasDefended = defended(before, move.to, them);
    if (!wasDefended) {
      tags.add('hangingPiece');
      notes.push(`grabs the undefended ${NAME[move.captured]} on ${move.to}`);
    } else if (VALUE[move.captured] > VALUE[move.piece]) {
      notes.push(`wins the ${NAME[move.captured]} for a ${NAME[move.piece]}`);
    } else {
      notes.push(`takes the ${NAME[move.captured]} on ${move.to}`);
    }
  }

  // Sacrifice: lands on an attacked square giving more than it takes
  const landsAttacked = g.attackers(move.to, them).length > 0;
  const gain = move.captured ? VALUE[move.captured] : 0;
  if (landsAttacked && VALUE[move.piece] - gain >= 2 && move.piece !== 'k' && !tags.has('mate')) {
    tags.add('sacrifice');
    notes.push(`offers the ${NAME[move.piece]} as a sacrifice`);
  }

  // Check types
  if (g.inCheck()) {
    const kSq = pieces(g, them).find((p) => p.type === 'k').square;
    const checkers = g.attackers(kSq, me);
    if (checkers.length >= 2) { tags.add('doubleCheck'); notes.push('gives a double check — only the king can move'); }
    else if (!checkers.includes(move.to)) { tags.add('discoveredCheck'); notes.push('unleashes a discovered check'); }
    else if (!tags.has('mate')) notes.push('gives check');
  }

  // Fork: moved piece now hits 2+ juicy targets
  const targets = attackedBy(g, move.to).filter((t) =>
    t.type === 'k' || VALUE[t.type] > VALUE[move.piece] || !defended(g, t.square, them));
  if (targets.length >= 2) {
    const real = targets.filter((t) => t.type !== 'p' || targets.length > 2);
    if (real.length >= 2) {
      tags.add('fork');
      notes.push(`forks the ${real.slice(0, 3).map((t) => NAME[t.type]).join(' and ')}`);
    }
  }

  // Pins / skewers by the moved piece
  for (const t of lineTactics(g, move.to)) {
    tags.add(t.kind);
    notes.push(t.kind === 'pin'
      ? `pins the ${NAME[t.front.type]} to the ${NAME[t.back.type]}`
      : `skewers the ${NAME[t.front.type]} — when it moves, the ${NAME[t.back.type]} behind it falls`);
    break;
  }

  // Discovered attack: another of my pieces now attacks something valuable it didn't before
  for (const p of pieces(g, me)) {
    if (p.square === move.to || !DIRS[p.type]) continue;
    const now = attackedBy(g, p.square).filter((t) => t.type === 'k' || VALUE[t.type] >= 3);
    const was = new Set(attackedBy(before, p.square).map((t) => t.square));
    const fresh = now.filter((t) => !was.has(t.square) && t.square !== move.to);
    if (fresh.length && !tags.has('discoveredCheck')) {
      tags.add('discoveredAttack');
      notes.push(`opens a discovered attack by the ${NAME[p.type]} on the ${NAME[fresh[0].type]}`);
      break;
    }
  }

  return { tags: [...tags], notes, san: move.san, move, game: g };
}

/** Mate pattern names for the final position of a mating line. */
export function matePattern(g) {
  if (!g.isCheckmate()) return null;
  const loser = g.turn();
  const k = pieces(g, loser).find((p) => p.type === 'k');
  const checkers = g.attackers(k.square, opp(loser)).map((s) => g.get(s));
  const [kx, ky] = sqToXY(k.square);
  const backRank = loser === 'w' ? 0 : 7;
  if (checkers.length === 1 && checkers[0].type === 'n') {
    let boxed = true;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const s = xyToSq(kx + dx, ky + dy);
      if (s && s !== k.square) { const p = g.get(s); if (!p || p.color !== loser) boxed = false; }
    }
    if (boxed) return 'smotheredMate';
  }
  if (ky === backRank && checkers.some((c) => (c.type === 'r' || c.type === 'q') && +c.square[1] - 1 === backRank)) return 'backRankMate';
  return null;
}

/** Engine-free puzzle theme tagging over a full solution line. */
export function puzzleThemes(fen, solution) {
  const g = new Chess(fen);
  const me = g.turn();
  const startMat = material(g, me) - material(g, opp(me));
  const tags = new Set();
  const steps = [];
  for (let i = 0; i < solution.length; i++) {
    const f = g.fen();
    if (i % 2 === 0) {
      const d = describeMove(f, solution[i]);
      d.tags.forEach((t) => tags.add(t));
      steps.push({ uci: solution[i], san: d.san, notes: d.notes, mine: true });
    } else {
      steps.push({ uci: solution[i], san: sanOf(f, solution[i]), mine: false });
    }
    g.move(uciToMove(solution[i]));
  }
  // Only the first move counts as a "hanging piece" puzzle
  if (tags.has('hangingPiece') && solution.length > 1) tags.delete('hangingPiece');
  const playerMoves = Math.ceil(solution.length / 2);
  if (g.isCheckmate()) {
    tags.add('mate');
    tags.add(`mateIn${playerMoves}`);
    const pat = matePattern(g);
    if (pat) tags.add(pat);
  }
  const gain = material(g, me) - material(g, opp(me)) - startMat;
  if (!g.isCheckmate() && gain >= 2) tags.add('materialGain');
  if (pieces(g).length <= 10) tags.add('endgame');
  if (playerMoves === 1) tags.add('oneMove'); else if (playerMoves >= 3) tags.add('long');
  return { tags: [...tags], steps, gain, playerMoves };
}

export const THEMES = {
  mate: { name: 'Checkmate', icon: '♚', blurb: 'Find a forced checkmate.', tip: 'Always look at every check first — forcing moves limit your opponent’s options.' },
  mateIn1: { name: 'Mate in 1', icon: '♚', blurb: 'One move ends the game.', tip: 'Check every square around the enemy king: which are covered, which are free?' },
  mateIn2: { name: 'Mate in 2', icon: '♚', blurb: 'A two-move mating combination.', tip: 'Often the first move is a sacrifice or quiet move that takes away the last escape square.' },
  mateIn3: { name: 'Mate in 3+', icon: '♚', blurb: 'A longer mating attack.', tip: 'Keep giving checks that force the king toward the edge or into its own pieces.' },
  backRankMate: { name: 'Back-rank mate', icon: '♜', blurb: 'The king is trapped behind its own pawns.', tip: 'If the enemy king has no "luft" (escape square) and the back rank has one defender, overload or deflect it.' },
  smotheredMate: { name: 'Smothered mate', icon: '♞', blurb: 'A knight mates a king boxed in by its own pieces.', tip: 'Queen sacrifice on g8/g1 + knight check from f7/f2 is the classic pattern.' },
  fork: { name: 'Fork', icon: '♞', blurb: 'One piece attacks two targets at once.', tip: 'Look for squares where one of your pieces would attack the king plus another piece, or two undefended pieces.' },
  pin: { name: 'Pin', icon: '♝', blurb: 'A piece can’t move without exposing something more valuable behind it.', tip: 'Line up your bishop, rook or queen with the enemy king or queen, with a lesser piece in between.' },
  skewer: { name: 'Skewer', icon: '♜', blurb: 'A valuable piece is attacked and must move, exposing what’s behind it.', tip: 'It’s a reverse pin — the more valuable piece is in front.' },
  discoveredAttack: { name: 'Discovered attack', icon: '♗', blurb: 'Moving one piece unveils an attack from another.', tip: 'When a piece of yours blocks your own bishop, rook or queen, ask: where can it move with tempo?' },
  discoveredCheck: { name: 'Discovered check', icon: '♗', blurb: 'Moving a piece reveals a check from another.', tip: 'The moving piece is free to grab anything — your opponent must deal with the check first.' },
  doubleCheck: { name: 'Double check', icon: '♕', blurb: 'Two pieces give check at once.', tip: 'Double check can only be answered by moving the king — it’s the most forcing move in chess.' },
  hangingPiece: { name: 'Hanging piece', icon: '♟', blurb: 'Something is left undefended — take it.', tip: 'After every opponent move, ask: is anything of theirs undefended? Is anything of mine?' },
  sacrifice: { name: 'Sacrifice', icon: '♛', blurb: 'Give material to get something bigger.', tip: 'Sacrifices work when they’re forcing — checks and big threats leave no time to take back.' },
  promotion: { name: 'Promotion', icon: '♙', blurb: 'Push a pawn to the last rank.', tip: 'Passed pawns must be pushed! Clear the path and look at who controls the promotion square.' },
  materialGain: { name: 'Winning material', icon: '⚖', blurb: 'Come out ahead in material.', tip: 'Count attackers vs defenders on every contested piece.' },
  endgame: { name: 'Endgame', icon: '♔', blurb: 'Few pieces left — precision matters.', tip: 'Activate your king; in the endgame it’s a strong piece.' },
};
export const TRAINABLE = ['mate', 'mateIn1', 'mateIn2', 'backRankMate', 'fork', 'pin', 'skewer', 'discoveredAttack', 'hangingPiece', 'sacrifice', 'promotion', 'endgame'];

/** Pick the most instructive theme for headline display. */
export function primaryTheme(tags) {
  const order = ['smotheredMate', 'backRankMate', 'mateIn1', 'mateIn2', 'mateIn3', 'doubleCheck', 'discoveredCheck',
    'discoveredAttack', 'fork', 'skewer', 'pin', 'sacrifice', 'promotion', 'hangingPiece', 'materialGain', 'endgame'];
  return order.find((t) => tags.includes(t)) || 'materialGain';
}

// ---------- Move classification for the play-mode coach ----------

export const CLASSES = {
  best: { label: 'Best', sym: '★', color: 'var(--c-best)' },
  excellent: { label: 'Excellent', sym: '!', color: 'var(--c-good)' },
  good: { label: 'Good', sym: '✓', color: 'var(--c-good)' },
  book: { label: 'Book', sym: '📖', color: 'var(--c-book)' },
  inaccuracy: { label: 'Inaccuracy', sym: '?!', color: 'var(--c-inacc)' },
  mistake: { label: 'Mistake', sym: '?', color: 'var(--c-mistake)' },
  blunder: { label: 'Blunder', sym: '??', color: 'var(--c-blunder)' },
};

export function classify(scoreBefore, scoreAfter, playedBest) {
  const loss = winPct(scoreBefore) - winPct(scoreAfter);
  if (playedBest) return { cls: 'best', loss: Math.max(0, loss) };
  if (loss >= 20) return { cls: 'blunder', loss };
  if (loss >= 10) return { cls: 'mistake', loss };
  if (loss >= 5) return { cls: 'inaccuracy', loss };
  if (loss < 2) return { cls: 'excellent', loss };
  return { cls: 'good', loss };
}

export function moveAccuracy(loss) {
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * Math.max(0, loss)) - 3.1669));
}

/**
 * Explain a played move in plain English.
 * ctx: { fenBefore, played, best (uci), bestLine (pv), replyLine (pv after played move, opponent to move), replyMate, cls }
 */
export function explainMove(ctx) {
  const { fenBefore, played, best, bestLine = [], replyLine = [], replyMate, cls } = ctx;
  const parts = [];
  const playedSan = sanOf(fenBefore, played);
  const bestSan = best ? sanOf(fenBefore, best) : null;
  const after = playUci(fenBefore, played);
  if (!after) return '';
  const fenAfter = after.game.fen();

  if (cls === 'best' || cls === 'excellent' || cls === 'good') {
    const d = describeMove(fenBefore, played);
    if (d.notes.length) parts.push(`${playedSan} ${d.notes[0]}.`);
    if (cls === 'best') parts.push('That’s exactly what the engine wanted.');
    else if (cls === 'good' && bestSan) parts.push(`Solid. ${bestSan} was slightly more precise.`);
    return parts.join(' ');
  }

  // What does the opponent get now?
  if (replyLine.length) {
    const reply = replyLine[0];
    const rd = describeMove(fenAfter, reply);
    const replySan = rd.san;
    if (replyMate != null && replyMate > 0) {
      parts.push(`This allows a forced mate: ${pvToSan(fenAfter, replyLine, replyMate * 2)}.`);
    } else if (rd.move?.captured && !defended(new Chess(fenAfter), rd.move.to, after.move.color)) {
      parts.push(`It leaves your ${NAME[rd.move.captured]} on ${rd.move.to} hanging — ${replySan} just takes it.`);
    } else if (rd.tags.includes('fork')) {
      parts.push(`It walks into ${replySan}, which ${rd.notes.find((n) => n.startsWith('forks')) || 'forks your pieces'}.`);
    } else if (rd.tags.includes('pin') || rd.tags.includes('skewer')) {
      parts.push(`It allows ${replySan}, which ${rd.notes.find((n) => /pins|skewers/.test(n))}.`);
    } else if (rd.move?.captured) {
      parts.push(`After ${replySan} you lose material.`);
    } else {
      parts.push(`Your opponent answers with ${pvToSan(fenAfter, replyLine, 3)}.`);
    }
  }

  // What should you have done?
  if (bestSan) {
    const bd = describeMove(fenBefore, best);
    const why = bd.notes.length ? `, which ${bd.notes[0]}` : '';
    const missedTactic = bd.tags.find((t) => ['mate', 'fork', 'pin', 'skewer', 'discoveredAttack', 'hangingPiece', 'doubleCheck'].includes(t));
    if (missedTactic && cls !== 'inaccuracy') parts.push(`You missed ${bestSan}${why}.`);
    else parts.push(`Better was ${bestSan}${why}${bestLine.length > 1 ? ` (${pvToSan(fenBefore, bestLine, 4)})` : ''}.`);
  }
  return parts.join(' ');
}

// ---------- Opening principle checks (independent of the engine) ----------

export function openingTips(history, color) {
  // history: chess.js verbose moves for the whole game so far; returns tip for the latest move of `color`
  const mine = history.filter((m) => m.color === color);
  const last = mine[mine.length - 1];
  if (!last || mine.length > 12) return null;
  const n = mine.length;
  const backRank = color === 'w' ? '1' : '8';
  const minorsHome = ['b', 'g'].map((f) => f + backRank).concat(['c', 'f'].map((f) => f + backRank))
    .filter((sq) => !mine.some((m) => m.from === sq)).length;

  if (last.piece === 'q' && n <= 5 && minorsHome >= 3 && !last.captured)
    return 'Early queen move. Your queen can get chased around by minor pieces and lose time — develop knights and bishops first.';
  if (last.piece === 'n' && (last.to[0] === 'a' || last.to[0] === 'h') && n <= 8)
    return '“A knight on the rim is dim.” From the edge it controls only half as many squares as from the center.';
  if (n <= 8 && last.piece !== 'p' && !last.captured && mine.slice(0, -1).some((m) => m.to === last.from) && minorsHome >= 2)
    return 'Moving the same piece twice in the opening costs time. Try to bring a new piece into play each move.';
  if (last.piece === 'p' && last.from[0] === 'f' && n <= 6 && !last.captured)
    return 'Careful with early f-pawn moves — they weaken the diagonal to your king (e1–h4 / e8–h5).';
  if (n === 10 && !mine.some((m) => m.flags.includes('k') || m.flags.includes('q')))
    return 'Move 10 and you haven’t castled yet. Castling tucks your king away and connects your rooks.';
  return null;
}
