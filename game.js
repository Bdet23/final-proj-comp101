'use strict';

/* ==========================================================================
   Gerrymander — a hex-map districting game.

   Each tile has a population and an expected vote share (percent) for the
   player's candidate. The player groups every tile into a fixed number of
   districts. Each district must be connected and within ±5% of the ideal
   population. A district is won when its population-weighted vote share for
   the player's candidate is strictly greater than 50%.
   ========================================================================== */

// ---------- Configuration ----------
const SIZES = {
  small:  { label: 'Small · 4 districts',  cols: 7,  rows: 6, districts: 4, cities: 1 },
  medium: { label: 'Medium · 6 districts', cols: 9,  rows: 8, districts: 6, cities: 2 },
  large:  { label: 'Large · 8 districts',  cols: 11, rows: 9, districts: 8, cities: 2 },
};
const TOLERANCE = 0.05;          // districts must be within ±5% of ideal population
const HEX = 34;                  // hex radius in SVG units
const PAD = 6;
const SQRT3 = Math.sqrt(3);

const PLAYER_RGB = [43, 95, 180];     // your candidate (blue)
const OPPONENT_RGB = [192, 57, 43];   // opponent (red)
const NEUTRAL_RGB = [243, 241, 234];
const DISTRICT_COLORS = [
  '#0f8f7e', '#d98e04', '#8e44ad', '#4f8f2a',
  '#c2457f', '#8d6e4c', '#1e9cc4', '#6b7280',
];

// Neighbor offsets for an "odd-r" pointy-top hex grid, ordered to match the
// hex edges: E, SE, SW, W, NW, NE. Edge i runs from corner i to corner i+1.
const DIRS_EVEN = [[1, 0], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1]];
const DIRS_ODD  = [[1, 0], [1, 1], [0, 1], [-1, 0], [0, -1], [1, -1]];

// ---------- Small helpers ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const range = (n) => Array.from({ length: n }, (_, i) => i);
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
const fmtPct = (x, digits = 1) => (x * 100).toFixed(digits) + '%';
const fmtSigned = (x) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(1) + '%';

function hexCorner(x, y, r, k) {
  const angle = (Math.PI / 180) * (60 * k - 30);
  return [x + r * Math.cos(angle), y + r * Math.sin(angle)];
}

function hexPoints(x, y, r) {
  return range(6).map((k) => hexCorner(x, y, r, k).map((v) => v.toFixed(2)).join(',')).join(' ');
}

// ---------- Grid ----------
function buildGrid(cols, rows) {
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        id: tiles.length,
        col: c,
        row: r,
        x: PAD + SQRT3 * HEX * (c + 0.5 * (r & 1)) + (SQRT3 * HEX) / 2,
        y: PAD + HEX + 1.5 * HEX * r,
        pop: 0,
        lean: 50,
        nbrs: [],
      });
    }
  }
  for (const t of tiles) {
    const dirs = t.row & 1 ? DIRS_ODD : DIRS_EVEN;
    t.nbrs = dirs.map(([dc, dr]) => {
      const c = t.col + dc;
      const r = t.row + dr;
      return c >= 0 && c < cols && r >= 0 && r < rows ? r * cols + c : -1;
    });
  }
  return tiles;
}

// ---------- District math (shared by the game and the map generator) ----------
function isConnected(ids, assign, tiles) {
  if (ids.length === 0) return false;
  const d = assign[ids[0]];
  const seen = new Set([ids[0]]);
  const stack = [ids[0]];
  while (stack.length) {
    const i = stack.pop();
    for (const j of tiles[i].nbrs) {
      if (j >= 0 && assign[j] === d && !seen.has(j)) {
        seen.add(j);
        stack.push(j);
      }
    }
  }
  return seen.size === ids.length;
}

function computeStats(tiles, assign, n, ideal) {
  const stats = range(n).map(() => ({ tiles: [], pop: 0, votes: 0 }));
  for (const t of tiles) {
    const d = assign[t.id];
    if (d >= 0) {
      stats[d].tiles.push(t.id);
      stats[d].pop += t.pop;
      stats[d].votes += (t.pop * t.lean) / 100;
    }
  }
  for (const s of stats) {
    s.share = s.pop > 0 ? s.votes / s.pop : 0;
    s.dev = (s.pop - ideal) / ideal;
    s.popOk = s.pop > 0 && Math.abs(s.pop - ideal) <= ideal * TOLERANCE;
    s.connected = isConnected(s.tiles, assign, tiles);
    s.wins = s.pop > 0 && s.share > 0.5;
  }
  return stats;
}

