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
// District colours avoid the red/blue vote scale; numbers on the badges keep
// districts distinguishable for colour-blind players.
const DISTRICT_COLORS = [
  '#0e9384', '#d4a106', '#3f8f3a', '#8b5e3c',
  '#5b6878', '#8a9a1c', '#5fbf9f', '#b08d57',
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

function computeStats(tiles, assign, n, ideal, tol = TOLERANCE) {
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
    s.popOk = s.pop > 0 && Math.abs(s.pop - ideal) <= ideal * tol;
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
  const tolAbs = ideal * (o.tol ?? TOLERANCE);
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

function sampleLegalPlans(tiles, n, ideal, rand, tol = TOLERANCE, count = ENSEMBLE_SIZE) {
  const samples = [];
  for (let k = 0; k < count * 2 && samples.length < count; k++) {
    const start = growPartition(tiles, n, rand);
    if (!start) continue;
    const r = anneal(tiles, start, n, ideal, rand, {
      seatW: 0, marginW: 0, penW: 30, t0: 0.05, t1: 0.002, iters: 4000, stopWhenValid: true, tol,
    });
    if (r) samples.push(r);
  }
  return samples;
}

function findBestPlan(tiles, n, ideal, samples, rand, tol = TOLERANCE) {
  const starts = samples.slice().sort((a, b) => b.seats - a.seats).slice(0, 4);
  let best = null;
  for (const s of starts) {
    const r = anneal(tiles, s.plan, n, ideal, rand, {
      seatW: 1, marginW: 0.25, penW: 25, t0: 0.6, t1: 0.02, iters: 25000, stopWhenValid: false, tol,
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
      tolerance: TOLERANCE, mode: 'percent', lesson: null,
      solution: best.plan, maxSeats: best.seats, winFraction, sampleCount: samples.length,
    };
    if (winFraction <= MAX_WIN_FRACTION) return map;
    if (!fallback || winFraction < fallback.winFraction) fallback = map;
  }
  if (fallback) return fallback;
  if (seed < 1e9) return generateMap(sizeKey, seed + 1000003);
  throw new Error('Could not generate a map for seed ' + seed);
}

// ---------- Tutorial lessons ----------
// Hand-picked layouts (found with an offline search using the same solver).
// Each one is solvable, and only a small share of random legal plans win it.
const TUTORIAL = [
  {
    title: "Lesson 1 · Every voter counts",
    mode: 'voters',
    cols: 5, rows: 5, districts: 5, target: 3, tolerance: 0,
    intro: "Each hex is one voter: ✓ votes for your candidate and ✗ votes for the opponent. You have only 10 of the 25 voters, but you can still win 3 of the 5 districts.",
    tip: "Tip: three ✓ voters are enough to win a district of five. Don't waste extra ✓ voters where you're already winning, and pack ✗ voters into the districts you give up.",
    debrief: "With 40% of the voters you won a majority of the districts. Spreading your voters thinly is called <strong>cracking</strong>; crowding the opponent's voters together is called <strong>packing</strong>.",
    pops: [
      1, 1, 1, 1, 1,
      1, 1, 1, 1, 1,
      1, 1, 1, 1, 1,
      1, 1, 1, 1, 1,
      1, 1, 1, 1, 1,
    ],
    leans: [
      0, 0, 100, 100, 100,
      0, 0, 100, 100, 0,
      0, 0, 100, 100, 0,
      0, 100, 100, 0, 0,
      100, 0, 0, 0, 0,
    ],
    solution: [
      1, 1, 4, 0, 0,
      1, 4, 4, 0, 0,
      1, 1, 2, 4, 0,
      2, 2, 4, 3, 3,
      2, 2, 3, 3, 3,
    ],
  },
  {
    title: "Lesson 2 · People, not land",
    mode: 'binary',
    cols: 6, rows: 6, districts: 4, target: 3, tolerance: 0.1,
    intro: "Tiles now hold different numbers of people. ✓ tiles vote for you and ✗ tiles for the opponent. Every district must have about the same number of people (within ±10%), so a crowded city tile can fill much of a district on its own.",
    tip: "Tip: you hold more land than the opponent but fewer people. Countryside districts need many tiles, while city districts are small. Try giving the opponent one tightly packed city district.",
    debrief: "Districts are drawn by <strong>population</strong>, not area. Packing the dense city into one district left your rural supporters a majority everywhere else.",
    pops: [
      3, 2, 2, 5, 8, 11,
      1, 1, 3, 5, 9, 8,
      2, 3, 1, 2, 4, 5,
      1, 3, 2, 2, 4, 3,
      3, 1, 2, 3, 2, 2,
      3, 2, 2, 3, 1, 3,
    ],
    leans: [
      0, 0, 0, 100, 0, 0,
      0, 0, 100, 100, 0, 0,
      0, 0, 100, 100, 100, 0,
      100, 100, 0, 0, 0, 100,
      100, 100, 100, 100, 100, 100,
      0, 100, 100, 100, 100, 100,
    ],
    solution: [
      3, 3, 3, 3, 1, 1,
      3, 0, 3, 3, 0, 1,
      3, 3, 0, 0, 0, 2,
      3, 0, 2, 2, 2, 2,
      3, 0, 0, 2, 2, 2,
      0, 0, 0, 2, 2, 2,
    ],
  },
  {
    title: "Lesson 3 · Shades of support",
    mode: 'percent',
    cols: 7, rows: 6, districts: 4, target: 3, tolerance: 0.05,
    intro: "This is the full game. Each tile shows its population and the percentage of people who vote for your candidate. A 55% tile still gives 45% of its votes to the opponent. Districts must now be within ±5% of the ideal size.",
    tip: "Tip: combine your strongest tiles with slightly unfavourable ones to push several districts just over 50%. Watch each district's vote share in the list as you draw.",
    debrief: "You're ready for the real thing. Generated maps are harder: only a few percent of random legal plans win.",
    pops: [
      1210, 1750, 1750, 2700, 5020, 5820, 6430,
      1230, 2570, 2680, 5820, 8430, 10270, 8160,
      1730, 1450, 2300, 5420, 8850, 10910, 11100,
      2350, 1940, 2880, 7290, 10890, 11010, 10140,
      2360, 2070, 2690, 4010, 6290, 9290, 8380,
      1280, 2500, 2600, 3250, 5060, 5150, 5070,
    ],
    leans: [
      43, 18, 24, 37, 37, 45, 46,
      18, 23, 56, 43, 54, 35, 50,
      20, 17, 31, 41, 47, 74, 72,
      25, 35, 41, 54, 72, 57, 59,
      34, 35, 37, 31, 48, 52, 50,
      22, 23, 28, 36, 40, 43, 37,
    ],
    solution: [
      0, 0, 0, 0, 0, 0, 1,
      0, 0, 2, 2, 1, 1, 1,
      0, 0, 0, 2, 2, 1, 1,
      0, 0, 0, 2, 2, 3, 3,
      0, 0, 0, 0, 2, 3, 3,
      0, 0, 0, 2, 3, 3, 3,
    ],
  },
];

// ---------- Game state ----------
let game = null;
const ui = {
  assign: [],
  tool: 0,            // district index, or 'erase'
  view: 'votes',      // tile colour: 'votes' or 'districts'
  label: 'lean',      // tile numbers on full maps: 'lean' (vote %), 'pop' or 'both'
  painting: null,
  lastPainted: null,
  revealed: false,
};
const els = {};
let tileEls = [];

const WIN_COLOR = '#1f7a46';
const LOSE_COLOR = '#b3261e';

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

// ---------- Tutorial ----------
const PROGRESS_KEY = 'gerrymander.tutorialProgress'; // number of lessons completed
const SKIPPED_KEY = 'gerrymander.tutorialSkipped';
const LABEL_KEY = 'gerrymander.tileLabel';

function storageGet(key) {
  try { return window.localStorage.getItem(key); } catch (e) { return null; }
}
function storageSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch (e) { /* storage is optional */ }
}
const lessonsCompleted = () => Math.min(TUTORIAL.length, Number(storageGet(PROGRESS_KEY)) || 0);

function buildLessonMap(index) {
  const L = TUTORIAL[index];
  const tiles = buildGrid(L.cols, L.rows);
  tiles.forEach((t, i) => {
    t.pop = L.pops[i];
    t.lean = L.leans[i];
  });
  const totalPop = tiles.reduce((s, t) => s + t.pop, 0);
  return {
    sizeKey: null,
    seed: null,
    cfg: { cols: L.cols, rows: L.rows, districts: L.districts },
    tiles,
    ideal: totalPop / L.districts,
    target: L.target,
    totalPop,
    statewideShare: tiles.reduce((s, t) => s + (t.pop * t.lean) / 100, 0) / totalPop,
    tolerance: L.tolerance,
    mode: L.mode,
    lesson: index,
    solution: L.solution.slice(),
    winFraction: null,
  };
}

function startLesson(index) {
  ui.view = 'votes';
  loadMap(buildLessonMap(index));
}

function completeLesson(index) {
  if (lessonsCompleted() < index + 1) storageSet(PROGRESS_KEY, String(index + 1));
}

function leaveTutorial() {
  storageSet(SKIPPED_KEY, '1');
  startGame(els.size.value, randomSeed());
}

function renderLesson() {
  const inLesson = game.lesson != null;
  els.lesson.hidden = !inLesson;
  if (!inLesson) return;
  const L = TUTORIAL[game.lesson];
  const done = lessonsCompleted();
  els.lessonSteps.innerHTML = '';
  TUTORIAL.forEach((_, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'step' + (i === game.lesson ? ' current' : '') + (i < done ? ' done' : '');
    btn.textContent = i < done && i !== game.lesson ? '✓' : String(i + 1);
    const locked = i > done && i !== game.lesson;
    btn.disabled = locked;
    btn.title = locked ? 'Finish the earlier lessons first' : TUTORIAL[i].title;
    btn.setAttribute('aria-label', `Lesson ${i + 1}: ${TUTORIAL[i].title}`);
    btn.addEventListener('click', () => startLesson(i));
    els.lessonSteps.append(btn);
  });
  els.lessonTitle.textContent = L.title;
  els.lessonIntro.textContent = L.intro;
  els.lessonTip.textContent = L.tip;
}

// ---------- Text helpers that depend on the map's mode ----------
const unitWord = () => (game.mode === 'voters' ? 'voters' : 'people');
const supports = (t) => t.lean > 50;
const votesFor = (s) => Math.round(s.votes);
const votesAgainst = (s) => Math.round(s.pop - s.votes);

function shareText(s) {
  if (game.mode === 'percent') return fmtPct(s.share);
  return `${votesFor(s)} for / ${votesAgainst(s)} against`;
}

function shareShort(s) {
  if (game.mode === 'percent') return Math.round(s.share * 100) + '%';
  return `${votesFor(s)}–${votesAgainst(s)}`;
}

function popBounds() {
  return { lo: game.ideal * (1 - game.tolerance), hi: game.ideal * (1 + game.tolerance) };
}

function popRangeText() {
  const { lo, hi } = popBounds();
  if (game.tolerance === 0) return `exactly ${fmtInt(game.ideal)} ${unitWord()}`;
  return `${fmtInt(Math.ceil(lo - 1e-9))}–${fmtInt(Math.floor(hi + 1e-9))} people`;
}

// Short description of what's wrong with a district, or null if it is legal.
function districtIssue(s) {
  if (!s.tiles.length) return 'Empty';
  if (!s.connected) return 'Split into separate pieces';
  if (!s.popOk) {
    const { lo, hi } = popBounds();
    if (s.pop > hi) return `${fmtInt(Math.ceil(s.pop - hi - 1e-9))} too many ${unitWord()}`;
    return `${fmtInt(Math.ceil(lo - s.pop - 1e-9))} too few ${unitWord()}`;
  }
  return null;
}

const isLegal = (s) => s.tiles.length > 0 && s.connected && s.popOk;

// ---------- Loading maps ----------
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
    for (const key of ['size', 'seed', 'tutorial']) url.searchParams.delete(key);
    if (game.lesson != null) {
      url.searchParams.set('tutorial', String(game.lesson + 1));
    } else {
      url.searchParams.set('size', game.sizeKey);
      url.searchParams.set('seed', String(game.seed));
    }
    window.history.replaceState(null, '', url);
  } catch (e) { /* URL updates are optional */ }
  renderLesson();
  renderLegend();
  buildBoard();
  buildDistrictList();
  render();
}

