// Endless puzzle generator.
// Plays fast engine-vs-engine games from varied openings, sprinkling in the kind of
// mistakes humans make. Whenever a mistake leaves the other side with exactly one
// winning continuation, that position becomes a puzzle. Each step of the solution
// is checked for uniqueness, so there is always one clear answer.
import { Chess } from '../lib/chess.js';
import { Engine } from './engine.js';
import { uciToMove, puzzleThemes, primaryTheme, describeMove } from './tactics.js';

const OPENINGS = [
  'e4 e5 Nf3 Nc6 Bc4 Bc5', 'e4 e5 Nf3 Nc6 Bb5 a6', 'e4 e5 Nf3 Nc6 d4 exd4', 'e4 e5 Nf3 Nc6 Bc4 Nf6',
  'e4 c5 Nf3 d6 d4 cxd4', 'e4 c5 Nc3 Nc6', 'e4 c5 Nf3 Nc6 d4 cxd4', 'e4 e6 d4 d5', 'e4 c6 d4 d5',
  'e4 d5 exd5 Qxd5', 'e4 Nf6 e5 Nd5', 'e4 d6 d4 Nf6 Nc3 g6', 'e4 e5 f4 exf4', 'e4 e5 Nf3 d6 d4 exd4',
  'e4 e5 Nc3 Nf6', 'e4 e5 Nf3 Nf6 Nxe5 d6', 'd4 d5 c4 e6 Nc3 Nf6', 'd4 d5 c4 c6 Nf3 Nf6', 'd4 d5 c4 dxc4',
  'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6', 'd4 Nf6 c4 e6 Nc3 Bb4', 'd4 d5 Bf4 Nf6 e3', 'd4 f5 g3 Nf6', 'd4 Nf6 c4 c5 d5 b5',
  'c4 e5 Nc3 Nf6', 'c4 c5 Nc3 Nc6', 'Nf3 d5 g3 Nf6 Bg2', 'e4 g6 d4 Bg7', 'e4 e5 Bc4 Nf6 d3', 'b3 e5 Bb2 Nc6',
  'e4 e5 Nf3 Nc6 Bc4 Bc5 b4', 'e4 e5 d4 exd4 c3', 'd4 e5 dxe5 Nc6', 'e4 c5 d4 cxd4 c3', 'e4 e5 Qh5 Nc6 Bc4',
];

const rand = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rand(a.length)];

export class PuzzleGenerator {
  constructor({ onPuzzle, onStatus }) {
    this.engine = null;
    this.onPuzzle = onPuzzle;
    this.onStatus = onStatus || (() => {});
    this.running = false;
    this.wanted = () => true; // set by the app: keep generating while true
    this.positionsChecked = 0;
    this.made = 0;
  }

  start() {
    if (this.running) return;
    this.engine = this.engine || new Engine('generator');
    this.running = true;
    this._loop();
  }

  stop() { this.running = false; }

  async _loop() {
    while (this.running) {
      if (!this.wanted()) { this.onStatus({ idle: true }); await sleep(1500); continue; }
      try { await this._game(); } catch (e) { console.warn('generator error', e); await sleep(500); }
    }
  }

  async _game() {
    const g = new Chess();
    const line = pick(OPENINGS).split(' ');
    const take = Math.min(line.length, 2 + rand(line.length));
    for (const san of line.slice(0, take)) g.move(san);
    // Random personality for this game: how often each side slips up
    const sloppiness = 0.12 + Math.random() * 0.2;
    let quietPlies = 0;

    for (let ply = 0; ply < 90 && this.running && !g.isGameOver(); ply++) {
      if (!this.wanted()) return;
      const fen = g.fen();
      const a = await this.engine.analyze(fen, { depth: 7, multipv: 4 });
      if (!a || !a.lines.length) return;
      const lines = a.lines;

      // Already decided games make poor puzzles — restart
      if (Math.abs(lines[0].score) > 700 && g.moveNumber() > 12) return;

      // Choose a move: mostly sound, sometimes a slip, occasionally a real blunder
      let uci;
      const r = Math.random();
      const canSlip = g.history().length >= 10 && quietPlies >= 2;
      if (canSlip && r < sloppiness * 0.15) {
        const m = pick(g.moves({ verbose: true })); // a genuine blunder (random legal move)
        uci = m.from + m.to + (m.promotion || '');
      } else if (canSlip && r < sloppiness) {
        uci = lines[Math.min(lines.length - 1, 1 + rand(3))].uci; // a weaker engine choice
      } else {
        uci = lines[Math.random() < 0.8 ? 0 : Math.min(lines.length - 1, 1)].uci;
      }
      const chosen = lines.find((l) => l.uci === uci);
      const lossEstimate = chosen ? lines[0].score - chosen.score : 999;

      const prevFen = fen;
      g.move(uciToMove(uci));
      quietPlies++;
      this.positionsChecked++;
      this.onStatus({ checked: this.positionsChecked, made: this.made });

      // Only look deeper when the move looked like it might be a mistake
      if (lossEstimate < 120 || g.isGameOver()) continue;
      const puzzle = await this._tryPuzzle(prevFen, uci, g.fen(), -lines[0].score);
      if (puzzle) {
        this.made++;
        quietPlies = 0;
        this.onPuzzle(puzzle);
        this.onStatus({ checked: this.positionsChecked, made: this.made });
        if (Math.random() < 0.5) return; // move on to a fresh game half the time
      }
    }
  }