// ---------- Map generation ----------
// 1. Voter geography is built on its own (cities, suburbs, countryside, a
//    corridor, scattered pockets). No district plan is involved, so the
//    map does not give away an answer.
// 2. Many random legal plans are drawn and scored. A map is kept only when
//    few of them win, so obvious compact districts tend to lose.
// 3. A solver (simulated annealing) searches for a winning plan, which proves
//    the map can be won and is kept as the hidden solution.

const ENSEMBLE_SIZE = 150;          // random legal plans drawn per map
const MAX_WIN_FRACTION = 0.05;      // at most 5% of random plans may win
const MAP_ATTEMPTS = 12;            // candidate maps tried per seed

const lerp = (a, b, t) => a + (b - a) * t;

function generateGeography(tiles, cfg, rand) {
  const maxX = Math.max(...tiles.map((t) => t.x));
  const maxY = Math.max(...tiles.map((t) => t.y));
  const step = SQRT3 * HEX; // distance between neighboring tile centers
  const gauss = (t, c, radius) => Math.exp(-((t.x - c.x) ** 2 + (t.y - c.y) ** 2) / (2 * radius * radius));

  // Cities: dense, and lean toward one party.
  const cities = range(cfg.cities).map(() => ({
    x: lerp(0.15, 0.85, rand()) * maxX,
    y: lerp(0.15, 0.85, rand()) * maxY,
    size: 0.75 + rand() * 0.5,
  }));
  const urban = tiles.map((t) =>
    Math.min(1, cities.reduce((s, c) => s + c.size * gauss(t, c, step * 1.5 * c.size), 0))
  );

  for (const t of tiles) {
    const u = urban[t.id];
    t.pop = Math.round((1100 + rand() * 1300 + 9000 * u ** 1.4) / 10) * 10;
  }

  // Base lean: the countryside and the cities favor different parties.
  const playerIsUrban = rand() < 0.5;
  const lean = tiles.map((t) => {
    const ruralLean = 0.6;
    const urbanLean = 0.27;
    const opp = lerp(ruralLean, urbanLean, urban[t.id]);
    return playerIsUrban ? 1 - opp : opp;
  });

  // Regional variation: a few broad swings in either direction.
  for (let k = 0; k < 4; k++) {
    const c = { x: rand() * maxX, y: rand() * maxY };
    const amp = (rand() - 0.5) * 0.22;
    const radius = step * (1.5 + rand() * 1.5);
    for (const t of tiles) lean[t.id] += amp * gauss(t, c, radius);
  }

  // Corridor (river valley or highway): a thin band that leans one way.
  const px = lerp(0.3, 0.7, rand()) * maxX;
  const py = lerp(0.3, 0.7, rand()) * maxY;
  const angle = rand() * Math.PI;
  const corridorAmp = (rand() < 0.7 ? 1 : -1) * (0.12 + rand() * 0.08);
  for (const t of tiles) {
    const dist = Math.abs((t.x - px) * Math.sin(angle) - (t.y - py) * Math.cos(angle));
    if (dist < step * 0.6) lean[t.id] += corridorAmp;
  }

  // Pockets: isolated tiles that go against their surroundings.
  const pockets = 3 + Math.floor(rand() * 4);
  for (let k = 0; k < pockets; k++) {
    const i = Math.floor(rand() * tiles.length);
    lean[i] += lean[i] > 0.5 ? -0.22 : 0.22;
  }

  // Local noise.
  for (const t of tiles) lean[t.id] += (rand() - 0.5) * 0.1;

  // Shift everything so the player trails statewide (42–48%).
  const targetShare = 0.42 + rand() * 0.06;
  const clampLean = (x) => Math.min(0.94, Math.max(0.06, x));
  const totalPop = tiles.reduce((s, t) => s + t.pop, 0);
  const shareWith = (shift) => tiles.reduce((s, t) => s + t.pop * clampLean(lean[t.id] + shift), 0) / totalPop;
  let lo = -0.6;
  let hi = 0.6;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (shareWith(mid) < targetShare) lo = mid; else hi = mid;
  }
  for (const t of tiles) t.lean = Math.round(clampLean(lean[t.id] + lo) * 100);
}

