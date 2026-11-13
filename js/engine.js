// Thin promise-based wrapper around a Stockfish web worker (UCI protocol).
// Every request is queued so one engine never runs two searches at once.

const wasm = typeof WebAssembly === 'object' &&
  WebAssembly.validate(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));

export class Engine {
  constructor(name = 'engine') {
    this.name = name;
    this.worker = new Worker(wasm ? 'lib/stockfish.wasm.js' : 'lib/stockfish.js');
    this.listeners = new Set();
    this.worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : String(e.data);
      for (const fn of [...this.listeners]) fn(line);
    };
    this.queue = Promise.resolve();
    this.skill = null;
    this.multipv = null;
    this.generation = 0; // bumps when callers want pending work dropped
    this.ready = this._raw('uci', 'uciok').then(() => this._raw('isready', 'readyok'));
  }

  _send(cmd) { this.worker.postMessage(cmd); }

  _raw(cmd, until) {
    return new Promise((resolve) => {
      const fn = (line) => {
        if (line.startsWith(until)) { this.listeners.delete(fn); resolve(line); }
      };
      this.listeners.add(fn);
      this._send(cmd);
    });
  }

  _enqueue(task) {
    const gen = this.generation;
    const p = this.queue.then(() => (gen === this.generation ? task() : null));
    this.queue = p.catch(() => null);
    return p;
  }

  /** Drop every queued (not yet started) request and stop the running one. */
  cancelAll() {
    this.generation++;
    this._send('stop');
  }

  async _setOptions({ skill = 20, multipv = 1 }) {
    if (this.skill !== skill) { this._send(`setoption name Skill Level value ${skill}`); this.skill = skill; }
    if (this.multipv !== multipv) { this._send(`setoption name MultiPV value ${multipv}`); this.multipv = multipv; }
  }

  /**
   * Analyse a position. Scores are from the side-to-move's point of view.
   * Returns { lines: [{ uci, pv, cp, mate, score, depth }], best }
   */
  analyze(fen, { depth = 12, multipv = 1, movetime = null, skill = 20 } = {}) {
    return this._enqueue(async () => {
      await this.ready;
      await this._setOptions({ skill, multipv });
      const lines = [];
      return new Promise((resolve) => {
        const fn = (line) => {
          if (line.startsWith('info') && line.includes(' pv ') && line.includes(' score ')) {
            const info = parseInfo(line);
            if (info) lines[info.multipv - 1] = info;
          } else if (line.startsWith('bestmove')) {
            this.listeners.delete(fn);
            const best = line.split(' ')[1];
            const clean = lines.filter(Boolean);
            resolve({ lines: clean, best: best && best !== '(none)' ? best : null });
          }
        };
        this.listeners.add(fn);
        this._send(`position fen ${fen}`);
        this._send(movetime ? `go movetime ${movetime}` : `go depth ${depth}`);
      });
    });
  }
}

function parseInfo(line) {
  const t = line.split(' ');
  const get = (k) => { const i = t.indexOf(k); return i >= 0 ? t[i + 1] : null; };
  const depth = +get('depth');
  const multipv = +(get('multipv') || 1);
  const si = t.indexOf('score');
  if (si < 0) return null;
  const kind = t[si + 1];
  const val = +t[si + 2];
  const pv = t.slice(t.indexOf('pv') + 1);
  const cp = kind === 'cp' ? val : null;
  const mate = kind === 'mate' ? val : null;
  return { depth, multipv, cp, mate, score: toScore(cp, mate), pv, uci: pv[0] };
}

/** Collapse cp/mate into one comparable number (side to move POV). */
export function toScore(cp, mate) {
  if (mate != null) return mate > 0 ? 100000 - mate * 100 : -100000 - mate * 100;
  return cp;
}

/** Win probability (0-100) for a centipawn score — same curve lichess uses. */
export function winPct(score) {
  const s = Math.max(-1500, Math.min(1500, score));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * s)) - 1);
}

export function formatScore({ cp, mate }, flip = false) {
  if (mate != null) { const m = flip ? -mate : mate; return (m > 0 ? '#' : '#-') + Math.abs(m); }
  const v = (flip ? -cp : cp) / 100;
  return (v > 0 ? '+' : '') + v.toFixed(1);
}