function renderLegend() {
  const opp = `rgb(${OPPONENT_RGB.join(',')})`;
  const you = `rgb(${PLAYER_RGB.join(',')})`;
  if (game.mode === 'percent') {
    els.legend.innerHTML = `<span>Opponent</span><span class="legend-bar" aria-hidden="true"></span><span>Your candidate</span>`;
  } else {
    els.legend.innerHTML = `
      <span class="legend-chip" style="background:${opp}" aria-hidden="true"></span><span>✗ Votes for opponent</span>
      <span class="legend-chip" style="background:${you}" aria-hidden="true"></span><span>✓ Votes for you</span>`;
  }
}

// ---------- Board rendering ----------
function buildBoard() {
  const { cols, rows } = game.cfg;
  const w = PAD * 2 + SQRT3 * HEX * (cols + 0.5);
  const h = PAD * 2 + HEX * 2 + 1.5 * HEX * (rows - 1);
  els.board.setAttribute('viewBox', `0 0 ${w.toFixed(1)} ${h.toFixed(1)}`);
  els.board.innerHTML = '';

  const gTiles = svgEl('g');
  tileEls = game.tiles.map((t) => {
    const g = svgEl('g', { class: 'tile', 'data-id': t.id });
    const poly = svgEl('polygon', { class: 'hex', points: hexPoints(t.x, t.y, HEX) });
    const main = svgEl('text', { class: 'num', x: t.x, y: t.y + 7 });
    const sub = svgEl('text', { class: 'sub', x: t.x, y: t.y + 21 });
    g.append(poly, main, sub);
    gTiles.append(g);
    return { g, poly, main, sub };
  });
  els.defs = svgEl('defs');
  els.borderGroup = svgEl('g', { class: 'district-borders' });
  els.badges = svgEl('g', { class: 'badges' });
  els.board.append(els.defs, gTiles, els.borderGroup, els.badges);
}

