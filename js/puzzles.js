// Puzzle trainer: serves generated puzzles near your rating, with 3-level hints,
// refutations for wrong moves, and a full explanation once solved.
import { Chess } from '../lib/chess.js';
import { Board } from './board.js';
import { Engine } from './engine.js';
import { PuzzleGenerator } from './generator.js';
import { uciToMove, THEMES, TRAINABLE, colorName, pvToSan, NAME } from './tactics.js';
import { store, save, recordPuzzle, addToPool } from './store.js';

const $ = (s, r = document) => r.querySelector(s);
const POOL_TARGET = 25;

export class PuzzleMode {
  constructor(root, { onChange } = {}) {
    this.root = root;
    this.onChange = onChange || (() => {});
    this.board = new Board($('#puzzle-board', root));
    this.board.onMove = (uci) => this.userMove(uci);
    this.refuter = null;
    this.current = null;
    this.waiting = false;
    this.gen = new PuzzleGenerator({
      onPuzzle: (p) => { addToPool(p); this.renderStatus(); if (this.waiting) this.next(); },
      onStatus: (s) => { this.genStatus = s; this.renderStatus(); },
    });
    this.gen.minRating = () => store.rating - 450; // don't fill the pool with puzzles far too easy for you
    this.gen.wanted =() => this.matching().length < POOL_TARGET || (this.waiting && this.matching().length === 0);
    this.buildThemeSelect();
    this.bind();
    this.gen.start();
    // Pick up an unfinished puzzle from last time
    const cp = store.currentPuzzle;
    if (cp?.p) this.load(cp.p, { recorded: cp.recorded });
  }

  markRecorded() {
    this.recorded = true;
    if (store.currentPuzzle) { store.currentPuzzle.recorded = true; save(); }
  }

  clearCurrent() { store.currentPuzzle = null; save(); }

  buildThemeSelect() {
    const sel = $('#theme', this.root);
    sel.innerHTML = '<option value="any">All themes (mixed)</option><option value="review">My mistakes (from games)</option>' +
      TRAINABLE.map((t) => `<option value="${t}">${THEMES[t].name}</option>`).join('');
    sel.value = store.settings.theme;
    sel.addEventListener('change', () => { this.setTheme(sel.value); });
  }

  setTheme(t) {
    store.settings.theme = t; save();
    $('#theme', this.root).value = t;
    this.next();
  }

  bind() {
    const r = this.root;
    $('#p-hint', r).addEventListener('click', () => this.hint());
    $('#p-next', r).addEventListener('click', () => this.next());
    $('#p-skip', r).addEventListener('click', () => { if (this.current && !this.finished) this.fail('skipped'); this.next(); });
    $('#p-solution', r).addEventListener('click', () => this.showSolution());
    $('#p-retry', r).addEventListener('click', () => this.retry());
  }

  matching() {
    const t = store.settings.theme;
    if (t === 'review') return store.review;
    return store.pool.filter((p) => t === 'any' || p.themes.includes(t) || (t === 'mate' && p.theme.startsWith('mate')));
  }

  /** Choose the puzzle whose rating sits closest to yours (with a little variety). */
  pickPuzzle() {
    const list = this.matching().filter((p) => !store.seen.includes(p.id));
    if (!list.length) return null;
    if (store.settings.theme === 'review') return list[0];
    const target = store.rating + (Math.random() * 200 - 60);
    list.sort((a, b) => Math.abs(a.rating - target) - Math.abs(b.rating - target));
    return list[Math.floor(Math.random() * Math.min(3, list.length))];
  }