  /** prevFen + blunder → fen. evalBefore = score for the solver before the blunder. */
  async _tryPuzzle(prevFen, blunder, fen, evalBefore) {
    const first = await this.engine.analyze(fen, { depth: 13, multipv: 2 });
    if (!first || !first.lines.length) return null;
    const [b1, b2] = first.lines;
    if (!isUniqueWin(b1, b2, true)) return null;
    // The solver must not have already been winning comfortably before the slip
    if (evalBefore > 250 && b1.mate == null) return null;
    if (b1.mate == null && b1.score - Math.max(evalBefore, -300) < 200) return null;

    const isMate = b1.mate != null;
    const maxPlayerMoves = isMate ? Math.min(b1.mate, 4) : 3;
    const g = new Chess(fen);
    const solution = [];
    let analysis = first;

    for (let step = 0; step < maxPlayerMoves; step++) {
      if (step > 0) {
        analysis = await this.engine.analyze(g.fen(), { depth: 12, multipv: 2 });
        if (!analysis || !analysis.lines.length) break;
        const [a1, a2] = analysis.lines;
        if (!isUniqueWin(a1, a2, false)) break;
        // For material puzzles, stop once the point has been made
        if (!isMate && step >= 1 && quietLine(g.fen(), a1.uci) && a1.score < 600) break;
      }
      const mv = analysis.lines[0].uci;
      solution.push(mv);
      g.move(uciToMove(mv));
      if (g.isGameOver()) break;
      if (step === maxPlayerMoves - 1) break;
      const reply = await this.engine.analyze(g.fen(), { depth: 11, multipv: 1 });
      if (!reply?.best) break;
      // Peek ahead: is there another forced step? If not, end here (on our move).
      solution.push(reply.best);
      g.move(uciToMove(reply.best));
    }
    // Puzzles must end on the solver's move
    if (solution.length % 2 === 0) solution.pop();
    if (!solution.length) return null;
    // A mate line that got cut short (non-unique step) only survives if it still wins material below.

    const { tags, steps, gain, playerMoves } = puzzleThemes(fen, solution);
    if (!tags.includes('mate') && gain < 2 && !tags.includes('promotion')) return null;

    // Reject plain recaptures (they just took, you take back — not a tactic)
    const blunderMove = new Chess(prevFen).move(uciToMove(blunder));
    if (blunderMove.captured && solution[0].slice(2, 4) === blunderMove.to && playerMoves === 1) return null;

    // Difficulty: shallow search finds it? first move quiet? sacrifice? length?
    const shallow = await this.engine.analyze(fen, { depth: 3, multipv: 1 });
    const firstInfo = describeMove(fen, solution[0]);
    const firstMove = firstInfo.move;
    let rating = 700;
    rating += (playerMoves - 1) * 330;
    if (!firstMove.captured && !firstMove.san.includes('+')) rating += 280;
    if (firstMove.san.includes('+')) rating -= 60;
    if (tags.includes('hangingPiece')) rating -= 250;
    if (tags.includes('sacrifice')) rating += 260;
    if (tags.includes('mateIn1')) rating -= 120;
    if (shallow?.best && shallow.best !== solution[0]) rating += 320;
    rating += rand(120) - 60;
    rating = Math.max(400, Math.min(2600, Math.round(rating / 10) * 10));
    // "Free piece" puzzles are useful early on, but keep them from flooding the pool
    if (rating < 600 && Math.random() > 0.35) return null;
    if (this.minRating && rating < this.minRating()) return null;

    const blunderSan = new Chess(prevFen).move(uciToMove(blunder)).san;
    return {
      id: 'g' + Date.now().toString(36) + rand(1e6).toString(36),
      source: 'generated',
      prevFen, blunder, blunderSan, fen,
      solution, steps, themes: tags, theme: primaryTheme(tags),
      rating, mate: isMate ? b1.mate : null, eval: b1.score, created: Date.now(),
    };
  }
}

/** Is the best line clearly winning AND clearly better than the alternative? */
function isUniqueWin(best, second, strict) {
  if (!best) return false;
  if (best.mate != null) {
    if (best.mate <= 0) return false;
    if (!second) return true;
    if (second.mate != null && second.mate > 0) return false; // two ways to mate
    return second.score < (strict ? 300 : 400);
  }
  if (best.score < (strict ? 220 : 180)) return false;
  if (!second) return true;
  return best.score - second.score >= (strict ? 220 : 180) && second.score < best.score * 0.6;
}

function quietLine(fen, uci) {
  const g = new Chess(fen);
  const m = g.move(uciToMove(uci));
  return !m.captured && !g.inCheck() && !m.promotion;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