function tileText(t) {
  if (game.mode === 'voters') return [supports(t) ? '✓' : '✗', ''];
  if (game.mode === 'binary') return [fmtInt(t.pop), supports(t) ? '✓' : '✗'];
  if (ui.label === 'both') return [fmtK(t.pop), t.lean + '%'];
  return ui.label === 'pop' ? [fmtK(t.pop), ''] : [t.lean + '%', ''];
}

function renderTiles() {
  const focus = typeof ui.tool === 'number' ? ui.tool : null;
  for (const t of game.tiles) {
    const el = tileEls[t.id];
    const d = ui.assign[t.id];
    const fill = ui.view === 'votes' ? leanColor(t.lean) : d >= 0 ? DISTRICT_COLORS[d] : null;
    el.poly.style.fill = fill || 'var(--unassigned)';

    const [main, sub] = tileText(t);
    const tone = fill ? (isDark(fill) ? ' on-dark' : ' on-light') : '';
    el.main.textContent = main;
    el.sub.textContent = sub;
    el.main.setAttribute('class', 'num' + (game.mode === 'voters' ? ' mark' : '') + tone);
    el.main.setAttribute('y', sub ? t.y + 5 : t.y + 8);
    el.sub.setAttribute('class', 'sub' + tone);

    // Lightly fade tiles that belong to a district other than the selected one.
    el.g.classList.toggle('faded', focus !== null && d >= 0 && d !== focus);
  }
}