  next() {
    const p = this.pickPuzzle();
    this.board.arrows([]);
    this.board.mark(null);
    if (!p) {
      this.waiting = true;
      this.current = null;
      this.board.lock();
      $('#p-prompt', this.root).innerHTML = store.settings.theme === 'review'
        ? '<h3>No mistakes to review</h3><p class="muted">When you make a mistake or blunder in a game, that position lands here so you can fix it.</p>'
        : '<h3 class="thinking">Building a fresh puzzle</h3><p>The engine is playing through games, hunting for a tactic that fits. Rare themes can take a minute.</p>';
      $('#p-explain', this.root).hidden = true;
      this.setButtons('waiting');
      this.renderStatus();
      return;
    }
    this.waiting = false;
    this.load(p);
  }

  load(p, { recorded = false } = {}) {
    this.current = p;
    this.step = 0; // index into solution
    this.mistakes = 0;
    this.hintLevel = 0;
    this.finished = false;
    this.recorded = recorded;
    this.ratingNote = null;
    store.currentPuzzle = { p, recorded };
    save();
    // remove from pool so it isn't served again (review puzzles stay until solved)
    if (p.source !== 'your-game') { store.pool = store.pool.filter((x) => x.id !== p.id); save(); }
    $('#p-explain', this.root).hidden = true;
    this.setButtons('solving');
    const solverColor = new Chess(p.fen).turn();
    this.solver = solverColor;
    if (p.prevFen) {
      // Show the opponent's mistake first, like a real game
      this.game = new Chess(p.prevFen);
      this.board.sync(this.game, { orientation: solverColor });
      setTimeout(() => {
        if (this.current !== p) return;
        const m = this.game.move(uciToMove(p.blunder));
        this.board.sync(this.game, { movable: solverColor, lastMove: [m.from, m.to] });
      }, 700);
    } else {
      this.game = new Chess(p.fen);
      this.board.sync(this.game, { movable: solverColor, orientation: solverColor });
    }
    const src = p.source === 'your-game' ? `<span class="pill" style="--acc:var(--peach)">From your game</span>` : '';
    const n = Math.ceil(p.solution.length / 2);
    $('#p-prompt', this.root).innerHTML = `
      <div class="p-head"><span class="side ${solverColor}"></span><h3>${colorName(solverColor)} to move</h3></div>
      <p>${p.prevFen ? `Your opponent just played <b>${p.blunderSan}</b>. Find the punishment.` : (p.note || 'Find the best move.')}</p>
      <div class="meta"><span class="chip">Rated ${p.rating}</span><span class="chip" style="--acc:var(--aqua)">${n} move${n > 1 ? 's' : ''}</span>${src}</div>`;
    $('#p-feedback', this.root).innerHTML = '';
    this.renderStatus();
  }

  setButtons(mode) {
    const r = this.root;
    $('#p-hint', r).hidden = mode !== 'solving';
    $('#p-skip', r).hidden = mode !== 'solving';
    $('#p-solution', r).hidden = mode !== 'failed';
    $('#p-retry', r).hidden = mode !== 'failed';
    $('#p-next', r).hidden = !(mode === 'done' || mode === 'failed');
  }

  userMove(uci) {
    const p = this.current;
    if (!p || this.finished) return;
    const expected = p.solution[this.step];
    const fenBefore = this.game.fen();
    let move;
    try { move = this.game.move(uciToMove(uci)); } catch { this.board.sync(this.game, { movable: this.solver }); return; }
    const isLast = this.step === p.solution.length - 1;
    const correct = uci === expected || (this.game.isCheckmate()) ||
      (expected.length === 5 && uci.slice(0, 4) === expected.slice(0, 4) && uci[4] === 'q' && expected[4] === 'q');

    if (!correct) {
      this.board.sync(this.game, { lastMove: [move.from, move.to] });
      this.board.mark(new Map([[move.to, 'wrong']]));
      this.mistakes++;
      this.fail('wrong');
      this.refute(fenBefore, uci);
      return;
    }
    this.board.sync(this.game, { lastMove: [move.from, move.to] });
    this.board.mark(new Map([[move.to, 'right']]));
    this.board.arrows([]);
    const stepInfo = p.steps?.[this.step];
    this.step++;
    if (isLast || this.game.isCheckmate()) return this.solve();
    $('#p-feedback', this.root).innerHTML = `<p class="good">✓ ${move.san} — ${stepInfo?.notes?.[0] ? stepInfo.notes[0] + '. ' : ''}Keep going!</p>`;
    // Opponent reply
    setTimeout(() => {
      if (this.current !== p) return;
      const reply = p.solution[this.step];
      const rm = this.game.move(uciToMove(reply));
      this.step++;
      this.board.mark(null);
      this.board.sync(this.game, { movable: this.solver, lastMove: [rm.from, rm.to] });
    }, 450);
  }

