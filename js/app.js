import { store, streak, weakThemes, today, resetAll } from './store.js';
import { PuzzleMode } from './puzzles.js';
import { PlayMode, LEVELS } from './play.js';
import { LESSONS, DAILY_TIPS } from './learn.js';
import { THEMES } from './tactics.js';

const $ = (s, r = document) => r.querySelector(s);
let puzzles, play;

function show(tab) {
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${tab}`));
  document.querySelectorAll('nav [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.body.dataset.tab = tab;
  if (tab === 'play' && !play) play = new PlayMode($('#view-play'));
  if (tab === 'puzzles' && !puzzles.current && !puzzles.waiting) puzzles.next();
  if (tab === 'home') renderHome();
  if (tab === 'progress') renderProgress();
  history.replaceState(null, '', `#${tab}`);
}

function go(tab, opts = {}) {
  show(tab);
  if (tab === 'puzzles' && opts.theme) puzzles.setTheme(opts.theme);
}

// ---------- Home ----------
function renderHome() {
  const el = $('#view-home');
  const d = store.days[today()] || { puzzles: 0, games: 0 };
  const weak = weakThemes()[0];
  const tip = DAILY_TIPS[Math.floor(Date.now() / 864e5) % DAILY_TIPS.length];
  const games = store.games.slice(-10);
  const avgAcc = games.length ? Math.round(games.reduce((s, g) => s + g.accuracy, 0) / games.length) : null;
  const plan = coachPlan();
  const now = new Date();
  const hr = now.getHours();
  $('#h-date', el).textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('#h-greet', el).textContent = `${hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'}. Let’s sharpen up.`;
  $('#h-rating', el).textContent = store.rating;
  const hist = store.ratingHistory;
  const weekAgo = hist.find((x) => x.t > Date.now() - 7 * 864e5) || hist[0];
  const diff = store.rating - weekAgo.r;
  const tr = $('#h-trend', el);
  tr.textContent = diff ? `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)} this week` : 'new';
  tr.className = `trend num ${diff > 0 ? 'up' : diff < 0 ? 'down' : 'muted'}`;
  $('#h-spark', el).innerHTML = sparkline(hist.slice(-40).map((x) => x.r), 240, 44);
  const st = streak();
  $('#h-streak', el).textContent = st;
  $('#h-ring', el).style.setProperty('--v', Math.min(100, (st / 7) * 100));
  $('#h-today', el).textContent = `Today: ${d.puzzles} puzzle${d.puzzles === 1 ? '' : 's'} · ${d.games} game${d.games === 1 ? '' : 's'}`;
  $('#h-acc', el).textContent = avgAcc == null ? '—' : avgAcc + '%';
  $('#h-acc-ring', el).style.setProperty('--v', avgAcc || 0);
  $('#h-tip', el).textContent = tip;
  $('#h-plan', el).innerHTML = plan.map((p) =>
    `<li><button class="plan-item" style="--c:${p.color}" data-go="${p.tab}" ${p.theme ? `data-theme="${p.theme}"` : ''}><span class="pi-icon"><svg class="ic"><use href="#${p.icon}"/></svg></span><span><b>${p.title}</b><small>${p.why}</small></span><span class="arrow"><svg class="ic"><use href="#i-chev"/></svg></span></button></li>`).join('');
  $('#h-plan', el).querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go, { theme: b.dataset.theme })));
  $('#h-weak', el).textContent = weak ? `${THEMES[weak.theme]?.name || weak.theme} · ${Math.round(weak.rate * 100)}%` : 'Still learning you';
}