// Each district gets an outline in its own colour. The stroke is centred on
// the boundary and clipped to the district's tiles, so only the inner half
// shows and neighbouring districts' outlines sit side by side.
function renderBorders() {
  const n = game.cfg.districts;
  const paths = new Array(n).fill('');
  const clips = range(n).map(() => []);
  for (const t of game.tiles) {
    const a = ui.assign[t.id];
    if (a < 0) continue;
    clips[a].push(hexPoints(t.x, t.y, HEX + 0.5));
    for (let i = 0; i < 6; i++) {
      const j = t.nbrs[i];
      if (j >= 0 && ui.assign[j] === a) continue;
      const [x1, y1] = hexCorner(t.x, t.y, HEX, i);
      const [x2, y2] = hexCorner(t.x, t.y, HEX, (i + 1) % 6);
      paths[a] += `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`;
    }
  }
  els.defs.innerHTML = '';
  els.borderGroup.innerHTML = '';
  for (let d = 0; d < n; d++) {
    if (!paths[d]) continue;
    const clip = svgEl('clipPath', { id: `district-clip-${d}` });
    for (const pts of clips[d]) clip.append(svgEl('polygon', { points: pts }));
    els.defs.append(clip);
    els.borderGroup.append(svgEl('path', {
      d: paths[d],
      class: 'dborder' + (focus() === d ? ' focused' : ''),
      stroke: DISTRICT_COLORS[d],
      'clip-path': `url(#district-clip-${d})`,
    }));
  }
}