  async refute(fenAfterWrong, wrongUci) {
    const fb = $('#p-feedback', this.root);
    const g = new Chess(fenAfterWrong);
    const wrong = g.move(uciToMove(wrongUci));
    fb.innerHTML = `<p class="bad">✗ ${wrong.san} isn’t it.</p><p class="muted thinking">Checking why…</p>`;
    if (g.isGameOver()) { fb.innerHTML = `<p class="bad">✗ ${wrong.san} isn’t it.</p>`; return; }
    this.refuter = this.refuter || new Engine('refuter');
    const a = await this.refuter.analyze(g.fen(), { depth: 11, multipv: 1 });
    if (!a?.lines[0] || this.current == null) return;
    const l = a.lines[0];
    let why;
    if (l.mate != null && l.mate > 0) why = `It allows mate: ${pvToSan(g.fen(), l.pv, l.mate * 2)}.`;
    else if (l.score > 150) why = `Your opponent hits back with ${pvToSan(g.fen(), l.pv, 3)} and comes out on top.`;
    else if (l.score > -150) why = `The position stays roughly equal after ${pvToSan(g.fen(), l.pv, 2)} — the opponent’s mistake goes unpunished.`;
    else why = `It’s still good for you, but there was a much stronger, forcing move.`;
    fb.innerHTML = `<p class="bad">✗ ${wrong.san} isn’t it.</p><p>${why}</p>`;
    this.board.arrows([{ orig: l.uci.slice(0, 2), dest: l.uci.slice(2, 4), brush: 'red' }]);
  }

  fail(reason) {
    if (!this.recorded) {
      this.markRecorded();
      const delta = recordPuzzle(this.current, false);
      this.ratingNote = delta;
      this.onChange();
    }
    if (reason === 'wrong') this.setButtons('failed');
    this.renderStatus();
  }

  retry() {
    // Undo the wrong move and let the user keep trying (rating already counted)
    this.game.undo();
    this.board.mark(null);
    this.board.arrows([]);
    this.board.sync(this.game, { movable: this.solver });
    $('#p-feedback', this.root).innerHTML = '<p class="muted">Try again — look for checks, captures and threats.</p>';
    this.setButtons('solving');
  }

  hint() {
    const p = this.current;
    if (!p) return;
    this.hintLevel++;
    const uci = p.solution[this.step];
    const piece = this.game.get(uci.slice(0, 2));
    const t = THEMES[p.theme] || THEMES.materialGain;
    const fb = $('#p-feedback', this.root);
    if (this.hintLevel === 1) {
      fb.innerHTML = `<p><b>Hint 1:</b> Theme — <b>${t.name}</b>. ${t.tip}</p>`;
    } else if (this.hintLevel === 2) {
      this.board.mark(new Map([[uci.slice(0, 2), 'hint']]));
      fb.innerHTML = `<p><b>Hint 2:</b> Move your <b>${NAME[piece.type]}</b> on ${uci.slice(0, 2)}.</p>`;
      if (!this.recorded) { this.markRecorded(); this.ratingNote = recordPuzzle(p, false); this.onChange(); }
    } else {
      this.board.arrows([{ orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush: 'blue' }]);
      fb.innerHTML = `<p><b>Hint 3:</b> Play the arrow — then understand why it works.</p>`;
    }
    this.renderStatus();
  }