function coachPlan() {
  const plan = [];
  const d = store.days[today()] || { puzzles: 0, games: 0 };
  const weak = weakThemes().filter((w) => THEMES[w.theme] && w.rate < 0.65)[0];
  if (store.puzzlesDone === 0) plan.push({ tab: 'learn', icon: 'i-learn', color: 'var(--aqua)', title: 'Read “How to think on every move”', why: 'Five minutes. It will save you a lot of blunders.' });
  if (d.puzzles < 10) plan.push({ tab: 'puzzles', theme: 'any', icon: 'i-puzzle', color: 'var(--gold)', title: `Solve ${10 - d.puzzles} more puzzle${10 - d.puzzles === 1 ? '' : 's'} today`, why: 'Daily tactics are the fastest way to improve.' });
  if (weak) plan.push({ tab: 'puzzles', theme: weak.theme, icon: 'i-target', color: 'var(--rose)', title: `Train your weak spot: ${THEMES[weak.theme].name}`, why: `You solve ${Math.round(weak.rate * 100)}% of these. Let’s fix that.` });
  if (store.review.length) plan.push({ tab: 'puzzles', theme: 'review', icon: 'i-undo', color: 'var(--peach)', title: `Fix ${store.review.length} mistake${store.review.length === 1 ? '' : 's'} from your games`, why: 'Replay the positions where you went wrong.' });
  if (d.games < 1) {
    const lv = LEVELS[store.settings.level];
    plan.push({ tab: 'play', icon: 'i-play', color: 'var(--mint)', title: `Play a game vs ${lv.name}`, why: 'The coach grades every move and explains mistakes.' });
  }
  const recent = store.games.slice(-3);
  if (recent.length === 3 && recent.every((g) => g.result === 'win')) plan.push({ tab: 'play', icon: 'i-chart', color: 'var(--mint)', title: 'You won 3 in a row. Level up!', why: 'Raise the bot level in Play.' });
  return plan.slice(0, 4);
}

// ---------- Progress ----------
function renderProgress() {
  const el = $('#view-progress');
  const hist = store.ratingHistory.map((x) => x.r);
  $('#pr-chart', el).innerHTML = hist.length > 1 ? sparkline(hist.slice(-150), 900, 200, true) : '<p class="empty">Solve a few puzzles to see your rating chart.</p>';
  $('#pr-rating', el).textContent = store.rating;
  $('#pr-peak', el).textContent = Math.max(...hist);
  $('#pr-solved', el).textContent = `${store.puzzlesSolved} / ${store.puzzlesDone}`;
  $('#pr-rate', el).textContent = store.puzzlesDone ? Math.round((store.puzzlesSolved / store.puzzlesDone) * 100) + '%' : '—';
  const rows = Object.entries(store.themeStats).filter(([t]) => THEMES[t])
    .map(([t, v]) => ({ t, n: v.s + v.f, rate: v.s / (v.s + v.f) })).sort((a, b) => b.n - a.n);
  $('#pr-themes', el).innerHTML = rows.length ? rows.map((r) => `
    <div class="trow"><span class="tname">${THEMES[r.t].icon} ${THEMES[r.t].name}</span>
    <span class="tbar"><i style="width:${Math.round(r.rate * 100)}%; background:${r.rate < 0.5 ? 'var(--rose)' : r.rate < 0.7 ? 'var(--gold)' : 'var(--mint)'}"></i></span>
    <span class="tnum">${Math.round(r.rate * 100)}% <small>/${r.n}</small></span>
    <button class="chip" style="--acc:var(--gold)" data-theme="${r.t}">Train</button></div>`).join('') : '<p class="empty">Your strengths and weaknesses by tactic will appear here.</p>';
  $('#pr-themes', el).querySelectorAll('[data-theme]').forEach((b) => b.addEventListener('click', () => go('puzzles', { theme: b.dataset.theme })));
  const games = store.games.slice(-12).reverse();
  $('#pr-games', el).innerHTML = games.length ? games.map((g) => `
    <div class="grow"><span class="res ${g.result}">${g.result === 'win' ? 'W' : g.result === 'loss' ? 'L' : 'D'}</span>
    <span>vs ${LEVELS[g.level].name}<small>${new Date(g.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${g.counts.blunder || 0} blunders · ${g.counts.mistake || 0} mistakes</small></span>
    <span class="gacc">${g.accuracy}%</span></div>`).join('')
    : '<p class="empty">No games yet. Head to Play.</p>';
}