const focus = () => (typeof ui.tool === 'number' ? ui.tool : null);

// A badge on each district: its number, then its result (green = you lead).
function renderBadges(stats) {
  els.badges.innerHTML = '';
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
    const y = t.y - 17;
    const r = 9;

    const g = svgEl('g', { class: 'badge' });
    const pill = svgEl('rect', { y: y - r, height: r * 2, rx: r, fill: s.wins ? WIN_COLOR : LOSE_COLOR });
    const value = svgEl('text', { class: 'b-val', y: y + 4 });
    value.textContent = (isLegal(s) ? '' : '⚠ ') + shareShort(s);
    const dot = svgEl('circle', { r, cy: y, fill: DISTRICT_COLORS[d] });
    const num = svgEl('text', { class: 'b-num', y: y + 4 });
    num.textContent = d + 1;
    g.append(pill, value, dot, num);
    els.badges.append(g);

    let textW = 0;
    try { textW = value.getComputedTextLength(); } catch (e) { /* not rendered */ }
    if (!textW) textW = value.textContent.length * 6.5;
    const width = r * 2 + textW + 9;
    const x0 = t.x - width / 2;
    pill.setAttribute('x', x0);
    pill.setAttribute('width', width);
    dot.setAttribute('cx', x0 + r);
    num.setAttribute('x', x0 + r);
    value.setAttribute('x', x0 + r * 2 + 3);
  });
}

// ---------- Tooltip ----------
function showTooltip(id, e) {
  if (id == null) {
    els.tooltip.hidden = true;
    return;
  }
  const t = game.tiles[id];
  const d = ui.assign[id];
  const who = supports(t) ? 'your candidate' : 'the opponent';
  let body;
  if (game.mode === 'voters') body = `One voter for ${who}`;
  else if (game.mode === 'binary') body = `${fmtInt(t.pop)} ${t.pop === 1 ? 'person' : 'people'}, all voting for ${who}`;
  else body = `Population ${fmtInt(t.pop)}<br>You ${t.lean}% · Opponent ${100 - t.lean}%`;
  const title = d >= 0
    ? `<span class="tt-dot" style="background:${DISTRICT_COLORS[d]}"></span>District ${d + 1}`
    : 'Not in a district';
  els.tooltip.innerHTML = `<strong>${title}</strong><br>${body}`;
  els.tooltip.hidden = false;

  const area = els.boardArea.getBoundingClientRect();
  const tw = els.tooltip.offsetWidth;
  const th = els.tooltip.offsetHeight;
  let x = e.clientX - area.left + 16;
  let y = e.clientY - area.top + 16;
  if (x + tw > area.width) x = e.clientX - area.left - tw - 16;
  if (y + th > area.height) y = e.clientY - area.top - th - 16;
  els.tooltip.style.left = `${Math.max(0, x)}px`;
  els.tooltip.style.top = `${Math.max(0, y)}px`;
}

// ---------- Status bar, mission and district list ----------
function renderStatus(stats) {
  const n = game.cfg.districts;
  const seats = stats.filter((s) => s.wins).length;
  const legal = stats.filter(isLegal).length;
  const assigned = ui.assign.filter((d) => d >= 0).length;
  els.stSeats.innerHTML =
    `<strong class="${seats >= game.target ? 'ok' : ''}">${seats}</strong> of ${n} <span class="need">need ${game.target}</span>`;
  els.stLegal.innerHTML = `<strong class="${legal === n ? 'ok' : ''}">${legal}</strong> of ${n}`;
  els.stTiles.innerHTML =
    `<strong class="${assigned === game.tiles.length ? 'ok' : ''}">${assigned}</strong> of ${game.tiles.length}`;
}