  async showSolution() {
    const p = this.current;
    this.finished = true;
    this.clearCurrent();
    if (this.game.fen() !== p.fen) {
      // rewind to the puzzle start
      this.game = new Chess(p.fen);
    }
    this.board.mark(null);
    this.board.arrows([]);
    this.board.sync(this.game, { lastMove: null });
    for (const uci of p.solution) {
      await new Promise((r) => setTimeout(r, 650));
      if (this.current !== p) return;
      const m = this.game.move(uciToMove(uci));
      this.board.sync(this.game, { lastMove: [m.from, m.to] });
    }
    this.explain(false);
    this.setButtons('done');
  }

  solve() {
    const p = this.current;
    this.finished = true;
    this.clearCurrent();
    this.board.lock();
    if (!this.recorded) {
      this.recorded = true;
      const clean = this.hintLevel < 2 && this.mistakes === 0;
      this.ratingNote = recordPuzzle(p, clean);
      this.onChange();
    }
    if (p.source === 'your-game' && this.mistakes === 0) { store.review = store.review.filter((x) => x.id !== p.id); save(); }
    $('#p-feedback', this.root).innerHTML = `<p class="good big">${this.mistakes || this.hintLevel >= 2 ? 'Got there.' : 'Solved.'}</p>`;
    this.explain(true);
    this.setButtons('done');
    this.renderStatus();
  }

  explain(solved) {
    const p = this.current;
    const t = THEMES[p.theme] || THEMES.materialGain;
    const ex = $('#p-explain', this.root);
    const steps = (p.steps || []).map((s) => `<li class="${s.mine ? 'mine' : 'theirs'}"><span><b>${s.san}</b>${s.mine && s.notes?.length ? ` · ${s.notes.join(', ')}` : s.mine ? '' : ' · forced reply'}</span></li>`).join('');
    const themes = p.themes.filter((x) => THEMES[x]).map((x) => `<button class="chip" data-theme="${x}" title="Train more ${THEMES[x].name}">${THEMES[x].icon} ${THEMES[x].name}</button>`).join('');
    const d = this.ratingNote;
    ex.hidden = false;
    ex.innerHTML = `
      <div class="ex-head"><span class="ex-icon">${t.icon}</span><div><h4>${t.name}</h4><p class="muted small">${t.blurb}</p></div>
      ${d != null ? `<span class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d}</span>` : ''}</div>
      ${p.blunderSan ? `<p>Your opponent’s <b>${p.blunderSan}</b> was the mistake that made this possible.</p>` : p.note ? `<p>${p.note}</p>` : ''}
      <ol class="sol">${steps}</ol>
      <p class="tipline"><b>Remember</b>${t.tip}</p>
      <div class="chips">${themes}</div>`;
    ex.querySelectorAll('[data-theme]').forEach((b) => b.addEventListener('click', () => {
      const th = b.dataset.theme;
      this.setTheme(TRAINABLE.includes(th) ? th : th.startsWith('mate') ? 'mate' : 'any');
    }));
    if (!solved) $('#p-feedback', this.root).innerHTML = '<p class="muted">Here’s the solution. Study it, then try the next one.</p>';
  }

  renderStatus() {
    const s = this.genStatus || {};
    const n = store.settings.theme === 'review' ? store.review.length : this.matching().length;
    $('#p-rating', this.root).textContent = store.rating;
    $('#p-pool', this.root).textContent = store.settings.theme === 'review'
      ? `${n} mistake${n === 1 ? '' : 's'} to review`
      : `${n} ready${s.checked ? ` · ${s.checked.toLocaleString()} positions scanned` : ''}`;
    const total = store.pool.length;
    const es = document.getElementById('engine-status');
    if (es) es.textContent = s.idle ? `Engine ready · ${total} puzzles queued` : `Generating · ${total} puzzles queued`;
    document.querySelectorAll('.dot').forEach((d) => d.classList.toggle('busy', !s.idle));
  }
}