function sparkline(vals, w, h, axes = false) {
  if (vals.length < 2) return '';
  const min = Math.min(...vals) - 10, max = Math.max(...vals) + 10;
  const x = (i) => (i / (vals.length - 1)) * (w - (axes ? 40 : 4)) + (axes ? 36 : 2);
  const y = (v) => h - 6 - ((v - min) / (max - min)) * (h - 12);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${x(0)},${h} ${pts} ${x(vals.length - 1)},${h}`;
  const ax = axes ? [min + 10, Math.round((min + max) / 2), max - 10].map((v) =>
    `<text x="0" y="${y(v) + 4}" class="axis">${Math.round(v)}</text><line x1="36" x2="${w}" y1="${y(v)}" y2="${y(v)}" class="grid"/>`).join('') : '';
  return `<svg viewBox="0 0 ${w} ${h}" class="spark" preserveAspectRatio="${axes ? 'xMidYMid meet' : 'none'}">${ax}
    <polygon points="${area}" class="spark-area"/><polyline points="${pts}" class="spark-line"/>
    <circle cx="${x(vals.length - 1)}" cy="${y(vals[vals.length - 1])}" r="3.5" class="spark-dot"/></svg>`;
}

// ---------- Learn ----------
function renderLearn() {
  const el = $('#lessons');
  const LOOK = {
    think: ['♔', 'var(--mint)'], opening: ['♘', 'var(--sage)'], values: ['♙', 'var(--gold)'], fork: ['♞', 'var(--peach)'],
    pin: ['♝', 'var(--peach)'], discovered: ['♗', 'var(--peach)'], mates: ['♚', 'var(--rose)'], middlegame: ['♜', 'var(--aqua)'],
    endgame: ['♔', 'var(--blue)'], convert: ['♛', 'var(--aqua)'], improve: ['♕', 'var(--mint)'],
  };
  el.innerHTML = LESSONS.map((x) => ({ ...x, icon: LOOK[x.id]?.[0] || '♟', accent: LOOK[x.id]?.[1] || 'var(--aqua)' })).map((l) => `
    <article class="lesson glass" data-id="${l.id}" style="--acc:${l.accent}">
      <button class="lesson-head"><span class="li">${l.icon}</span><span><span class="lvl">${l.level}</span><h3>${l.title}</h3><p>${l.summary}</p></span><span class="open-i"><svg class="ic"><use href="#i-chev"/></svg></span></button>
      <div class="lesson-body" hidden>
        ${l.body.map(([h, t]) => `<div class="point"><div><h4>${h}</h4><p>${t}</p></div></div>`).join('')}
        <button class="btn primary" data-practice='${JSON.stringify(l.practice)}'><svg class="ic"><use href="#${l.practice.type === 'play' ? 'i-play' : 'i-puzzle'}"/></svg>${l.practice.type === 'play' ? 'Practice in a game' : 'Practice with puzzles'}</button>
      </div>
    </article>`).join('');
  el.querySelectorAll('.lesson-head').forEach((h) => h.addEventListener('click', () => {
    const body = h.nextElementSibling;
    body.hidden = !body.hidden;
    h.parentElement.classList.toggle('open', !body.hidden);
  }));
  el.querySelectorAll('[data-practice]').forEach((b) => b.addEventListener('click', () => {
    const p = JSON.parse(b.dataset.practice);
    go(p.type === 'play' ? 'play' : 'puzzles', { theme: p.theme });
  }));
}

// ---------- Boot ----------
puzzles = new PuzzleMode($('#view-puzzles'), { onChange: () => {} });
renderLearn();
window.chessCoach = { get puzzles() { return puzzles; }, get play() { return play; }, store }; // handy for debugging in devtools
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
$('#reset').addEventListener('click', () => { if (confirm('Erase all your progress, rating and saved puzzles?')) resetAll(); });
window.addEventListener('hashchange', () => {
  const t = location.hash.slice(1);
  if (t && document.body.dataset.tab !== t && $(`#view-${t}`)) show(t);
});
const start = (location.hash || '#home').slice(1);
show($(`#view-${start}`) ? start : 'home');