function renderMission(stats) {
  const n = game.cfg.districts;
  const T = game.tiles.length;
  const assigned = ui.assign.filter((d) => d >= 0).length;
  const connected = stats.filter((s) => s.tiles.length && s.connected).length;
  const sized = stats.filter((s) => s.popOk).length;
  const seats = stats.filter((s) => s.wins).length;

  let intro;
  if (game.mode === 'percent') {
    intro = `Your candidate expects <strong>${fmtPct(game.statewideShare)}</strong> of the statewide vote.`;
  } else {
    const yes = Math.round(game.statewideShare * game.totalPop);
    intro = `Your candidate has <strong>${fmtInt(yes)} of ${fmtInt(game.totalPop)}</strong> ${unitWord()}
             (${fmtPct(game.statewideShare, 0)}).`;
  }
  const items = [
    [assigned === T, 'Put every tile in a district', `${assigned} / ${T}`],
    [connected === n, `Keep each district in one piece`, `${connected} / ${n}`],
    [sized === n, `Give each district ${popRangeText()}`, `${sized} / ${n}`],
    [seats >= game.target, `Win at least ${game.target} of ${n} seats`, `${seats} now`],
  ];
  let html = `<h2>Your mission</h2><p>${intro}</p><ul class="checklist">`;
  for (const [done, text, count] of items) {
    html += `<li class="${done ? 'done' : ''}">
      <span class="check" aria-hidden="true">${done ? '✓' : ''}</span>
      <span class="c-text">${text}</span>
      <span class="c-count">${count}</span>
      <span class="sr-only">${done ? '(done)' : '(not yet)'}</span></li>`;
  }
  html += '</ul>';
  if (game.lesson == null) {
    html += `<p class="muted small">Difficulty: ${difficultyText()} · Map #${game.seed}</p>`;
  }
  els.goal.innerHTML = html;
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
        <span class="d-status"></span>
      </span>
      <span class="d-vote"><span class="v-main"></span><span class="v-sub"></span></span>`;
    btn.addEventListener('click', () => setTool(d));
    els.districtList.append(btn);
  }
  els.districtHead.lastElementChild.textContent = game.mode === 'percent' ? 'Vote for you' : 'For / against';
}

function renderDistrictList(stats) {
  const scale = 1.25; // the bar covers 0–125% of the ideal population
  const tol = game.tolerance;
  const rows = els.districtList.querySelectorAll('.district-row');
  stats.forEach((s, d) => {
    const row = rows[d];
    row.classList.toggle('active', ui.tool === d);
    const popEl = row.querySelector('.d-pop');
    const statusEl = row.querySelector('.d-status');
    const vMain = row.querySelector('.v-main');
    const vSub = row.querySelector('.v-sub');
    const fill = row.querySelector('.fill');
    const band = row.querySelector('.band');

    band.style.left = `${((1 - tol) / scale) * 100}%`;
    band.style.width = `${Math.max((2 * tol) / scale, 0.01) * 100}%`;
    fill.style.width = `${Math.min(s.pop / game.ideal / scale, 1) * 100}%`;
    fill.className = 'fill ' + (s.popOk ? 'ok' : s.dev > tol ? 'over' : '');

    const issue = districtIssue(s);
    if (!s.tiles.length) {
      popEl.innerHTML = `<span class="muted">0 ${unitWord()}</span>`;
      statusEl.className = 'd-status muted';
      statusEl.textContent = 'Empty';
      vMain.textContent = '—';
      vMain.className = 'v-main muted';
      vSub.textContent = '';
      return;
    }
    if (game.mode === 'voters') {
      popEl.textContent = `${s.pop} of ${fmtInt(game.ideal)} voters`;
    } else {
      popEl.innerHTML = `${fmtInt(s.pop)} people <small>(${fmtSigned(s.dev)})</small>`;
    }
    statusEl.className = 'd-status ' + (issue ? 'bad' : 'ok');
    statusEl.textContent = issue ? `⚠ ${issue}` : '✓ Legal';

    vMain.className = 'v-main ' + (s.wins ? 'win' : 'lose');
    if (game.mode === 'percent') {
      vMain.textContent = fmtPct(s.share);
      vSub.textContent = s.wins ? 'you lead' : 'opponent leads';
    } else {
      vMain.textContent = `${votesFor(s)} for`;
      vSub.textContent = `${votesAgainst(s)} against`;
    }
  });
  els.eraser.classList.toggle('active', ui.tool === 'erase');
}

function renderControls() {
  for (const btn of els.viewButtons) btn.setAttribute('aria-pressed', String(btn.dataset.view === ui.view));
  for (const btn of els.labelButtons) btn.setAttribute('aria-pressed', String(btn.dataset.label === ui.label));
  els.labelToggle.hidden = game.mode !== 'percent';
  els.legend.classList.toggle('hidden', ui.view !== 'votes');
}

function currentStats() {
  return computeStats(game.tiles, ui.assign, game.cfg.districts, game.ideal, game.tolerance);
}

function render() {
  if (!game) return;
  const stats = currentStats();
  renderTiles();
  renderBorders();
  renderBadges(stats);
  renderStatus(stats);
  renderMission(stats);
  renderDistrictList(stats);
  renderControls();
}

// ---------- Interaction ----------
function setTool(tool) {
  ui.tool = tool;
  render();
}

function setView(view) {
  ui.view = view;
  render();
}

function setLabel(label) {
  ui.label = label;
  storageSet(LABEL_KEY, label);
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
    if (!game || id == null || (e.button !== undefined && e.button !== 0)) return;
    e.preventDefault();
    ui.painting = ui.tool === 'erase' || ui.assign[id] === ui.tool ? 'erase' : 'paint';
    ui.lastPainted = null;
    try { els.board.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    applyPaint(id);
  });
  els.board.addEventListener('pointermove', (e) => {
    if (!game) return;
    const id = tileAt(e);
    showTooltip(id, e);
    if (ui.painting) applyPaint(id);
  });
  els.board.addEventListener('pointerleave', () => showTooltip(null));
  const stop = () => { ui.painting = null; ui.lastPainted = null; };
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);

  els.eraser.addEventListener('click', () => setTool('erase'));
  els.reset.addEventListener('click', () => {
    if (!game) return;
    if (ui.assign.some((d) => d >= 0) && !window.confirm('Clear all districts on this map?')) return;
    ui.assign.fill(-1);
    render();
  });
  els.newMap.addEventListener('click', () => startGame(els.size.value, randomSeed()));
  els.size.addEventListener('change', () => startGame(els.size.value, randomSeed()));
  for (const btn of els.viewButtons) btn.addEventListener('click', () => setView(btn.dataset.view));
  for (const btn of els.labelButtons) btn.addEventListener('click', () => setLabel(btn.dataset.label));
  els.submit.addEventListener('click', holdElection);
  els.tutorialBtn.addEventListener('click', () => startLesson(Math.min(lessonsCompleted(), TUTORIAL.length - 1)));
  els.skipTutorial.addEventListener('click', leaveTutorial);

  document.addEventListener('keydown', (e) => {
    if (!game || els.dialog.open || e.target.closest('input, select, textarea')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const num = Number(e.key);
    if (Number.isInteger(num) && num >= 1 && num <= game.cfg.districts) setTool(num - 1);
    else if (e.key === 'e' || e.key === 'E') setTool('erase');
    else if (e.key === 'v' || e.key === 'V') setView(ui.view === 'votes' ? 'districts' : 'votes');
    else if ((e.key === 'l' || e.key === 'L') && game.mode === 'percent') {
      const order = ['lean', 'pop', 'both'];
      setLabel(order[(order.indexOf(ui.label) + 1) % order.length]);
    }
  });
}

// ---------- Election ----------
function validatePlan(stats) {
  const problems = [];
  const unassigned = ui.assign.filter((d) => d < 0).length;
  if (unassigned) problems.push(`${unassigned} tile${unassigned === 1 ? ' is' : 's are'} not in any district.`);
  stats.forEach((s, d) => {
    const issue = districtIssue(s);
    if (!issue) return;
    const extra = !s.popOk && s.tiles.length && s.connected ? ` It needs ${popRangeText()}.` : '';
    problems.push(`District ${d + 1}: ${issue.charAt(0).toLowerCase() + issue.slice(1)}.${extra}`);
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
  const stats = currentStats();
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
      <td class="num">${shareText(s)}</td>
      <td class="${s.wins ? 'win' : 'lose'}">${s.wins ? '✓ You' : '✗ Opponent'}</td>
    </tr>`).join('');

  const lesson = game.lesson != null ? TUTORIAL[game.lesson] : null;
  const unitHeader = game.mode === 'voters' ? 'Voters' : 'Population';
  const voteHeader = game.mode === 'percent' ? 'Your vote' : 'Votes';
  const title = lesson ? (won ? 'Lesson complete!' : 'Not quite') : won ? 'Victory!' : 'Defeat';
  const body = `
    <h2>${title}</h2>
    <p>Your candidate won <strong>${seats} of ${game.cfg.districts}</strong> seats
       (${fmtPct(seats / game.cfg.districts, 0)} of seats) with ${fmtPct(game.statewideShare)} of the statewide vote.
       ${won ? '' : `You needed ${game.target}.`}</p>
    <table class="results-table">
      <thead><tr><th>District</th><th class="num">${unitHeader}</th><th class="num">${voteHeader}</th><th>Winner</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${lesson && won ? `<p class="debrief">${lesson.debrief}</p>` : ''}`;

  let actions;
  if (lesson) {
    const index = game.lesson;
    if (won) completeLesson(index);
    renderLesson();
    const last = index === TUTORIAL.length - 1;
    actions = won
      ? [
          { label: 'Keep editing' },
          last
            ? { label: 'Start playing', primary: true, onClick: leaveTutorial }
            : { label: 'Next lesson', primary: true, onClick: () => startLesson(index + 1) },
        ]
      : [
          { label: 'Show a winning plan', onClick: revealSolution },
          { label: 'Keep trying', primary: true },
        ];
  } else {
    actions = won
      ? [
          { label: 'Keep editing' },
          { label: 'Next map', primary: true, onClick: () => startGame(els.size.value, randomSeed()) },
        ]
      : [
          { label: 'Show a winning plan', onClick: revealSolution },
          { label: 'Keep trying', primary: true },
        ];
  }
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
  els.boardArea = $('#board-area');
  els.tooltip = $('#tooltip');
  els.size = $('#size-select');
  els.newMap = $('#new-map');
  els.reset = $('#reset');
  els.viewButtons = document.querySelectorAll('[data-view]');
  els.labelButtons = document.querySelectorAll('[data-label]');
  els.labelToggle = $('#label-toggle');
  els.submit = $('#submit');
  els.stSeats = $('#st-seats');
  els.stLegal = $('#st-legal');
  els.stTiles = $('#st-tiles');
  els.goal = $('#goal');
  els.districtHead = $('#district-head');
  els.districtList = $('#district-list');
  els.eraser = $('#eraser-btn');
  els.legend = $('#legend');
  els.dialog = $('#result-dialog');
  els.dialogBody = $('#result-body');
  els.dialogActions = $('#result-actions');
  els.loading = $('#loading');
  els.lesson = $('#lesson');
  els.lessonSteps = $('#lesson-steps');
  els.lessonTitle = $('#lesson-title');
  els.lessonIntro = $('#lesson-intro');
  els.lessonTip = $('#lesson-tip');
  els.tutorialBtn = $('#tutorial-btn');
  els.skipTutorial = $('#skip-tutorial');

  for (const [key, cfg] of Object.entries(SIZES)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = cfg.label;
    els.size.append(opt);
  }
  if (['pop', 'both'].includes(storageGet(LABEL_KEY))) ui.label = storageGet(LABEL_KEY);

  const params = new URLSearchParams(window.location.search);
  const sizeKey = SIZES[params.get('size')] ? params.get('size') : 'medium';
  const seedParam = parseInt(params.get('seed'), 10);
  els.size.value = sizeKey;
  bindEvents();

  const lessonParam = parseInt(params.get('tutorial'), 10);
  if (lessonParam >= 1 && lessonParam <= TUTORIAL.length) {
    startLesson(lessonParam - 1);
  } else if (Number.isFinite(seedParam) && seedParam >= 0) {
    startGame(sizeKey, seedParam);
  } else if (!storageGet(SKIPPED_KEY) && lessonsCompleted() < TUTORIAL.length) {
    // First visit: start with the next unfinished lesson.
    startLesson(lessonsCompleted());
  } else {
    startGame(sizeKey, randomSeed());
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
if (typeof module !== 'undefined') {
  module.exports = { generateMap, computeStats, SIZES, TOLERANCE, buildGrid, sampleLegalPlans, findBestPlan, mulberry32, generateGeography, TUTORIAL };
}
