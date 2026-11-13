// Play vs the engine with a live coach that grades and explains every move.
import { Chess } from '../lib/chess.js';
import { Engine, winPct, formatScore } from './engine.js';
import { Board } from './board.js';
import {
  uciToMove, classify, explainMove, CLASSES, moveAccuracy, openingTips, colorName, pvToSan,
  puzzleThemes, primaryTheme,
} from './tactics.js';
import { store, save, recordGame, addReview } from './store.js';

export const LEVELS = [
  { name: 'Newcomer', elo: 400, skill: 0, depth: 3, random: 0.45 },
  { name: 'Beginner', elo: 650, skill: 0, depth: 4, random: 0.25 },
  { name: 'Casual', elo: 900, skill: 2, depth: 5, random: 0.1 },
  { name: 'Club', elo: 1150, skill: 5, depth: 6, random: 0 },
  { name: 'Intermediate', elo: 1400, skill: 9, depth: 8, random: 0 },
  { name: 'Strong', elo: 1700, skill: 13, depth: 10, random: 0 },
  { name: 'Expert', elo: 2000, skill: 17, depth: 12, random: 0 },
  { name: 'Master', elo: 2400, skill: 20, depth: 15, random: 0 },
];

const $ = (s, r = document) => r.querySelector(s);

export class PlayMode {
  constructor(root) {
    this.root = root;
    this.board = new Board($('#play-board', root));
    this.board.onMove = (uci) => this.userMove(uci);
    this.bot = new Engine('bot');
    this.coach = new Engine('coach');
    this.evals = new Map(); // fen -> analysis (side to move POV)
    this.viewIndex = null;
    this.bind();
    this.renderLevel();
    if (store.currentGame?.records) this.resume(store.currentGame);
    else this.newGame();
  }

