# Chess Coach

A personal chess trainer that runs entirely in the browser: **unlimited generated puzzles**, a bot to play against with a **live coach** that grades and explains every move, short strategy lessons, and progress tracking.

## Run it

```bash
python3 server.py
```

Then open http://localhost:3300. Or double-click `start.command` on a Mac. You only need Python 3, no other dependencies.

## Your data stays local

`server.py` serves the app on `127.0.0.1` only and saves your progress to `data/state.json` next to the code. That covers your rating, puzzle history, games, mistakes to review, and any game or puzzle still in progress. `data/` is git-ignored, so it is never committed or pushed. A copy is also kept in the browser's `localStorage` as a backup, and whichever copy is newer wins on load.

- **Back up or move your progress:** copy `data/state.json`.
- **Start fresh:** Progress → *Reset all progress*, or delete `data/state.json`.

## What's inside

| Tab | What it does |
|---|---|
| **Home** | Puzzle rating, streak, game accuracy, weakest tactic, and a "today's plan" built from your stats |
| **Puzzles** | Puzzles generated on the fly near your rating, filterable by theme. Three hint levels, an explanation of why a wrong move fails, and a step-by-step breakdown after each puzzle. Includes a **My mistakes** set built from your own games |
| **Play** | Eight bot levels (~400 to ~2400). The coach grades each move (best → blunder), explains what you missed, flags opening-principle slips, and finishes with a game review |
| **Learn** | Eleven short lessons (thinking routine, openings, tactics, mates, middlegame, endgames) that link straight into practice |
| **Progress** | Rating chart, success rate by tactic, recent games |

### How puzzles are generated

`js/generator.js` plays fast Stockfish-vs-Stockfish games from about 35 opening lines and slips in human-style mistakes. After each suspicious move it searches deeper. If the other side now has **exactly one** clearly winning move, that position becomes a puzzle. The solution is extended for as long as every move stays unique. `js/tactics.js` then tags the themes (fork, pin, skewer, discovered attack, back-rank mate, …), estimates difficulty, and writes the explanations.

## Structure

```
server.py       local server + saves progress to data/state.json
index.html      app shell
styles.css      design (D.A.R.W.I.N. HUD language: forest glass, Newsreader + Geist)
js/
  app.js        tabs, home, learn, progress
  puzzles.js    puzzle trainer
  generator.js  endless puzzle generator
  play.js       play vs bot + coach
  tactics.js    tactic detection, move grading, explanations
  engine.js     Stockfish worker wrapper
  board.js      chessground board wrapper
  store.js      localStorage persistence + rating
  learn.js      lesson content
lib/            vendored: Stockfish 10 (wasm), chess.js, chessground
```

## Credits & license

- [Stockfish](https://stockfishchess.org) 10 via [stockfish.js](https://github.com/nmrugg/stockfish.js) (GPL-3.0)
- [chessground](https://github.com/lichess-org/chessground), the lichess board (GPL-3.0), with cburnett pieces
- [chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause)

Because it bundles GPL-3.0 components, this project is released under GPL-3.0 (see `LICENSE`).
