// Wrapper around chessground (lichess's board) bound to a chess.js game.
import { Chessground } from '../lib/chessground.min.js';

export function dests(game) {
  const map = new Map();
  for (const m of game.moves({ verbose: true })) {
    if (!map.has(m.from)) map.set(m.from, []);
    map.get(m.from).push(m.to);
  }
  return map;
}

const colorLong = (c) => (c === 'w' ? 'white' : 'black');

export class Board {
  constructor(el) {
    this.el = el;
    this.onMove = null; // (uci) => void
    this.cg = Chessground(el, {
      animation: { enabled: true, duration: 220 },
      highlight: { lastMove: true, check: true },
      movable: { free: false, showDests: true, events: { after: (o, d) => this._after(o, d) } },
      premovable: { enabled: false },
      draggable: { showGhost: true },
      drawable: {
        enabled: true,
        brushes: {
          green: { key: 'g', color: '#2f8f4e', opacity: 0.85, lineWidth: 10 },
          red: { key: 'r', color: '#c8452f', opacity: 0.85, lineWidth: 10 },
          blue: { key: 'b', color: '#2c6db3', opacity: 0.75, lineWidth: 10 },
          yellow: { key: 'y', color: '#e2a33a', opacity: 0.9, lineWidth: 10 },
          paleGreen: { key: 'pg', color: '#2f8f4e', opacity: 0.4, lineWidth: 14 },
        },
      },
    });
    new ResizeObserver(() => this.cg.redrawAll()).observe(el);
  }

  /** Sync the board to a chess.js game. `movable` = color letter the user may move, or null. */
  sync(game, { movable = null, lastMove = null, orientation } = {}) {
    this.game = game;
    const cfg = {
      fen: game.fen(),
      turnColor: colorLong(game.turn()),
      check: game.inCheck() ? colorLong(game.turn()) : false,
      lastMove: lastMove || undefined,
      movable: {
        color: movable && game.turn() === movable ? colorLong(movable) : undefined,
        dests: movable && game.turn() === movable ? dests(game) : new Map(),
      },
    };
    if (!lastMove) cfg.lastMove = undefined;
    if (orientation) cfg.orientation = colorLong(orientation);
    this.cg.set(cfg);
    if (!lastMove) this.cg.state.lastMove = undefined;
  }

  lock() { this.cg.set({ movable: { color: undefined, dests: new Map() } }); }

  arrows(shapes) { this.cg.setAutoShapes(shapes || []); }

  mark(map) { this.cg.set({ highlight: { custom: map || new Map() } }); }

  async _after(orig, dest) {
    const piece = this.game.get(orig);
    let promo = '';
    if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) {
      promo = await this._pickPromotion(piece.color, dest);
      if (!promo) { this.sync(this.game, { movable: piece.color }); return; }
    }
    this.onMove?.(orig + dest + promo);
  }

  _pickPromotion(color, dest) {
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.className = 'promo';
      const glyph = color === 'w' ? { q: '♕', r: '♖', b: '♗', n: '♘' } : { q: '♛', r: '♜', b: '♝', n: '♞' };
      box.innerHTML = '<div class="promo-card"><p>Promote to</p><div class="promo-row">' +
        Object.entries(glyph).map(([k, g]) => `<button data-p="${k}" title="${k}">${g}</button>`).join('') +
        '</div><button class="promo-cancel">Cancel</button></div>';
      box.addEventListener('click', (e) => {
        const p = e.target.closest('button')?.dataset.p;
        if (e.target.closest('button')) { box.remove(); resolve(p || ''); }
      });
      this.el.parentElement.appendChild(box);
    });
  }
}