  bind() {
    const r = this.root;
    $('#level', r).addEventListener('input', (e) => { store.settings.level = +e.target.value; save(); this.renderLevel(); });
    r.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => {
      store.settings.color = b.dataset.color; save();
      r.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('on', x === b));
    }));
    r.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('on', x.dataset.color === store.settings.color));
    $('#new-game', r).addEventListener('click', () => this.newGame());
    $('#hint', r).addEventListener('click', () => this.hint());
    $('#undo', r).addEventListener('click', () => this.undo());
    $('#resign', r).addEventListener('click', () => this.finish('resign'));
    $('#flip', r).addEventListener('click', () => { this.board.cg.toggleOrientation(); });
    $('#coach-toggle', r).addEventListener('change', (e) => { store.settings.coach = e.target.checked; save(); this.renderFeedback(); });
    $('#coach-toggle', r).checked = store.settings.coach;
    $('#moves', r).addEventListener('click', (e) => {
      const i = e.target.closest('[data-i]')?.dataset.i;
      if (i != null) this.view(+i);
    });
    $('#back-live', r).addEventListener('click', () => this.view(null));
  }

  renderLevel() {
    const lv = LEVELS[store.settings.level];
    $('#level', this.root).value = store.settings.level;
    $('#level-name', this.root).textContent = `${lv.name} · ~${lv.elo}`;
  }

  newGame() {
    let color = store.settings.color;
    if (color === 'r') color = Math.random() < 0.5 ? 'w' : 'b';
    this.start({ color, level: store.settings.level, records: [], hintsUsed: 0 });
    $('#feedback', this.root).innerHTML = `<p class="muted">You’re playing ${colorName(color)} against <b>${LEVELS[this.level].name}</b>. ${color === 'w' ? 'Your move.' : 'The bot moves first.'}</p>`;
  }

  /** Start a game, either fresh or resumed from a saved one. */
  start({ color, level, records, hintsUsed }) {
    this.color = color;
    this.level = level;
    this.game = new Chess();
    this.records = []; // per-ply: { uci, san, color, cls, loss, text, best, fenBefore }
    for (const r of records) {
      try { this.game.move(uciToMove(r.uci)); this.records.push({ ...r }); } catch { break; }
    }
    this.over = false;
    this.hintsUsed = hintsUsed || 0;
    this.viewIndex = null;
    this.bot.cancelAll();
    this.coach.cancelAll();
    $('#summary', this.root).hidden = true;
    $('#tip', this.root).hidden = true;
    $('#back-live', this.root).hidden = true;
    this.board.arrows([]);
    const last = this.records[this.records.length - 1];
    this.board.sync(this.game, { movable: color, orientation: color, lastMove: last ? [last.uci.slice(0, 2), last.uci.slice(2, 4)] : null });
    this.renderMoves();
    this.updateEval(0);
    $('#status', this.root).textContent = this.game.turn() === color ? 'Your move' : 'Bot is thinking…';
    this.persist();
    this.analyzeCurrent();
    // Grade any moves that weren't finished before the reload
    for (const r of this.records) if (r.color === color && !r.cls) { r.pending = true; this.grade(r); }
    if (this.game.turn() !== color) this.botMove();
  }

  resume(saved) {
    this.start(saved);
    const n = Math.ceil(this.records.length / 2);
    $('#feedback', this.root).innerHTML = `<p class="muted">Welcome back. Your game vs <b>${LEVELS[this.level].name}</b> is restored at move ${n || 1}.</p>`;
  }

  /** Save the in-progress game so a reload (or closing the app) picks up where you left off. */
  persist() {
    if (this.over) { store.currentGame = null; save(); return; }
    store.currentGame = {
      color: this.color, level: this.level, hintsUsed: this.hintsUsed, t: Date.now(),
      records: this.records.map(({ pending, ...r }) => r),
    };
    save();
  }

  /** Background analysis of the live position (feeds the eval bar + grading). */
  async analyzeCurrent() {
    const fen = this.game.fen();
    if (this.game.isGameOver()) return null;
    if (this.evals.has(fen)) { this.showEval(fen); return this.evals.get(fen); }
    const a = await this.coach.analyze(fen, { depth: 13, multipv: 1 });
    if (!a) return null;
    this.evals.set(fen, a);
    if (this.game.fen() === fen) this.showEval(fen);
    return a;
  }

  async analysis(fen) {
    if (this.evals.has(fen)) return this.evals.get(fen);
    const a = await this.coach.analyze(fen, { depth: 13, multipv: 1 });
    if (a) this.evals.set(fen, a);
    return a;
  }

  showEval(fen) {
    const a = this.evals.get(fen);
    if (!a?.lines[0]) return;
    const l = a.lines[0];
    const whiteToMove = fen.split(' ')[1] === 'w';
    const whiteScore = whiteToMove ? l.score : -l.score;
    this.updateEval(whiteScore, formatScore(l, !whiteToMove));
  }

  updateEval(whiteScore, label = '0.0') {
    const pct = winPct(whiteScore);
    const bar = $('#evalbar', this.root);
    bar.style.setProperty('--white', `${this.color === 'b' ? 100 - pct : pct}%`);
    bar.classList.toggle('flipped', this.color === 'b');
    $('#evaltext', this.root).textContent = label;
  }

  async userMove(uci) {
    if (this.over || this.viewIndex != null) return;
    const fenBefore = this.game.fen();
    let move;
    try { move = this.game.move(uciToMove(uci)); } catch { this.board.sync(this.game, { movable: this.color }); return; }
    const rec = { uci, san: move.san, color: move.color, fenBefore, fenAfter: this.game.fen(), pending: true };
    this.records.push(rec);
    this.persist();
    this.board.arrows([]);
    this.board.sync(this.game, { lastMove: [move.from, move.to] });
    this.renderMoves();
    const tip = openingTips(this.game.history({ verbose: true }), this.color);
    $('#tip', this.root).hidden = !tip;
    if (tip) $('#tip-text', this.root).textContent = tip;
    this.grade(rec);
    if (!this.checkEnd()) this.botMove();
  }

  async grade(rec) {
    if (!store.settings.coach) $('#feedback', this.root).innerHTML = '<p class="muted">Coach is off — your moves will be graded in the game review.</p>';
    else $('#feedback', this.root).innerHTML = '<p class="muted thinking">Coach is looking at your move…</p>';
    const before = await this.analysis(rec.fenBefore);
    const afterGame = new Chess(rec.fenAfter);
    let after = null;
    if (!afterGame.isGameOver()) after = await this.analysis(rec.fenAfter);
    if (!before?.lines[0]) return;
    const best = before.lines[0];
    const scoreBefore = best.score;
    let scoreAfter;
    if (afterGame.isCheckmate()) scoreAfter = 100000;
    else if (afterGame.isGameOver()) scoreAfter = 0;
    else scoreAfter = -after.lines[0].score;
    const { cls, loss } = classify(scoreBefore, scoreAfter, rec.uci === best.uci);
    const isBook = this.records.indexOf(rec) < 8 && loss < 3 && Math.abs(scoreBefore) < 80;
    rec.cls = isBook && cls !== 'best' ? 'book' : cls;
    rec.loss = loss;
    rec.best = best.uci;
    rec.bestLine = best.pv;
    rec.text = explainMove({
      fenBefore: rec.fenBefore, played: rec.uci, best: best.uci, bestLine: best.pv,
      replyLine: after?.lines[0]?.pv || [], replyMate: after?.lines[0]?.mate, cls,
    });
    rec.pending = false;
    if (this.records.includes(rec)) this.persist();
    // Your mistakes become review puzzles
    if ((cls === 'mistake' || cls === 'blunder') && best.score > 150) {
      const solution = [best.uci];
      const { tags, steps } = puzzleThemes(rec.fenBefore, solution);
      addReview({
        id: 'r' + Date.now().toString(36), source: 'your-game', fen: rec.fenBefore, prevFen: null,
        solution, steps, themes: tags, theme: primaryTheme(tags), rating: store.rating, created: Date.now(),
        note: `In your game you played ${rec.san} (${CLASSES[cls].label.toLowerCase()}).`,
      });
    }
    this.renderMoves();
    if (this.records[this.records.length - 1] === rec || this.records[this.records.length - 2] === rec) this.renderFeedback(rec);
  }

  renderFeedback(rec = [...this.records].reverse().find((r) => r.color === this.color && !r.pending)) {
    const el = $('#feedback', this.root);
    if (!rec) return;
    if (!store.settings.coach && !this.over) { el.innerHTML = '<p class="muted">Coach is off — your moves will be graded in the game review.</p>'; this.board.arrows([]); return; }
    const c = CLASSES[rec.cls];
    el.innerHTML = `<div class="grade" style="--gc:${c.color}"><span class="badge">${c.sym}</span>
      <div><b>${rec.san}</b> is ${/^[aeiou]/i.test(c.label) ? 'an' : 'a'} <b>${c.label.toLowerCase()}</b> move</div></div>
      <p>${rec.text || ''}</p>`;
    if (['inaccuracy', 'mistake', 'blunder'].includes(rec.cls) && this.viewIndex == null) {
      const shapes = [{ orig: rec.uci.slice(0, 2), dest: rec.uci.slice(2, 4), brush: 'red' }];
      if (rec.best) shapes.push({ orig: rec.best.slice(0, 2), dest: rec.best.slice(2, 4), brush: 'green' });
      this.board.arrows(shapes);
      if (!this.over && rec.cls !== 'inaccuracy') {
        el.insertAdjacentHTML('beforeend', '<button class="btn small ghost" id="try-again" style="margin-top:10px"><svg class="ic"><use href="#i-undo"/></svg>Take it back and try again</button>');
        $('#try-again', el).addEventListener('click', () => this.undo());
      }
    }
  }

  async botMove() {
    const fen = this.game.fen();
    const lv = LEVELS[this.level];
    $('#status', this.root).textContent = 'Bot is thinking…';
    const started = Date.now();
    let uci;
    if (lv.random > 0) {
      const a = await this.bot.analyze(fen, { depth: lv.depth, multipv: 5, skill: 20 });
      if (!a) return;
      const ls = a.lines;
      uci = ls[0].uci;
      if (Math.random() < lv.random && ls.length > 1) {
        // human-ish slip: choose among the alternatives, weaker ones less often
        uci = ls[1 + Math.floor(Math.random() * Math.random() * (ls.length - 1))].uci;
      }
    } else {
      const a = await this.bot.analyze(fen, { depth: lv.depth, multipv: 1, skill: lv.skill });
      if (!a) return;
      uci = a.best;
    }
    // Small natural delay so moves don't snap instantly
    const wait = 350 + Math.random() * 400 - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (this.game.fen() !== fen || this.over) return;
    const move = this.game.move(uciToMove(uci));
    this.records.push({ uci, san: move.san, color: move.color, fenBefore: fen, fenAfter: this.game.fen(), bot: true });
    this.persist();
    $('#status', this.root).textContent = 'Your move';
    if (this.viewIndex == null) this.board.sync(this.game, { movable: this.color, lastMove: [move.from, move.to] });
    this.renderMoves();
    this.analyzeCurrent();
    this.checkEnd();
  }

  async hint() {
    if (this.over || this.game.turn() !== this.color) return;
    this.hintsUsed++;
    this.persist();
    const a = await this.analysis(this.game.fen());
    if (!a?.best) return;
    this.board.arrows([{ orig: a.best.slice(0, 2), dest: a.best.slice(2, 4), brush: 'blue' }]);
    $('#feedback', this.root).innerHTML = `<p><b>Hint:</b> the engine likes <b>${pvToSan(this.game.fen(), a.lines[0].pv, 1)}</b>. Before you play it, ask yourself <i>why</i> — what does it attack or defend?</p>`;
  }

  undo() {
    if (this.over) return;
    this.bot.cancelAll();
    // Pop back to the position before the user's last move
    while (this.records.length) {
      const r = this.records.pop();
      this.game.undo();
      if (r.color === this.color) break;
    }
    this.persist();
    this.view(null);
    this.board.arrows([]);
    $('#feedback', this.root).innerHTML = '<p class="muted">Move taken back. Take your time — checks, captures, threats.</p>';
    if (this.game.turn() !== this.color) this.botMove();
    else this.analyzeCurrent();
  }

  checkEnd() {
    const g = this.game;
    if (!g.isGameOver()) return false;
    let result;
    if (g.isCheckmate()) result = g.turn() === this.color ? 'loss' : 'win';
    else result = 'draw';
    this.finish(result);
    return true;
  }

  async finish(result) {
    if (this.over) return;
    if (result === 'resign') result = 'loss';
    this.over = true;
    this.persist(); // clears the saved in-progress game
    this.board.lock();
    this.bot.cancelAll();
    const label = { win: 'You won.', loss: 'You lost.', draw: 'Draw.' }[result];
    $('#status', this.root).textContent = label;
    const sum = $('#summary', this.root);
    sum.hidden = false;
    sum.innerHTML = `<h3>${label}</h3><p class="muted thinking">Reviewing your game…</p>`;
    // Wait for any pending grades
    const mine = this.records.filter((r) => r.color === this.color);
    for (let i = 0; i < 60 && mine.some((r) => r.pending); i++) await new Promise((r) => setTimeout(r, 250));
    const graded = mine.filter((r) => !r.pending && r.cls);
    const acc = graded.length ? graded.reduce((s, r) => s + moveAccuracy(r.loss), 0) / graded.length : 0;
    const counts = {};
    for (const r of graded) counts[r.cls] = (counts[r.cls] || 0) + 1;
    recordGame({ t: Date.now(), result, accuracy: Math.round(acc), level: this.level, color: this.color, counts, moves: this.game.history().length, hints: this.hintsUsed });
    const worst = graded.filter((r) => ['blunder', 'mistake'].includes(r.cls)).sort((a, b) => b.loss - a.loss).slice(0, 3);
    const lesson = gameLesson(graded, result);
    sum.innerHTML = `<h3>${label}</h3>
      <div class="acc"><div class="ring" style="--acc:var(--mint);--v:${Math.round(acc)}"><span class="num">${Math.round(acc)}%</span></div>
        <div><b>Accuracy</b><small class="muted" style="display:block">${graded.length} of your moves graded${this.hintsUsed ? ` · ${this.hintsUsed} hint${this.hintsUsed > 1 ? 's' : ''}` : ''}</small></div></div>
      <div class="counts">${['best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'blunder'].map((k) =>
        `<span style="--gc:${CLASSES[k].color}"><i>${CLASSES[k].sym}</i>${counts[k] || 0} ${CLASSES[k].label}</span>`).join('')}</div>
      ${worst.length ? `<h4>Key moments</h4><ul class="moments">${worst.map((r) =>
        `<li data-i="${this.records.indexOf(r)}"><b>${r.san}</b> — ${CLASSES[r.cls].label}. ${r.text}</li>`).join('')}</ul>
        <p class="muted small">These positions were added to <b>Puzzles → My mistakes</b> so you can drill them.</p>` : ''}
      <div class="lesson-box"><b>Coach’s takeaway</b>${lesson}</div>
      <button class="btn primary" id="again">Play again</button>`;
    sum.querySelectorAll('.moments li').forEach((li) => li.addEventListener('click', () => this.view(+li.dataset.i)));
    $('#again', sum).addEventListener('click', () => this.newGame());
    this.renderMoves();
  }

  /** Browse history: i = record index to show the position after, null = live. */
  view(i) {
    this.viewIndex = i;
    $('#back-live', this.root).hidden = i == null;
    if (i == null) {
      const last = this.records[this.records.length - 1];
      const lm = last ? [last.uci.slice(0, 2), last.uci.slice(2, 4)] : null;
      this.board.sync(this.game, { movable: this.over ? null : this.color, lastMove: lm });
      this.board.arrows([]);
      this.showEval(this.game.fen());
    } else {
      const r = this.records[i];
      const g = new Chess(r.fenAfter);
      this.board.sync(g, { lastMove: [r.uci.slice(0, 2), r.uci.slice(2, 4)] });
      this.showEval(r.fenAfter);
      if (r.cls) this.renderFeedback(r);
      if (r.best && ['inaccuracy', 'mistake', 'blunder'].includes(r.cls)) {
        this.board.arrows([{ orig: r.best.slice(0, 2), dest: r.best.slice(2, 4), brush: 'green' }]);
      }
    }
    this.renderMoves();
  }

  renderMoves() {
    const el = $('#moves', this.root);
    let html = '';
    this.records.forEach((r, i) => {
      if (r.color === 'w' || i === 0) html += `<span class="num">${Math.floor((new Chess(r.fenBefore)).moveNumber())}.${r.color === 'b' ? '..' : ''}</span>`;
      const c = r.cls ? CLASSES[r.cls] : null;
      const showCls = c && (store.settings.coach || this.over);
      html += `<span class="mv ${this.viewIndex === i ? 'cur' : ''}" data-i="${i}">${r.san}${showCls && ['inaccuracy', 'mistake', 'blunder', 'best'].includes(r.cls) ? `<i style="color:${c.color}">${c.sym}</i>` : ''}</span>`;
    });
    el.innerHTML = html || '<span class="muted">No moves yet</span>';
    el.scrollTop = el.scrollHeight;
  }
}

function gameLesson(graded, result) {
  const blunders = graded.filter((r) => r.cls === 'blunder');
  const hanging = blunders.filter((r) => /hanging|takes it/.test(r.text || ''));
  const missed = graded.filter((r) => /You missed/.test(r.text || ''));
  if (hanging.length >= 2) return 'You left pieces undefended more than once. Before every move, do a “blunder check”: after my move, can they capture anything for free?';
  if (missed.length >= 2) return 'You missed tactics your opponent allowed. Each turn, scan for checks, captures and threats (CCT) — for you first, then for them.';
  if (blunders.length >= 2) return 'A few big swings decided this game. Slow down on moves where pieces are in contact — those are where blunders live.';
  if (result === 'win') return 'Clean game! Next time try one level up, or play the same level as the other color.';
  if (graded.length < 10) return 'Short game — when you lose quickly it’s usually the opening. Revisit the Opening Principles lesson.';
  return 'Solid effort. Pick your biggest mistake above and ask: what was my opponent threatening that I didn’t see?';
}