function pickSeeds(tiles, n, rand) {
  const seeds = [Math.floor(rand() * tiles.length)];
  while (seeds.length < n) {
    let best = -1;
    let bestDist = -1;
    for (let k = 0; k < 12; k++) {
      const i = Math.floor(rand() * tiles.length);
      if (seeds.includes(i)) continue;
      const dist = Math.min(...seeds.map((s) => Math.hypot(tiles[s].x - tiles[i].x, tiles[s].y - tiles[i].y)));
      if (dist > bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    if (best >= 0) seeds.push(best);
  }
  return seeds;
}

// Grow districts from random seeds, always extending the least populated one.
function growPartition(tiles, n, rand) {
  const owner = new Array(tiles.length).fill(-1);
  const pops = new Array(n).fill(0);
  pickSeeds(tiles, n, rand).forEach((s, d) => {
    owner[s] = d;
    pops[d] = tiles[s].pop;
  });
  let remaining = tiles.length - n;
  while (remaining > 0) {
    const order = range(n).sort((a, b) => pops[a] - pops[b]);
    let grew = false;
    for (const d of order) {
      const frontier = [];
      for (const t of tiles) {
        if (owner[t.id] !== d) continue;
        for (const j of t.nbrs) if (j >= 0 && owner[j] === -1) frontier.push(j);
      }
      if (frontier.length) {
        const j = frontier[Math.floor(rand() * frontier.length)];
        owner[j] = d;
        pops[d] += tiles[j].pop;
        remaining--;
        grew = true;
        break;
      }
    }
    if (!grew) return null;
  }
  return owner;
}

// Simulated annealing over single-tile moves between neighboring districts.
// Districts always stay connected; population limits are a penalty, and only
// fully legal plans are recorded. With seatW = 0 it simply makes a plan legal.
function anneal(tiles, start, n, ideal, rand, o) {
  const T = tiles.length;
  const assign = start.slice();
  const pop = new Array(n).fill(0);
  const votes = new Array(n).fill(0);
  const size = new Array(n).fill(0);
  for (const t of tiles) {
    const d = assign[t.id];
    pop[d] += t.pop;
    votes[d] += (t.pop * t.lean) / 100;
    size[d]++;
  }
  const tolAbs = ideal * TOLERANCE;
  const excess = (p) => Math.max(0, Math.abs(p - ideal) - tolAbs) / ideal;
  const value = (p, v) => {
    const s = v / p;
    return o.seatW * (s > 0.5 ? 1 : 0) + o.marginW * Math.tanh((s - 0.5) * 20) - o.penW * excess(p);
  };

  let bad = 0;
  for (let d = 0; d < n; d++) if (excess(pop[d]) > 0) bad++;

  let best = null;
  let bestSeats = -1;
  let bestScore = -Infinity;
  const record = () => {
    let seats = 0;
    let score = 0;
    for (let d = 0; d < n; d++) {
      const s = votes[d] / pop[d];
      if (s > 0.5) seats++;
      score += Math.tanh((s - 0.5) * 20);
    }
    if (seats > bestSeats || (seats === bestSeats && score > bestScore)) {
      bestSeats = seats;
      bestScore = score;
      best = assign.slice();
    }
  };

  if (bad === 0) {
    record();
    if (o.stopWhenValid) return { plan: best, seats: bestSeats };
  }

  const mark = new Int32Array(T);
  const stack = new Int32Array(T);
  let stamp = 0;
  for (let it = 0; it < o.iters; it++) {
    const temp = o.t0 * Math.pow(o.t1 / o.t0, it / o.iters);
    const i = Math.floor(rand() * T);
    const j = tiles[i].nbrs[Math.floor(rand() * 6)];
    if (j < 0) continue;
    const a = assign[i];
    const b = assign[j];
    if (a === b || size[a] === 1) continue;

    const p = tiles[i].pop;
    const v = (p * tiles[i].lean) / 100;
    const delta =
      value(pop[a] - p, votes[a] - v) + value(pop[b] + p, votes[b] + v) -
      value(pop[a], votes[a]) - value(pop[b], votes[b]);
    if (delta < 0 && rand() >= Math.exp(delta / temp)) continue;

    // District a must stay connected without tile i.
    stamp++;
    let first = -1;
    for (const k of tiles[i].nbrs) if (k >= 0 && assign[k] === a) { first = k; break; }
    if (first < 0) continue;
    mark[i] = stamp;
    mark[first] = stamp;
    let sp = 0;
    let count = 1;
    stack[sp++] = first;
    while (sp) {
      const x = stack[--sp];
      for (const y of tiles[x].nbrs) {
        if (y >= 0 && assign[y] === a && mark[y] !== stamp) {
          mark[y] = stamp;
          stack[sp++] = y;
          count++;
        }
      }
    }
    if (count !== size[a] - 1) continue;

    const wasBad = (excess(pop[a]) > 0 ? 1 : 0) + (excess(pop[b]) > 0 ? 1 : 0);
    assign[i] = b;
    pop[a] -= p; votes[a] -= v; size[a]--;
    pop[b] += p; votes[b] += v; size[b]++;
    bad += (excess(pop[a]) > 0 ? 1 : 0) + (excess(pop[b]) > 0 ? 1 : 0) - wasBad;

    if (bad === 0) {
      record();
      if (o.stopWhenValid) break;
    }
  }
  return best ? { plan: best, seats: bestSeats } : null;
}

function sampleLegalPlans(tiles, n, ideal, rand) {
  const samples = [];
  for (let k = 0; k < ENSEMBLE_SIZE * 2 && samples.length < ENSEMBLE_SIZE; k++) {
    const start = growPartition(tiles, n, rand);
    if (!start) continue;
    const r = anneal(tiles, start, n, ideal, rand, {
      seatW: 0, marginW: 0, penW: 30, t0: 0.05, t1: 0.002, iters: 4000, stopWhenValid: true,
    });
    if (r) samples.push(r);
  }
  return samples;
}

function findBestPlan(tiles, n, ideal, samples, rand) {
  const starts = samples.slice().sort((a, b) => b.seats - a.seats).slice(0, 4);
  let best = null;
  for (const s of starts) {
    const r = anneal(tiles, s.plan, n, ideal, rand, {
      seatW: 1, marginW: 0.25, penW: 25, t0: 0.6, t1: 0.02, iters: 25000, stopWhenValid: false,
    });
    if (r && (!best || r.seats > best.seats)) best = r;
  }
  return best;
}

function generateMap(sizeKey, seed) {
  const cfg = SIZES[sizeKey];
  const n = cfg.districts;
  const target = Math.floor(n / 2) + 1;
  let fallback = null;

  for (let attempt = 0; attempt < MAP_ATTEMPTS; attempt++) {
    const rand = mulberry32(seed * 7919 + attempt);
    const tiles = buildGrid(cfg.cols, cfg.rows);
    generateGeography(tiles, cfg, rand);

    const totalPop = tiles.reduce((s, t) => s + t.pop, 0);
    const ideal = totalPop / n;
    const statewideShare = tiles.reduce((s, t) => s + (t.pop * t.lean) / 100, 0) / totalPop;
    if (statewideShare >= 0.5) continue;

    const samples = sampleLegalPlans(tiles, n, ideal, rand);
    if (samples.length < ENSEMBLE_SIZE / 2) continue;
    const winFraction = samples.filter((s) => s.seats >= target).length / samples.length;
    if (winFraction > 0.25) continue; // far too easy, don't bother solving

    const best = findBestPlan(tiles, n, ideal, samples, rand);
    if (!best || best.seats < target) continue;

    const map = {
      sizeKey, cfg, seed, tiles, ideal, target, totalPop, statewideShare,
      solution: best.plan, maxSeats: best.seats, winFraction, sampleCount: samples.length,
    };
    if (winFraction <= MAX_WIN_FRACTION) return map;
    if (!fallback || winFraction < fallback.winFraction) fallback = map;
  }
  if (fallback) return fallback;
  if (seed < 1e9) return generateMap(sizeKey, seed + 1000003);
  throw new Error('Could not generate a map for seed ' + seed);
}

// ---------- Game state ----------
let game = null;
const ui = { assign: [], tool: 0, view: 'votes', painting: null, lastPainted: null, revealed: false };
const els = {};
let tileEls = [];

const $ = (sel) => document.querySelector(sel);
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function leanColor(pct) {
  const t = Math.max(-1, Math.min(1, (pct - 50) / 30));
  const target = t >= 0 ? PLAYER_RGB : OPPONENT_RGB;
  const a = Math.abs(t);
  const rgb = NEUTRAL_RGB.map((v, i) => Math.round(v + (target[i] - v) * a));
  return `rgb(${rgb.join(',')})`;
}

function isDark(color) {
  let r, g, b;
  if (color.startsWith('#')) {
    const n = parseInt(color.slice(1), 16);
    r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
  } else {
    [r, g, b] = color.match(/\d+/g).map(Number);
  }
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 150;
}

function randomSeed() {
  return Math.floor(Math.random() * 1000000);
}

function startGame(sizeKey, seed) {
  // Generation can take up to a second, so show a message and let the page paint first.
  els.loading.hidden = false;
  els.board.classList.add('busy');
  setTimeout(() => {
    try {
      loadMap(generateMap(sizeKey, seed));
    } finally {
      els.loading.hidden = true;
      els.board.classList.remove('busy');
    }
  }, 30);
}

function loadMap(map) {
  game = map;
  ui.assign = new Array(game.tiles.length).fill(-1);
  ui.tool = 0;
  ui.revealed = false;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('size', game.sizeKey);
    url.searchParams.set('seed', String(game.seed));
    window.history.replaceState(null, '', url);
  } catch (e) { /* URL updates are optional */ }
  buildBoard();
  buildDistrictList();
  renderGoal();
  render();
}

// ---------- Board rendering ----------
function buildBoard() {
  const { cols, rows } = game.cfg;
  const w = PAD * 2 + SQRT3 * HEX * (cols + 0.5);
  const h = PAD * 2 + HEX * 2 + 1.5 * HEX * (rows - 1);
  const board = els.board;
  board.setAttribute('viewBox', `0 0 ${w.toFixed(1)} ${h.toFixed(1)}`);
  board.style.maxWidth = `${Math.round(w * 1.25)}px`;
  board.style.margin = '0 auto';
  board.innerHTML = '';

  const gTiles = svgEl('g');
  tileEls = game.tiles.map((t) => {
    const g = svgEl('g', { class: 'tile', 'data-id': t.id });
    const poly = svgEl('polygon', { class: 'hex', points: hexPoints(t.x, t.y, HEX) });
    const ring = svgEl('polygon', { class: 'ring', points: hexPoints(t.x, t.y, HEX - 4.5) });
    const pop = svgEl('text', { class: 'pop', x: t.x, y: t.y + 5 });
    pop.textContent = fmtK(t.pop);
    const lean = svgEl('text', { class: 'lean', x: t.x, y: t.y + 18 });
    lean.textContent = t.lean + '%';
    g.append(poly, ring, pop, lean);
    gTiles.append(g);
    return { g, poly, ring, pop, lean };
  });
  els.borders = svgEl('path', { class: 'borders' });
  els.labels = svgEl('g', { class: 'labels' });
  board.append(gTiles, els.borders, els.labels);
}

function renderTiles() {
  for (const t of game.tiles) {
    const el = tileEls[t.id];
    const d = ui.assign[t.id];
    let fill;
    if (ui.view === 'votes') fill = leanColor(t.lean);
    else fill = d >= 0 ? DISTRICT_COLORS[d] : null;

    el.poly.style.fill = fill || 'var(--unassigned)';
    const textClass = fill ? (isDark(fill) ? 'on-dark' : 'on-light') : '';
    el.pop.setAttribute('class', 'pop ' + textClass);
    el.lean.setAttribute('class', 'lean ' + textClass);

    if (ui.view === 'votes' && d >= 0) {
      el.ring.style.stroke = DISTRICT_COLORS[d];
      el.ring.style.display = '';
    } else {
      el.ring.style.display = 'none';
    }
  }
}

function renderBorders() {
  let path = '';
  for (const t of game.tiles) {
    const a = ui.assign[t.id];
    for (let i = 0; i < 6; i++) {
      const j = t.nbrs[i];
      if (j >= 0 && j < t.id) continue; // each shared edge is drawn once
      const b = j >= 0 ? ui.assign[j] : -1;
      if (a === b) continue;
      if (j < 0 && a < 0) continue;
      const [x1, y1] = hexCorner(t.x, t.y, HEX, i);
      const [x2, y2] = hexCorner(t.x, t.y, HEX, (i + 1) % 6);
      path += `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`;
    }
  }
  els.borders.setAttribute('d', path);
}

function renderLabels(stats) {
  els.labels.innerHTML = '';
  stats.forEach((s, d) => {
    if (!s.tiles.length) return;
    const cx = s.tiles.reduce((sum, i) => sum + game.tiles[i].x, 0) / s.tiles.length;
    const cy = s.tiles.reduce((sum, i) => sum + game.tiles[i].y, 0) / s.tiles.length;
    let best = s.tiles[0];
    let bestDist = Infinity;
    for (const i of s.tiles) {
      const dist = Math.hypot(game.tiles[i].x - cx, game.tiles[i].y - cy);
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    const t = game.tiles[best];
    const circle = svgEl('circle', { cx: t.x, cy: t.y - 15, r: 9, fill: DISTRICT_COLORS[d] });
    const text = svgEl('text', { x: t.x, y: t.y - 11.3 });
    text.textContent = d + 1;
    els.labels.append(circle, text);
  });
}

// ---------- Sidebar rendering ----------
function renderGoal() {
  const lo = Math.ceil(game.ideal * (1 - TOLERANCE));
  const hi = Math.floor(game.ideal * (1 + TOLERANCE));
  els.goal.innerHTML = `
    <h2>Your mission</h2>
    <p>Your candidate expects <strong>${fmtPct(game.statewideShare)}</strong> of the statewide vote.</p>
    <p>Draw <strong>${game.cfg.districts}</strong> districts and win at least <strong>${game.target}</strong> of them.</p>
    <p>Every district must be connected with <strong>${fmtInt(lo)}–${fmtInt(hi)}</strong> people
       (ideal ${fmtInt(game.ideal)}, ±${TOLERANCE * 100}%).</p>
    <p class="muted">Difficulty: ${difficultyText()}</p>
    <p class="muted">Map #${game.seed}</p>`;
}

function difficultyText() {
  const pct = Math.round(game.winFraction * 100);
  const share = pct === 0 ? `none of ${game.sampleCount}` : `only ${pct}%`;
  return `${share} of randomly drawn legal maps win ${game.target}+ seats.`;
}

function buildDistrictList() {
  els.districtList.innerHTML = '';
  for (let d = 0; d < game.cfg.districts; d++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'district-row';
    btn.dataset.d = d;
    btn.innerHTML = `
      <span class="swatch" style="background:${DISTRICT_COLORS[d]}">${d + 1}</span>
      <span class="d-main">
        <span class="d-pop"></span>
        <span class="pop-bar"><span class="band"></span><span class="fill"></span></span>
        <span class="d-issue"></span>
      </span>
      <span class="d-share"></span>`;
    btn.addEventListener('click', () => setTool(d));
    els.districtList.append(btn);
  }
}

function renderDistrictList(stats) {
  const scale = 1.25; // bar covers 0 – 125% of ideal
  const rows = els.districtList.querySelectorAll('.district-row');
  stats.forEach((s, d) => {
    const row = rows[d];
    row.classList.toggle('active', ui.tool === d);
    const popEl = row.querySelector('.d-pop');
    const shareEl = row.querySelector('.d-share');
    const issueEl = row.querySelector('.d-issue');
    const fill = row.querySelector('.fill');
    const band = row.querySelector('.band');

    band.style.left = `${((1 - TOLERANCE) / scale) * 100}%`;
    band.style.width = `${((2 * TOLERANCE) / scale) * 100}%`;
    fill.style.width = `${Math.min(s.pop / game.ideal / scale, 1) * 100}%`;
    fill.className = 'fill ' + (s.popOk ? 'ok' : s.dev > TOLERANCE ? 'over' : '');

    if (!s.tiles.length) {
      popEl.innerHTML = '<span class="muted">Empty</span>';
      shareEl.textContent = '—';
      shareEl.className = 'd-share muted';
      issueEl.textContent = '';
      return;
    }
    popEl.innerHTML = `${fmtInt(s.pop)} <small class="${s.popOk ? 'ok' : 'bad'}">${fmtSigned(s.dev)}</small>`;
    shareEl.textContent = fmtPct(s.share);
    shareEl.className = 'd-share ' + (s.wins ? 'win' : 'lose');
    shareEl.title = s.wins ? 'Your candidate leads' : 'Opponent leads';
    issueEl.textContent = s.connected ? '' : 'Not connected';
  });
  els.eraser.classList.toggle('active', ui.tool === 'erase');
}

function renderSummary(stats) {
  const assigned = ui.assign.filter((d) => d >= 0).length;
  const seats = stats.filter((s) => s.wins).length;
  const valid = stats.filter((s) => s.popOk && s.connected).length;
  els.summary.innerHTML = `
    <h2>Projection</h2>
    <div class="stat-grid">
      <div class="stat"><span class="label">Seats won</span>
        <span class="value ${seats >= game.target ? 'ok' : ''}">${seats} / ${game.cfg.districts}</span></div>
      <div class="stat"><span class="label">Needed</span>
        <span class="value">${game.target}</span></div>
      <div class="stat"><span class="label">Tiles assigned</span>
        <span class="value">${assigned} / ${game.tiles.length}</span></div>
      <div class="stat"><span class="label">Valid districts</span>
        <span class="value ${valid === game.cfg.districts ? 'ok' : ''}">${valid} / ${game.cfg.districts}</span></div>
    </div>`;
}

function render() {
  if (!game) return;
  const stats = computeStats(game.tiles, ui.assign, game.cfg.districts, game.ideal);
  renderTiles();
  renderBorders();
  renderLabels(stats);
  renderDistrictList(stats);
  renderSummary(stats);
  els.toggleView.textContent = ui.view === 'votes' ? 'Show districts' : 'Show voters';
  els.legend.classList.toggle('hidden', ui.view !== 'votes');
}

function showTileInfo(id) {
  if (id == null) {
    els.tileInfo.textContent = 'Hover over a tile to see its details.';
    return;
  }
  const t = game.tiles[id];
  const d = ui.assign[id];
  els.tileInfo.textContent =
    `Population ${fmtInt(t.pop)} · Your candidate ${t.lean}% · Opponent ${100 - t.lean}% · ` +
    (d >= 0 ? `District ${d + 1}` : 'Unassigned');
}

// ---------- Interaction ----------
function setTool(tool) {
  ui.tool = tool;
  render();
}

function tileAt(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const g = el && el.closest && el.closest('.tile');
  return g ? Number(g.dataset.id) : null;
}

function applyPaint(id) {
  if (id == null || id === ui.lastPainted) return;
  ui.lastPainted = id;
  const next = ui.painting === 'erase' ? -1 : ui.tool;
  if (ui.assign[id] !== next) {
    ui.assign[id] = next;
    render();
  }
}

function bindEvents() {
  els.board.addEventListener('pointerdown', (e) => {
    const id = tileAt(e);
    if (id == null || (e.button !== undefined && e.button !== 0)) return;
    e.preventDefault();
    ui.painting = ui.tool === 'erase' || ui.assign[id] === ui.tool ? 'erase' : 'paint';
    ui.lastPainted = null;
    try { els.board.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    applyPaint(id);
  });
  els.board.addEventListener('pointermove', (e) => {
    const id = tileAt(e);
    showTileInfo(id);
    if (ui.painting) applyPaint(id);
  });
  els.board.addEventListener('pointerleave', () => { if (!ui.painting) showTileInfo(null); });
  const stop = () => { ui.painting = null; ui.lastPainted = null; };
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);

  els.eraser.addEventListener('click', () => setTool('erase'));
  els.reset.addEventListener('click', () => {
    if (ui.assign.some((d) => d >= 0) && !window.confirm('Clear all districts on this map?')) return;
    ui.assign.fill(-1);
    render();
  });
  els.newMap.addEventListener('click', () => startGame(els.size.value, randomSeed()));
  els.size.addEventListener('change', () => startGame(els.size.value, randomSeed()));
  els.toggleView.addEventListener('click', () => {
    ui.view = ui.view === 'votes' ? 'districts' : 'votes';
    render();
  });
  els.submit.addEventListener('click', holdElection);

  document.addEventListener('keydown', (e) => {
    if (!game || els.dialog.open || e.target.closest('input, select, textarea')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const num = Number(e.key);
    if (Number.isInteger(num) && num >= 1 && num <= game.cfg.districts) setTool(num - 1);
    else if (e.key === 'e' || e.key === 'E') setTool('erase');
    else if (e.key === 'v' || e.key === 'V') els.toggleView.click();
  });
}

// ---------- Election ----------
function validatePlan(stats) {
  const problems = [];
  const unassigned = ui.assign.filter((d) => d < 0).length;
  if (unassigned) problems.push(`${unassigned} tile${unassigned === 1 ? ' is' : 's are'} not in any district.`);
  stats.forEach((s, d) => {
    const name = `District ${d + 1}`;
    if (!s.tiles.length) {
      problems.push(`${name} has no tiles.`);
      return;
    }
    if (!s.connected) problems.push(`${name} is split into separate pieces.`);
    if (!s.popOk) {
      problems.push(`${name} has ${fmtInt(s.pop)} people (${fmtSigned(s.dev)}); it must be within ±${TOLERANCE * 100}% of ${fmtInt(game.ideal)}.`);
    }
  });
  return problems;
}

function openDialog(bodyHtml, actions) {
  els.dialogBody.innerHTML = bodyHtml;
  els.dialogActions.innerHTML = '';
  for (const { label, primary, onClick } of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    if (primary) btn.className = 'primary';
    btn.addEventListener('click', () => {
      els.dialog.close();
      if (onClick) onClick();
    });
    els.dialogActions.append(btn);
  }
  els.dialog.showModal();
}

function holdElection() {
  if (!game) return;
  const stats = computeStats(game.tiles, ui.assign, game.cfg.districts, game.ideal);
  const problems = validatePlan(stats);
  if (problems.length) {
    openDialog(
      `<h2>This map isn't legal yet</h2>
       <p>Fix these problems before holding the election:</p>
       <ul>${problems.map((p) => `<li>${p}</li>`).join('')}</ul>`,
      [{ label: 'Keep drawing', primary: true }]
    );
    return;
  }

  const seats = stats.filter((s) => s.wins).length;
  const won = seats >= game.target;
  const rows = stats.map((s, d) => `
    <tr>
      <td><span class="dot" style="background:${DISTRICT_COLORS[d]}"></span>District ${d + 1}</td>
      <td class="num">${fmtInt(s.pop)}</td>
      <td class="num">${fmtPct(s.share)}</td>
      <td class="${s.wins ? 'win' : 'lose'}">${s.wins ? 'You' : 'Opponent'}</td>
    </tr>`).join('');

  const body = `
    <h2>${won ? 'Victory!' : 'Defeat'}</h2>
    <p>Your candidate won <strong>${seats} of ${game.cfg.districts}</strong> seats
       (${fmtPct(seats / game.cfg.districts, 0)} of seats) with ${fmtPct(game.statewideShare)} of the statewide vote.
       ${won ? '' : `You needed ${game.target}.`}</p>
    <table class="results-table">
      <thead><tr><th>District</th><th class="num">Population</th><th class="num">Your vote</th><th>Winner</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  const actions = won
    ? [
        { label: 'Keep editing' },
        { label: 'Next map', primary: true, onClick: () => startGame(game.sizeKey, randomSeed()) },
      ]
    : [
        { label: 'Show a winning plan', onClick: revealSolution },
        { label: 'Keep trying', primary: true },
      ];
  openDialog(body, actions);
}

function revealSolution() {
  ui.assign = game.solution.slice();
  ui.revealed = true;
  render();
}

// ---------- Start ----------
function init() {
  els.board = $('#board');
  els.size = $('#size-select');
  els.newMap = $('#new-map');
  els.reset = $('#reset');
  els.toggleView = $('#toggle-view');
  els.submit = $('#submit');
  els.goal = $('#goal');
  els.districtList = $('#district-list');
  els.eraser = $('#eraser-btn');
  els.summary = $('#summary');
  els.tileInfo = $('#tile-info');
  els.legend = $('#legend');
  els.dialog = $('#result-dialog');
  els.dialogBody = $('#result-body');
  els.dialogActions = $('#result-actions');
  els.loading = $('#loading');

  for (const [key, cfg] of Object.entries(SIZES)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = cfg.label;
    els.size.append(opt);
  }

  const params = new URLSearchParams(window.location.search);
  const sizeKey = SIZES[params.get('size')] ? params.get('size') : 'medium';
  const seedParam = parseInt(params.get('seed'), 10);
  els.size.value = sizeKey;
  bindEvents();
  startGame(sizeKey, Number.isFinite(seedParam) && seedParam >= 0 ? seedParam : randomSeed());
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
if (typeof module !== 'undefined') {
  module.exports = { generateMap, computeStats, SIZES, TOLERANCE };
}
