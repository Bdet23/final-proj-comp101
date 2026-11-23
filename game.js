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
// Draw a smaller inner hex whose area shows each tile's population.
// Set to false to go back to plain tiles (colour only).
const SIZE_TILES_BY_POPULATION = true;
const MIN_TILE_SCALE = 0.3;      // smallest inner hex, as a fraction of the tile
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
  // more for real states with up to 17 districts
  '#2f6f63', '#b8860b', '#6b8e23', '#6e4b2a', '#7a869a',
  '#a0a035', '#3f9f7f', '#8f7442', '#4d7f4d',
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

// Irregular board (a real state): only the listed [col, row] cells exist.
function buildMaskedGrid(cols, rows, cells) {
  const index = new Map(cells.map(([c, r], i) => [r * cols + c, i]));
  const tiles = cells.map(([c, r], i) => ({
    id: i,
    col: c,
    row: r,
    x: PAD + SQRT3 * HEX * (c + 0.5 * (r & 1)) + (SQRT3 * HEX) / 2,
    y: PAD + HEX + 1.5 * HEX * r,
    pop: 0,
    lean: 50,
    nbrs: [],
  }));
  for (const t of tiles) {
    const dirs = t.row & 1 ? DIRS_ODD : DIRS_EVEN;
    t.nbrs = dirs.map(([dc, dr]) => {
      const c = t.col + dc;
      const r = t.row + dr;
      if (c < 0 || c >= cols || r < 0 || r >= rows) return -1;
      const j = index.get(r * cols + c);
      return j === undefined ? -1 : j;
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

// Votes cast in a tile. Only Realistic maps give tiles a turnout rate;
// everywhere else every resident votes.
const votersOf = (t) => (t.turnout ? t.pop * t.turnout : t.pop);

function computeStats(tiles, assign, n, ideal, tol = TOLERANCE) {
  // pop = residents (sets district size), voters = votes cast, votes = votes for you
  const stats = range(n).map(() => ({ tiles: [], pop: 0, voters: 0, votes: 0 }));
  for (const t of tiles) {
    const d = assign[t.id];
    if (d >= 0) {
      const vt = votersOf(t);
      stats[d].tiles.push(t.id);
      stats[d].pop += t.pop;
      stats[d].voters += vt;
      stats[d].votes += (vt * t.lean) / 100;
    }
  }
  for (const s of stats) {
    s.share = s.voters > 0 ? s.votes / s.voters : 0;
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

function generateGeography(tiles, cfg, rand, shareRange = null) {
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
  const targetShare = shareRange ? lerp(shareRange[0], shareRange[1], rand()) : 0.42 + rand() * 0.06;
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

function sampleLegalPlans(tiles, n, ideal, rand, tol = TOLERANCE, count = ENSEMBLE_SIZE, iters = 4000, t0 = 0.05, t1 = 0.002) {
  const samples = [];
  for (let k = 0; k < count * 2 && samples.length < count; k++) {
    const start = growPartition(tiles, n, rand);
    if (!start) continue;
    const r = anneal(tiles, start, n, ideal, rand, {
      seatW: 0, marginW: 0, penW: 30, t0, t1, iters, stopWhenValid: true, tol,
    });
    if (r) samples.push(r);
  }
  return samples;
}

function findBestPlan(tiles, n, ideal, samples, rand, tol = TOLERANCE, iters = 25000) {
  const starts = samples.slice().sort((a, b) => b.seats - a.seats).slice(0, 4);
  let best = null;
  for (const s of starts) {
    const r = anneal(tiles, s.plan, n, ideal, rand, {
      seatW: 1, marginW: 0.25, penW: 25, t0: 0.6, t1: 0.02, iters, stopWhenValid: false, tol,
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

// ---------- Realistic mode: uncertain elections ----------
// Each simulated election shifts every tile's expected vote share by:
//   a statewide swing (shared by every tile),
//   regional swings (shared by nearby tiles),
//   and a little local noise.
// Because most of the swing is shared, narrow seats tend to fall together,
// like a real "wave" election. A plan passes when its chance of reaching
// the seat target is at least PASS_PROBABILITY.

const SIMULATIONS = 1000;
const SWING_STATE = 0.03;      // standard deviation of the statewide swing (3 points)
const SWING_REGION = 0.02;     // regional swing (2 points)
const SWING_TILE = 0.015;      // local noise per tile (1.5 points)
const REGION_COUNT = 4;
const PASS_PROBABILITY = 0.7;  // required chance of reaching the seat target
const DISTRICT_SIGMA = 0.035;  // typical spread of a district's result, used for quick estimates
const REALISTIC_SHARE_RANGE = [0.45, 0.49];
// Turnout uncertainty (Realistic maps with turnout): relative changes in votes cast.
const TURNOUT_STATE = 0.05;  // statewide turnout up or down by about 5% of its usual level
const TURNOUT_GAP = 0.05;    // enthusiasm gap: one side's voters turn out about 5% more than the other's
const TURNOUT_TILE = 0.04;   // local turnout noise per tile

function gaussian(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// Standard normal cumulative distribution (Abramowitz–Stegun approximation).
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// Precompute the swings for every simulated election. Every plan on this map
// is judged against the same elections, so odds don't jitter while drawing.
function buildUncertainty(tiles, seed, withTurnout = false) {
  const rand = mulberry32(seed);
  const T = tiles.length;
  const step = SQRT3 * HEX;
  const regions = range(REGION_COUNT).map(() => tiles[Math.floor(rand() * T)]);
  const weights = tiles.map((t) => {
    const w = regions.map((c) => Math.exp(-((t.x - c.x) ** 2 + (t.y - c.y) ** 2) / (2 * (step * 2.5) ** 2)));
    const norm = Math.sqrt(w.reduce((s, x) => s + x * x, 0)) || 1;
    return w.map((x) => x / norm);
  });
  const shift = new Float32Array(SIMULATIONS * T);
  const state = new Float32Array(SIMULATIONS);
  for (let s = 0; s < SIMULATIONS; s++) {
    const z0 = gaussian(rand) * SWING_STATE;
    const zr = regions.map(() => gaussian(rand) * SWING_REGION);
    state[s] = z0;
    for (let i = 0; i < T; i++) {
      let reg = 0;
      for (let r = 0; r < REGION_COUNT; r++) reg += weights[i][r] * zr[r];
      shift[s * T + i] = z0 + reg + gaussian(rand) * SWING_TILE;
    }
  }
  const unc = { sims: SIMULATIONS, shift, state, regions: regions.map((t) => t.id), weights };
  if (withTurnout) {
    // A separate random stream, so preference swings are the same with or without turnout.
    const rt = mulberry32((seed ^ 0x5bd1e995) >>> 0);
    unc.tScale = new Float32Array(SIMULATIONS * T); // multiplier on each tile's votes cast
    unc.tState = new Float32Array(SIMULATIONS);     // statewide turnout change
    unc.gap = new Float32Array(SIMULATIONS);        // > 0: your side's voters turn out more
    for (let s = 0; s < SIMULATIONS; s++) {
      const tau = gaussian(rt) * TURNOUT_STATE;
      unc.tState[s] = tau;
      unc.gap[s] = gaussian(rt) * TURNOUT_GAP;
      for (let i = 0; i < T; i++) unc.tScale[s * T + i] = Math.max(0.3, 1 + tau + gaussian(rt) * TURNOUT_TILE);
    }
  }
  return unc;
}

// Votes for you and for the opponent in tile i of simulation s.
function simVotes(tiles, unc, i, s, T) {
  const t = tiles[i];
  const share = clampShare(t.lean / 100 + unc.shift[s * T + i]);
  if (!unc.tScale) {
    const vt = votersOf(t);
    return [vt * share, vt * (1 - share)];
  }
  const vt = votersOf(t) * unc.tScale[s * T + i];
  const g = unc.gap[s];
  return [vt * share * (1 + g / 2), vt * (1 - share) * (1 - g / 2)];
}

const clampShare = (v) => (v < 0.02 ? 0.02 : v > 0.98 ? 0.98 : v);

// Run every simulated election for a (possibly partial) plan.
function simulatePlan(map, assign) {
  const { tiles, unc } = map;
  const n = map.cfg.districts;
  const T = tiles.length;
  const pop = new Float64Array(n);
  for (const t of tiles) if (assign[t.id] >= 0) pop[assign[t.id]] += t.pop;
  const wins = new Float64Array(n);
  const hist = new Array(n + 1).fill(0);
  const you = new Float64Array(n);
  const opp = new Float64Array(n);
  const N = unc.sims;
  const shareBuf = new Float32Array(n * N); // every district's share in every simulation
  for (let s = 0; s < unc.sims; s++) {
    you.fill(0);
    opp.fill(0);
    for (let i = 0; i < T; i++) {
      const d = assign[i];
      if (d < 0) continue;
      const [a, b] = simVotes(tiles, unc, i, s, T);
      you[d] += a;
      opp[d] += b;
    }
    let seats = 0;
    for (let d = 0; d < n; d++) {
      const share = pop[d] > 0 ? you[d] / (you[d] + opp[d]) : 0;
      if (pop[d] > 0) shareBuf[d * N + s] = share;
      if (pop[d] > 0 && share > 0.5) {
        wins[d]++;
        seats++;
      }
    }
    hist[seats]++;
  }
  const winProb = Array.from(wins, (w) => w / unc.sims);
  const seatProb = hist.map((h) => h / unc.sims);
  const pTarget = seatProb.slice(map.target).reduce((a, b) => a + b, 0);
  const expectedSeats = seatProb.reduce((s, p, k) => s + p * k, 0);
  // Likely (middle 50%) and plausible (middle 90%) range of each district's share.
  const ranges = range(n).map((d) => {
    if (!pop[d]) return null;
    const sorted = shareBuf.slice(d * N, (d + 1) * N).sort();
    const q = (f) => sorted[Math.min(N - 1, Math.floor(f * N))];
    return { q05: q(0.05), q25: q(0.25), q50: q(0.5), q75: q(0.75), q95: q(0.95) };
  });
  return { winProb, seatProb, pTarget, expectedSeats, ranges };
}

// Vote share in one tile after a statewide swing and a turnout gap
// (gap > 0: your side's voters turn out that much more, relatively).
function tileShareAt(t, swing, gap = 0) {
  const sh = clampShare(t.lean / 100 + swing);
  if (!gap) return sh;
  const a = sh * (1 + gap / 2);
  return a / (a + (1 - sh) * (1 - gap / 2));
}

// District share if every tile moved by the same statewide swing (and turnout gap).
function swungShare(tiles, ids, swing, gap = 0) {
  let vt = 0;
  let v = 0;
  for (const i of ids) {
    const t = tiles[i];
    const sh = clampShare(t.lean / 100 + swing);
    const w = votersOf(t);
    const a = w * sh * (1 + gap / 2);
    v += a;
    vt += a + w * (1 - sh) * (1 - gap / 2);
  }
  return vt ? v / vt : 0;
}

function districtTileIds(map, assign) {
  const ids = range(map.cfg.districts).map(() => []);
  map.tiles.forEach((t) => { if (assign[t.id] >= 0) ids[assign[t.id]].push(t.id); });
  return ids;
}

// Cushion: how many points of statewide swing against you each district can
// absorb before it flips (negative = it needs a swing toward you). The map's
// breaking point is the cushion of the weakest district you need.
function computeCushions(map, assign) {
  const ids = districtTileIds(map, assign);
  const cushions = ids.map((list) => {
    if (!list.length) return null;
    const share = (x) => swungShare(map.tiles, list, x);
    if (share(-0.5) > 0.5) return 0.5;
    if (share(0.5) <= 0.5) return -0.5;
    let lo = -0.5;
    let hi = 0.5;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (share(mid) > 0.5) hi = mid; else lo = mid;
    }
    return -hi;
  });
  const breaking = cushions.some((c) => c === null)
    ? null
    : cushions.slice().sort((a, b) => b - a)[map.target - 1];
  return { cushions, breaking };
}

// District vote shares in one particular simulated election.
function simulateOne(map, assign, s) {
  const { tiles, unc } = map;
  const n = map.cfg.districts;
  const T = tiles.length;
  const you = new Float64Array(n);
  const opp = new Float64Array(n);
  for (let i = 0; i < T; i++) {
    const d = assign[i];
    if (d < 0) continue;
    const [a, b] = simVotes(tiles, unc, i, s, T);
    you[d] += a;
    opp[d] += b;
  }
  return {
    shares: Array.from(you, (v, d) => (v + opp[d] ? v / (v + opp[d]) : 0)),
    swing: unc.state[s],
    turnout: unc.tState ? unc.tState[s] : null,
    gap: unc.gap ? unc.gap[s] : null,
  };
}

// The k-th highest district vote share. Because swings are mostly shared,
// the chance of winning k seats depends mainly on this one number.
function kthShare(shares, k) {
  return Array.from(shares).sort((a, b) => b - a)[k - 1];
}

const approxChance = (kth) => normCdf((kth - 0.5) / DISTRICT_SIGMA);

// Simulated annealing that maximises the k-th highest district share (with a
// small bonus for the other top districts), keeping districts connected and
// recording only legal plans.
function annealRobust(tiles, start, n, ideal, rand, o) {
  const T = tiles.length;
  const k = o.k;
  const assign = start.slice();
  const pop = new Array(n).fill(0);
  const cast = new Array(n).fill(0); // votes cast
  const votes = new Array(n).fill(0);
  const size = new Array(n).fill(0);
  for (const t of tiles) {
    const d = assign[t.id];
    pop[d] += t.pop;
    cast[d] += votersOf(t);
    votes[d] += (votersOf(t) * t.lean) / 100;
    size[d]++;
  }
  const tolAbs = ideal * o.tol;
  const excess = (p) => Math.max(0, Math.abs(p - ideal) - tolAbs) / ideal;
  const shares = cast.map((c, d) => votes[d] / c);
  const score = () => {
    const sorted = shares.slice().sort((a, b) => b - a);
    let top = 0;
    for (let i = 0; i < k; i++) top += sorted[i];
    return 100 * sorted[k - 1] + 10 * top;
  };
  let penalty = pop.reduce((s, p) => s + excess(p), 0);
  let energy = score() - o.penW * penalty;
  let bad = pop.filter((p) => excess(p) > 0).length;

  let best = null;
  let bestKth = -Infinity;
  const record = () => {
    const kth = kthShare(shares, k);
    if (kth > bestKth) {
      bestKth = kth;
      best = assign.slice();
    }
  };
  if (bad === 0) record();

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
    const c = votersOf(tiles[i]);
    const v = (c * tiles[i].lean) / 100;
    const oldA = shares[a];
    const oldB = shares[b];
    shares[a] = (votes[a] - v) / (cast[a] - c);
    shares[b] = (votes[b] + v) / (cast[b] + c);
    const newPenalty = penalty - excess(pop[a]) - excess(pop[b]) + excess(pop[a] - p) + excess(pop[b] + p);
    const newEnergy = score() - o.penW * newPenalty;
    const delta = newEnergy - energy;
    const revert = () => { shares[a] = oldA; shares[b] = oldB; };
    if (delta < 0 && rand() >= Math.exp(delta / temp)) { revert(); continue; }

    stamp++;
    let first = -1;
    for (const q of tiles[i].nbrs) if (q >= 0 && assign[q] === a) { first = q; break; }
    if (first < 0) { revert(); continue; }
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
    if (count !== size[a] - 1) { revert(); continue; }

    const wasBad = (excess(pop[a]) > 0 ? 1 : 0) + (excess(pop[b]) > 0 ? 1 : 0);
    assign[i] = b;
    pop[a] -= p; cast[a] -= c; votes[a] -= v; size[a]--;
    pop[b] += p; cast[b] += c; votes[b] += v; size[b]++;
    bad += (excess(pop[a]) > 0 ? 1 : 0) + (excess(pop[b]) > 0 ? 1 : 0) - wasBad;
    penalty = newPenalty;
    energy = newEnergy;
    if (bad === 0) record();
  }
  return best ? { plan: best, kth: bestKth } : null;
}

function findRobustPlan(tiles, n, ideal, target, starts, rand, tol, iters = 30000) {
  let best = null;
  for (const plan of starts) {
    const r = annealRobust(tiles, plan, n, ideal, rand, {
      k: target, tol, penW: 300, t0: 1.0, t1: 0.02, iters,
    });
    if (r && (!best || r.kth > best.kth)) best = r;
  }
  return best;
}

function planShares(tiles, plan, n) {
  const cast = new Array(n).fill(0);
  const votes = new Array(n).fill(0);
  for (const t of tiles) {
    cast[plan[t.id]] += votersOf(t);
    votes[plan[t.id]] += (votersOf(t) * t.lean) / 100;
  }
  return cast.map((c, d) => votes[d] / c);
}

// Turnout for a generated Realistic map: crowded tiles vote less, plus local variation.
function assignTurnout(tiles, rand) {
  const pops = tiles.map((t) => t.pop);
  const lo = Math.min(...pops);
  const hi = Math.max(...pops);
  for (const t of tiles) {
    const density = (t.pop - lo) / (hi - lo || 1);
    t.turnout = Math.round(Math.min(0.85, Math.max(0.4, 0.7 - 0.14 * density + (rand() - 0.5) * 0.12)) * 1000) / 1000;
  }
}

// Like generateMap, but the target is a PASS_PROBABILITY chance of winning
// a majority of seats, and difficulty is judged by the same standard.
function generateRealisticMap(sizeKey, seed) {
  const cfg = SIZES[sizeKey];
  const n = cfg.districts;
  const target = Math.floor(n / 2) + 1;
  let fallback = null;

  for (let attempt = 0; attempt < MAP_ATTEMPTS; attempt++) {
    const rand = mulberry32(seed * 7919 + attempt + 500009);
    const tiles = buildGrid(cfg.cols, cfg.rows);
    generateGeography(tiles, cfg, rand, REALISTIC_SHARE_RANGE);
    assignTurnout(tiles, mulberry32(seed * 7919 + attempt + 900007));

    const totalPop = tiles.reduce((s, t) => s + t.pop, 0);
    const ideal = totalPop / n;
    const totalCast = tiles.reduce((s, t) => s + votersOf(t), 0);
    const statewideShare = tiles.reduce((s, t) => s + (votersOf(t) * t.lean) / 100, 0) / totalCast;
    if (statewideShare >= 0.5) continue;

    const samples = sampleLegalPlans(tiles, n, ideal, rand);
    if (samples.length < ENSEMBLE_SIZE / 2) continue;
    const scored = samples.map((s) => ({ plan: s.plan, kth: kthShare(planShares(tiles, s.plan, n), target) }));
    const winFraction = scored.filter((s) => approxChance(s.kth) >= PASS_PROBABILITY).length / scored.length;
    if (winFraction > 0.25) continue;

    const starts = scored.sort((a, b) => b.kth - a.kth).slice(0, 3).map((s) => s.plan);
    const best = findRobustPlan(tiles, n, ideal, target, starts, rand, TOLERANCE);
    if (!best) continue;

    const map = {
      sizeKey, cfg, seed, tiles, ideal, target, totalPop, statewideShare,
      tolerance: TOLERANCE, mode: 'percent', lesson: null, realistic: true, turnout: true,
      unc: buildUncertainty(tiles, seed * 31 + attempt, true),
      solution: best.plan, winFraction, sampleCount: samples.length,
    };
    const chance = simulatePlan(map, best.plan).pTarget;
    if (chance < PASS_PROBABILITY + 0.05) continue; // keep some slack so the map is clearly winnable
    map.solutionChance = chance;
    if (winFraction <= MAX_WIN_FRACTION) return map;
    if (!fallback || winFraction < fallback.winFraction) fallback = map;
  }
  if (fallback) return fallback;
  if (seed < 1e9) return generateRealisticMap(sizeKey, seed + 1000003);
  throw new Error('Could not generate a realistic map for seed ' + seed);
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
    debrief: "Mixing strong and weak tiles to push several districts just over 50% is how real maps are drawn. Next: what happens when results aren't certain.",
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

// Lesson 4 reuses lesson 3's map, but elections are uncertain. The lesson 3
// plan has one district at 50.6% and only a ~55% chance; spreading the
// margins evenly (about 53% each) reaches ~76%.
TUTORIAL.push({
  ...TUTORIAL[2],
  title: 'Lesson 4 · Wave elections',
  realistic: true,
  uncertaintySeed: 11,
  intro: "Same map as lesson 3, but now election results are uncertain: on election day the whole state can swing a few points, and so can each region. Badges now show each district's chance to win, and you need a 70% chance of winning 3 seats.",
  tip: "Tip: the lesson 3 plan only wins 3 seats about 55% of the time, because one district sits at 50.6%. Spread your margins evenly so all three of your districts are around 53%, instead of one safe seat and one on a knife-edge.",
  debrief: "When the whole state swings, narrow seats fall together. Real map-drawers trade some margin for safety, and gerrymanders that cut it too close can collapse in a <strong>wave election</strong>. You're ready for the real game: try Classic or Realistic mode.",
  solution: [
    2, 2, 2, 2, 2, 0, 0,
    2, 2, 3, 2, 0, 0, 1,
    2, 2, 3, 2, 3, 0, 1,
    2, 3, 3, 3, 3, 0, 1,
    2, 2, 2, 2, 3, 3, 1,
    2, 2, 2, 2, 1, 1, 1,
  ],
});

// ---------- Game state ----------
let game = null;
const ui = {
  assign: [],
  tool: 0,            // district index, or 'erase'
  view: 'votes',      // tile colour: 'votes', 'districts' or 'results'
  label: 'lean',      // tile numbers on full maps: 'lean' (vote %), 'pop', 'both' or 'none'
  realistic: false,   // preferred mode for generated maps
  campaign: false,    // Campaign mode (a decade of events on a Realistic map)
  sim: null,          // simulation results for the current plan (realistic maps only)
  cushions: null,     // swing each district can absorb (realistic maps only)
  swing: 0,           // stress-test swing toward your candidate, as a fraction (0.02 = 2 points)
  turnoutGap: 0,      // stress-test turnout gap: > 0 means your side's voters turn out more (0.04 = 4%)
  scenario: null,     // district shares under that swing
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

// span: how many points from 50% reach full colour.
// On real-state maps the colours follow the parties (Democrats blue,
// Republicans red); elsewhere you are blue and the opponent red.
const youRGB = () => (game && game.party === 'rep' ? OPPONENT_RGB : PLAYER_RGB);
const oppRGB = () => (game && game.party === 'rep' ? PLAYER_RGB : OPPONENT_RGB);
const PARTY_NAMES = { dem: 'Democrats', rep: 'Republicans' };
const youName = () => (game && game.party ? PARTY_NAMES[game.party] : 'Your candidate');
const oppName = () => (game && game.party ? PARTY_NAMES[game.party === 'dem' ? 'rep' : 'dem'] : 'Opponent');

function leanColor(pct, span = 30) {
  const t = Math.max(-1, Math.min(1, (pct - 50) / span));
  const target = t >= 0 ? youRGB() : oppRGB();
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
const MODE_KEY = 'gerrymander.mode'; // 'classic' or 'realistic'

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
    realistic: !!L.realistic,
    unc: L.realistic ? buildUncertainty(tiles, L.uncertaintySeed) : null,
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
const votesAgainst = (s) => Math.round(s.voters - s.votes);

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

// ---------- Real states ----------
const REAL_STATES = typeof STATE_DATA !== 'undefined' ? STATE_DATA : [];
const PARTY_KEY = 'gerrymander.party';
const findState = (code) => REAL_STATES.find((s) => s.code === code);

function buildStateMap(code, party, realistic) {
  const S = findState(code);
  const P = S.parties[party];
  const tiles = buildMaskedGrid(S.cols, S.rows, S.cells);
  tiles.forEach((t, i) => {
    const [, , pop, dem, county, turnout] = S.cells[i];
    t.pop = pop;
    t.lean = party === 'dem' ? dem : Math.round((100 - dem) * 10) / 10;
    t.county = S.counties[county];
    if (realistic) t.turnout = turnout / 100; // real 2020 turnout, Realistic mode only
  });
  const totalPop = tiles.reduce((a, t) => a + t.pop, 0);
  return {
    sizeKey: code,
    seed: null,
    state: S,
    party,
    cfg: { cols: S.cols, rows: S.rows, districts: S.seats },
    tiles,
    ideal: totalPop / S.seats,
    target: realistic ? P.realisticTarget : P.target,
    totalPop,
    // The real 2020 two-party vote share, so results match the published figure.
    statewideShare: (party === 'dem' ? S.demShare : 100 - S.demShare) / 100,
    actualShare: (party === 'dem' ? S.demShare : 100 - S.demShare) / 100,
    tolerance: TOLERANCE,
    mode: 'percent',
    lesson: null,
    realistic,
    turnout: realistic,
    unc: realistic ? buildUncertainty(tiles, P.uncSeed, true) : null,
    solution: (realistic ? P.robustSolution : P.solution).slice(),
    winFraction: realistic ? P.realisticFraction : P.winFraction,
    sampleCount: P.sampleCount,
  };
}

function startGame(sizeKey, seed) {
  if (findState(sizeKey)) {
    loadMap(buildStateMap(sizeKey, ui.party, ui.realistic));
    return;
  }
  // Generation can take up to a second, so show a message and let the page paint first.
  els.loading.hidden = false;
  els.board.classList.add('busy');
  setTimeout(() => {
    try {
      loadMap(ui.realistic ? generateRealisticMap(sizeKey, seed) : generateMap(sizeKey, seed));
    } finally {
      els.loading.hidden = true;
      els.board.classList.remove('busy');
    }
  }, 30);
}

function loadMap(map) {
  game = map;
  game.maxPop = Math.max(...game.tiles.map((t) => t.pop));
  ui.assign = new Array(game.tiles.length).fill(-1);
  ui.tool = 0;
  ui.revealed = false;
  ui.swing = 0;
  ui.turnoutGap = 0;
  ui.legalPrev = null;
  game.campaignMode = ui.campaign && !!game.realistic && game.lesson == null;
  game.campaign = null;
  if (ui.view === 'change') ui.view = 'votes';
  if (!game.realistic && ui.view === 'regions') ui.view = 'votes';
  if (!game.turnout && ui.view === 'turnout') ui.view = 'votes';
  try {
    const url = new URL(window.location.href);
    for (const key of ['size', 'seed', 'tutorial', 'mode', 'state', 'party']) url.searchParams.delete(key);
    if (game.lesson != null) {
      url.searchParams.set('tutorial', String(game.lesson + 1));
    } else if (game.state) {
      url.searchParams.set('state', game.state.code);
      url.searchParams.set('party', game.party);
      if (game.realistic) url.searchParams.set('mode', game.campaignMode ? 'campaign' : 'realistic');
    } else {
      url.searchParams.set('size', game.sizeKey);
      url.searchParams.set('seed', String(game.seed));
      if (game.realistic) url.searchParams.set('mode', game.campaignMode ? 'campaign' : 'realistic');
    }
    window.history.replaceState(null, '', url);
  } catch (e) { /* URL updates are optional */ }
  renderLesson();
  ui.zoom = 'auto';
  buildBoard();
  buildDistrictList();
  requestAnimationFrame(() => sizeBoard(false));
  render();
}

const RESULT_SPAN = 20; // district results reach full colour at a 20-point lead

// ---------- Realistic-mode display helpers ----------
const TOSSUP_COLOR = '#a8650a';
const fmtChance = (p) => (p > 0.995 ? '>99%' : p < 0.005 ? '<1%' : Math.round(p * 100) + '%');
function chanceColor(p) {
  if (p >= 0.75) return WIN_COLOR;
  if (p <= 0.25) return LOSE_COLOR;
  return TOSSUP_COLOR;
}
function chanceWord(p) {
  if (p >= 0.9) return 'safe for you';
  if (p >= 0.75) return 'likely yours';
  if (p > 0.25) return 'toss-up';
  if (p > 0.1) return 'likely opponent';
  return 'safe for opponent';
}

// Region colours avoid the red/blue vote scale.
const REGION_RGB = [[142, 107, 191], [76, 160, 110], [217, 164, 58], [150, 110, 80]];
const fmtSwing = (x) => (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x * 100).toFixed(1);
const stressTesting = () => !!ui.scenario && (ui.swing !== 0 || ui.turnoutGap !== 0);
// "a −2.5 point swing and a +4% turnout gap", for labels
function stressText() {
  const parts = [];
  if (ui.swing) parts.push(`a ${fmtSwing(ui.swing)} point swing`);
  if (ui.turnoutGap) parts.push(`a ${ui.turnoutGap > 0 ? '+' : '−'}${Math.abs(Math.round(ui.turnoutGap * 100))}% turnout gap`);
  return parts.join(' and ');
}

// Turnout colour view: pale (low) to deep purple (high).
const TURNOUT_RGB = [94, 60, 153];
const TURNOUT_LO = 0.4;
const TURNOUT_HI = 0.85;
function turnoutColor(x) {
  const a = Math.max(0, Math.min(1, (x - TURNOUT_LO) / (TURNOUT_HI - TURNOUT_LO)));
  return `rgb(${NEUTRAL_RGB.map((v, i) => Math.round(v + (TURNOUT_RGB[i] - v) * a)).join(',')})`;
}

// Tile colour in the Regions view: the colour of the region whose swing
// affects the tile most, paler where several regions overlap.
function regionColor(i) {
  const w = game.unc.weights[i];
  let best = 0;
  for (let r = 1; r < w.length; r++) if (w[r] > w[best]) best = r;
  const strength = w[best] * w[best]; // share of the tile's regional swing from that region
  const rgb = NEUTRAL_RGB.map((v, c) => Math.round(v + (REGION_RGB[best][c] - v) * strength));
  return `rgb(${rgb.join(',')})`;
}

// Vote share shown for a tile, including any stress-test swing.
function shownLean(t) {
  if ((!ui.swing && !ui.turnoutGap) || !game.realistic) return t.lean;
  return Math.round(tileShareAt(t, ui.swing, ui.turnoutGap) * 100);
}

function sizeLegend() {
  if (!sizedTiles()) return '';
  const hex = (r) => `<svg viewBox="-12 -12 24 24" width="18" height="18" aria-hidden="true">
      <polygon points="${hexPoints(0, 0, 11)}" class="lg-rim"/><polygon points="${hexPoints(0, 0, 11 * r)}" class="lg-core"/></svg>`;
  if (game.turnout) {
    const pair = `<svg viewBox="-12 -12 24 24" width="18" height="18" aria-hidden="true">
      <polygon points="${hexPoints(0, 0, 11)}" class="lg-outline"/><polygon points="${hexPoints(0, 0, 7.5)}" class="lg-core"/></svg>`;
    return `<span class="legend-size">${pair}<span>Outline = residents, filled = votes cast</span></span>`;
  }
  return `<span class="legend-size">${hex(0.4)}${hex(0.94)}<span>Inner hex size = population</span></span>`;
}

function renderLegend() {
  const opp = `rgb(${oppRGB().join(',')})`;
  const you = `rgb(${youRGB().join(',')})`;
  const bar = `<span class="legend-bar" aria-hidden="true" style="background:linear-gradient(90deg, ${opp}, rgb(${NEUTRAL_RGB.join(',')}), ${you})"></span>`;
  if (ui.view === 'change') {
    els.legend.innerHTML = `<span>Moved toward ${oppName().toLowerCase() === 'opponent' ? 'opponent' : 'the ' + oppName()}</span>${bar}
      <span>Moved toward ${game.party ? 'the ' + youName() : 'you'}</span>
      <span class="legend-note">Change in vote share since ${campaignBaseYear()}, in points (full colour at 5).</span>`;
    return;
  }
  if (ui.view === 'turnout') {
    els.legend.innerHTML = `<span>Turnout ${Math.round(TURNOUT_LO * 100)}%</span>
      <span class="legend-bar" aria-hidden="true" style="background:linear-gradient(90deg, ${turnoutColor(TURNOUT_LO)}, ${turnoutColor(TURNOUT_HI)})"></span>
      <span>${Math.round(TURNOUT_HI * 100)}%</span>
      <span class="legend-note">Share of adults who voted. Districts are equal in people but decided by votes cast.</span>`;
    return;
  }
  if (ui.view === 'regions') {
    const chips = REGION_RGB.map((c, r) =>
      `<span class="legend-chip" style="background:rgb(${c.join(',')})" aria-hidden="true"></span><span>${'ABCD'[r]}</span>`).join('');
    els.legend.innerHTML = `${chips}<span class="legend-note">Tiles of the same colour tend to swing together; paler tiles are shared between regions.</span>`;
    return;
  }
  if (ui.view === 'results' && stressTesting()) {
    els.legend.innerHTML = `
      <span>Opponent wins big</span>
      <span class="legend-scale">${bar}<span class="legend-mid">close</span></span>
      <span>You win big</span><span class="legend-note">at ${stressText()}</span>`;
  } else if (ui.view === 'results' && game.realistic) {
    els.legend.innerHTML = `
      <span>Safe for opponent</span>
      <span class="legend-scale">${bar}<span class="legend-mid">toss-up</span></span>
      <span>Safe for you</span>`;
  } else if (ui.view === 'results') {
    els.legend.innerHTML = `
      <span>Opponent wins big</span>
      <span class="legend-scale">${bar}<span class="legend-mid">close</span></span>
      <span>You win big</span>`;
  } else if (game.mode === 'percent') {
    els.legend.innerHTML = `<span>${oppName()}</span>${bar}<span>${youName()}${game.party ? ' (you)' : ''}</span>`;
  } else {
    els.legend.innerHTML = `
      <span class="legend-chip" style="background:${opp}" aria-hidden="true"></span><span>✗ Votes for opponent</span>
      <span class="legend-chip" style="background:${you}" aria-hidden="true"></span><span>✓ Votes for you</span>`;
  }
  els.legend.insertAdjacentHTML('beforeend', sizeLegend());
  if (game.realistic) {
    els.legend.insertAdjacentHTML('beforeend', stressTesting()
      ? `<span class="legend-note">Stress test: badges show results at ${stressText()}</span>`
      : '<span class="legend-note">Badges show each district\'s chance to win</span>');
  }
}

// ---------- Board rendering ----------
// ---------- Board size and zoom ----------
// "Fit" shows the whole map in the space available. Each map opens zoomed so
// a hex is at least MIN_HEX_PX across (radius), scrolling if it doesn't fit.
const MIN_HEX_PX = 28;
const MAX_ZOOM = 4;
const isDesktopLayout = () => window.matchMedia('(min-width: 901px)').matches;

function fitScale() {
  const { w, h } = ui.boardSize;
  const box = els.boardScroll;
  if (isDesktopLayout()) return Math.min(box.clientWidth / w, box.clientHeight / h);
  return box.clientWidth / w;
}

function sizeBoard(keepCenter = true) {
  if (!ui.boardSize || !els.boardScroll) return;
  const box = els.boardScroll;
  const fit = fitScale();
  if (!(fit > 0)) return;
  if (ui.zoom === 'auto') ui.zoom = Math.min(MAX_ZOOM, Math.max(1, MIN_HEX_PX / (HEX * fit)));
  // keep the point at the centre of the view in place while zooming
  const cx = box.scrollWidth > box.clientWidth ? (box.scrollLeft + box.clientWidth / 2) / box.scrollWidth : 0.5;
  const cy = box.scrollHeight > box.clientHeight ? (box.scrollTop + box.clientHeight / 2) / box.scrollHeight : 0.5;
  const s = fit * ui.zoom;
  els.board.style.width = `${Math.floor(ui.boardSize.w * s)}px`;
  els.board.style.height = `${Math.floor(ui.boardSize.h * s)}px`;
  if (keepCenter) {
    box.scrollLeft = cx * box.scrollWidth - box.clientWidth / 2;
    box.scrollTop = cy * box.scrollHeight - box.clientHeight / 2;
  }
  els.zoomFit.setAttribute('aria-pressed', String(ui.zoom <= 1.001));
  els.zoomOut.disabled = ui.zoom <= 1.001;
  els.zoomIn.disabled = ui.zoom >= MAX_ZOOM - 0.001;
}

function setZoom(z) {
  ui.zoom = Math.min(MAX_ZOOM, Math.max(1, z));
  sizeBoard(true);
}

function buildBoard() {
  const { cols, rows } = game.cfg;
  const w = PAD * 2 + SQRT3 * HEX * (cols + 0.5);
  const h = PAD * 2 + HEX * 2 + 1.5 * HEX * (rows - 1);
  els.board.setAttribute('viewBox', `0 0 ${w.toFixed(1)} ${h.toFixed(1)}`);
  ui.boardSize = { w, h };
  els.board.innerHTML = '';

  const gTiles = svgEl('g');
  tileEls = game.tiles.map((t) => {
    const g = svgEl('g', { class: 'tile', 'data-id': t.id });
    const poly = svgEl('polygon', { class: 'hex', points: hexPoints(t.x, t.y, HEX) });
    // With turnout, the filled inner hex is sized by votes cast and an outline shows residents.
    const voteScale = game.turnout ? popScale(t) * Math.sqrt(t.turnout) : popScale(t);
    const inner = svgEl('polygon', { class: 'inner', points: hexPoints(t.x, t.y, HEX * voteScale) });
    const outline = svgEl('polygon', { class: 'pop-outline', points: hexPoints(t.x, t.y, HEX * popScale(t)) });
    const main = svgEl('text', { class: 'num', x: t.x, y: t.y + 7 });
    const sub = svgEl('text', { class: 'sub', x: t.x, y: t.y + 21 });
    g.append(poly, inner, outline, main, sub);
    gTiles.append(g);
    return { g, poly, inner, outline, main, sub };
  });
  els.defs = svgEl('defs');
  els.borderGroup = svgEl('g', { class: 'district-borders' });
  els.badges = svgEl('g', { class: 'badges' });
  els.board.append(els.defs, gTiles, els.borderGroup, els.badges);
  if (ui.zoom !== 'auto') sizeBoard(false);
}

// Inner hex size: area is proportional to population (largest tile = full size).
function popScale(t) {
  return Math.min(1, Math.max(MIN_TILE_SCALE, Math.sqrt(t.pop / game.maxPop))) * 0.94;
}

// Population sizing applies wherever tiles have different populations,
// except in the Districts view, which is about district shapes.
const sizedTiles = () => SIZE_TILES_BY_POPULATION && game.mode !== 'voters' && ui.view !== 'districts';

function tileText(t) {
  const [main, sub] = baseTileText(t);
  // While a campaign outcome is showing, changed hexes show their change underneath.
  const changed = typeof outcomeTileLabel === 'function' ? outcomeTileLabel(t) : null;
  return changed ? [main, changed] : [main, sub];
}

function baseTileText(t) {
  if (ui.label === 'none' && game.mode === 'percent') return ['', ''];
  if (ui.view === 'change' && ui.label !== 'none') {
    const dlt = leanChange(t);
    return [`${dlt >= 0 ? '+' : '−'}${Math.abs(dlt).toFixed(1)}`, ''];
  }
  if (game.turnout && (ui.label === 'turnout' || (ui.view === 'turnout' && ui.label === 'lean'))) {
    return [Math.round(t.turnout * 100) + '%', ui.view === 'turnout' ? '' : 'turnout'];
  }
  if (game.mode === 'voters') return [supports(t) ? '✓' : '✗', ''];
  if (game.mode === 'binary') return [fmtInt(t.pop), supports(t) ? '✓' : '✗'];
  // Real states show one decimal; generated maps show whole numbers.
  const leanLabel = (game.state ? shownLean(t) : Math.round(shownLean(t))) + '%';
  if (ui.label === 'both') return [fmtK(t.pop), leanLabel];
  return ui.label === 'pop' ? [fmtK(t.pop), ''] : [leanLabel, ''];
}

function renderTiles(stats) {
  const focus = typeof ui.tool === 'number' ? ui.tool : null;
  for (const t of game.tiles) {
    const el = tileEls[t.id];
    const d = ui.assign[t.id];
    let fill = null;
    if (ui.view === 'votes') fill = leanColor(shownLean(t));
    else if (ui.view === 'turnout') fill = turnoutColor(t.turnout);
    else if (ui.view === 'change') fill = leanColor(50 + leanChange(t), 5);
    else if (ui.view === 'regions') fill = regionColor(t.id);
    else if (d >= 0 && ui.view === 'districts') fill = DISTRICT_COLORS[d];
    else if (d >= 0 && stressTesting()) fill = leanColor(ui.scenario[d] * 100, RESULT_SPAN);
    else if (d >= 0 && ui.sim) fill = leanColor(50 + (ui.sim.winProb[d] - 0.5) * 40, 20);
    else if (d >= 0) fill = leanColor(stats[d].share * 100, RESULT_SPAN);
    const sized = sizedTiles() && !['regions', 'turnout', 'change'].includes(ui.view) && fill;
    el.poly.style.fill = fill || 'var(--unassigned)';
    el.poly.style.fillOpacity = sized ? '0.25' : '';
    el.inner.style.display = sized ? '' : 'none';
    if (sized) el.inner.style.fill = fill;
    el.outline.style.display = sized && game.turnout ? '' : 'none';

    const [main, sub] = tileText(t);
    // On sized tiles text can sit over both the inner hex and the pale rim, so it gets a halo.
    const tone = sized ? ' halo' : fill ? (isDark(fill) ? ' on-dark' : ' on-light') : '';
    el.main.textContent = main;
    el.sub.textContent = sub;
    el.main.setAttribute('class', 'num' + (game.mode === 'voters' ? ' mark' : '') + tone);
    el.main.setAttribute('y', sub ? t.y + 5 : t.y + 8);
    el.sub.setAttribute('class', 'sub' + tone);

    // Lightly fade tiles that belong to a district other than the selected one.
    // (Not in results view, where each district's colour is its result.)
    el.g.classList.toggle('faded', ui.view === 'votes' && focus !== null && d >= 0 && d !== focus);
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
  if (ui.view === 'regions') {
    // Label each region's centre instead of showing district badges.
    game.unc.regions.forEach((id, r) => {
      const t = game.tiles[id];
      const g = svgEl('g', { class: 'region-mark' });
      const c = svgEl('circle', { cx: t.x, cy: t.y - 17, r: 10, fill: `rgb(${REGION_RGB[r].join(',')})` });
      const txt = svgEl('text', { x: t.x, y: t.y - 13, class: 'b-num' });
      txt.textContent = 'ABCD'[r];
      g.append(c, txt);
      els.badges.append(g);
    });
    return;
  }
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
    const testing = stressTesting();
    const chance = ui.sim && !testing ? ui.sim.winProb[d] : null;
    const shareNow = testing ? ui.scenario[d] : s.share;
    const pillColor = chance != null ? chanceColor(chance) : shareNow > 0.5 ? WIN_COLOR : LOSE_COLOR;
    const pill = svgEl('rect', { y: y - r, height: r * 2, rx: r, fill: pillColor });
    const value = svgEl('text', { class: 'b-val', y: y + 4 });
    const valueText = chance != null ? fmtChance(chance) : testing ? Math.round(shareNow * 100) + '%' : shareShort(s);
    value.textContent = (isLegal(s) ? '' : '⚠ ') + valueText;
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
  else if (t.county) {
    const part = t.county.hexes > 1 ? ` (1 of ${t.county.hexes} hexes)` : '';
    body = `${t.county.name}${part}<br>Population ${fmtInt(t.pop)}<br>${youName()} ${t.lean}% · ${oppName()} ${Math.round((100 - t.lean) * 10) / 10}%`;
  } else body = `Population ${fmtInt(t.pop)}<br>You ${t.lean}% · Opponent ${100 - t.lean}%`;
  if (game.turnout && game.mode === 'percent') {
    body += `<br>Turnout ${Math.round(t.turnout * 100)}% · ${fmtInt(votersOf(t))} votes`;
  }
  if (game.campaign) {
    const b = game.campaign.base[t.id];
    const dl = t.lean - b.lean;
    const dp = t.pop / b.pop - 1;
    body += `<br>Since ${campaignBaseYear()}: ${dl >= 0 ? '+' : '−'}${Math.abs(dl).toFixed(1)} pts for you, population ${dp >= 0 ? '+' : '−'}${Math.abs(dp * 100).toFixed(1)}%`;
  }
  const title = d >= 0
    ? `<span class="tt-dot" style="background:${DISTRICT_COLORS[d]}"></span>District ${d + 1}`
    : 'Not in a district';
  let result = '';
  if (d >= 0) {
    const s = currentStats()[d];
    result = `<br><span class="tt-result">District: ${shareText(s)}${game.mode === 'percent' ? ' for you' : ''}
      · ${s.wins ? 'you lead' : 'opponent leads'}</span>`;
    if (ui.sim) {
      const r = ui.sim.ranges[d];
      const c = ui.cushions.cushions[d];
      result += `<br><span class="tt-result">Win chance: ${fmtChance(ui.sim.winProb[d])} (${chanceWord(ui.sim.winProb[d])})</span>`;
      if (r) result += `<br><span class="tt-result">Likely ${fmtPct(r.q25, 0)}–${fmtPct(r.q75, 0)} · plausible ${fmtPct(r.q05, 0)}–${fmtPct(r.q95, 0)}</span>`;
      if (c != null) result += `<br><span class="tt-result">${cushionText(c)}</span>`;
      if (stressTesting()) result += `<br><span class="tt-result">At ${stressText()}: ${fmtPct(ui.scenario[d])}</span>`;
    }
  }
  els.tooltip.innerHTML = `<strong>${title}</strong><br>${body}${result}`;
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
  const item = (label, value) =>
    `<div class="status-item"><span class="s-label">${label}</span><span class="s-value">${value}</span></div>`;
  let html = '';
  if (ui.sim) {
    const p = ui.sim.pTarget;
    html += item('Win chance',
      `<strong class="${p >= PASS_PROBABILITY ? 'ok' : ''}">${fmtChance(p)}</strong> <span class="need">need ${Math.round(PASS_PROBABILITY * 100)}%</span>`);
    html += item('Expected seats', `<strong>${ui.sim.expectedSeats.toFixed(1)}</strong> of ${n}`);
    const b = ui.cushions.breaking;
    html += item('Breaking point', b == null
      ? '<span class="muted">draw all districts</span>'
      : b > 0
        ? `survives <strong class="${b >= 0.02 ? 'ok' : ''}">${(b * 100).toFixed(1)}</strong> pts against you`
        : `needs <strong class="bad">${(-b * 100).toFixed(1)}</strong> pts toward you`);
    if (stressTesting()) {
      const seatsAt = ui.scenario.filter((x) => x > 0.5).length;
      html += item('Stress test',
        `<strong class="${seatsAt >= game.target ? 'ok' : 'bad'}">${seatsAt}</strong> of ${n} seats`);
    }
  } else {
    html += item('Seats won',
      `<strong class="${seats >= game.target ? 'ok' : ''}">${seats}</strong> of ${n} <span class="need">need ${game.target}</span>`);
  }
  // Tiles assigned and legal districts are shown by the mission checklist beside this.
  els.statusItems.innerHTML = html;
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
    if (game.state) {
      const S = game.state;
      const a = S.actual2022;
      intro = `<strong>${S.name}</strong>, ${S.seats} seats. You draw for the <strong>${youName()}</strong>
        (<strong>${fmtPct(game.actualShare)}</strong> of the 2020 vote). <span class="muted">Real 2022 result: ${a.dem} D, ${a.rep} R.</span>`;
    } else {
      intro = `Your candidate expects <strong>${fmtPct(game.statewideShare)}</strong> of the statewide vote.`;
    }
    if (game.realistic) intro += ' <span class="muted">Results are uncertain.</span>';
  } else {
    const yes = Math.round(game.statewideShare * game.totalPop);
    intro = `Your candidate has <strong>${fmtInt(yes)} of ${fmtInt(game.totalPop)}</strong> ${unitWord()}
             (${fmtPct(game.statewideShare, 0)}).`;
  }
  const items = [
    [assigned === T, 'Put every tile in a district', `${assigned} / ${T}`],
    [connected === n, `Keep each district in one piece`, `${connected} / ${n}`],
    [sized === n, `Give each district ${popRangeText()}`, `${sized} / ${n}`],
    ui.sim
      ? [ui.sim.pTarget >= PASS_PROBABILITY,
          `Reach a ${Math.round(PASS_PROBABILITY * 100)}% chance of winning ${game.target}+ of ${n} seats`, `${fmtChance(ui.sim.pTarget)} now`]
      : [seats >= game.target, `Win at least ${game.target} of ${n} seats`, `${seats} now`],
  ];
  // Short chip labels; the full wording is in each chip's tooltip.
  const short = [
    'Every tile used',
    'Districts in one piece',
    game.tolerance === 0 ? `${fmtInt(game.ideal)} ${unitWord()} each` : popRangeText().replace(' people', ' people each'),
    ui.sim ? `${Math.round(PASS_PROBABILITY * 100)}% chance of ${game.target}+ seats` : `Win ${game.target}+ of ${n} seats`,
  ];
  let meta = game.lesson != null ? ''
    : game.state ? `Difficulty: ${difficultyText()} Real data: 2020 presidential results and 2019 Census population estimates by county.`
      : `Difficulty: ${difficultyText()} Map #${game.seed}.`;
  if (game.realistic) meta += ' On election day the state can swing a few points either way.';
  if (game.turnout) meta += ' Turnout varies: districts must be equal in people, but are decided by the votes actually cast.';
  let html = `<p class="mission-intro"><span class="mission-label">Mission</span> ${intro}
    ${meta ? `<span class="mission-meta" title="${meta}">ⓘ</span>` : ''}</p><ul class="checklist">`;
  items.forEach(([done, text, count], i) => {
    html += `<li class="${done ? 'done' : ''}" title="${text}">
      <span class="check" aria-hidden="true">${done ? '✓' : ''}</span>
      <span class="c-text">${short[i]}</span>
      <span class="c-count">${count}</span>
      <span class="sr-only">${text} ${done ? '(done)' : '(not yet)'}</span></li>`;
  });
  html += '</ul>';
  els.goal.innerHTML = html;
}

function difficultyText() {
  const pct = Math.round(game.winFraction * 100);
  const share = pct === 0 ? `none of ${game.sampleCount}` : `only ${pct}%`;
  if (game.realistic) {
    return `${share} of randomly drawn legal maps have a ${Math.round(PASS_PROBABILITY * 100)}%+ chance of winning ${game.target}+ seats.`;
  }
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
        <span class="d-line"><span class="d-pop"></span> <span class="d-status"></span></span>
        <span class="pop-bar"><span class="band"></span><span class="fill"></span></span>
      </span>
      <span class="d-vote"><span class="v-main"></span><span class="v-sub"></span></span>
      <span class="forecast" hidden>
        <span class="fc-track" aria-hidden="true">
          <span class="fc-plausible"></span><span class="fc-likely"></span>
          <span class="fc-mid"></span><span class="fc-dot"></span><span class="fc-swing"></span>
        </span>
        <span class="fc-text"></span>
      </span>`;
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
      popEl.innerHTML = `${fmtInt(s.pop)} <small>(${fmtSigned(s.dev)})</small>`;
      row.title = `District ${d + 1}: ${fmtInt(s.pop)} people` + (game.turnout ? `, ${fmtInt(Math.round(s.voters))} votes cast` : '');
    }
    statusEl.className = 'd-status ' + (issue ? 'bad' : 'ok');
    // Short label in the row; the full problem is in the tooltip.
    const shortIssue = !issue ? '' : !s.connected ? 'split' : s.dev > 0 ? 'too big' : 'too small';
    statusEl.textContent = issue ? `⚠ ${shortIssue}` : '✓';
    statusEl.title = issue ? issue : 'Legal';

    vMain.className = 'v-main ' + (s.wins ? 'win' : 'lose');
    if (game.mode === 'percent') {
      vMain.textContent = fmtPct(s.share);
      vSub.textContent = ui.sim ? `${fmtChance(ui.sim.winProb[d])} chance` : s.wins ? 'you lead' : 'opponent leads';
      const ev = typeof outcomeDistrictDelta === 'function' ? outcomeDistrictDelta(d) : 0;
      if (Math.abs(ev) >= 0.0005) {
        vSub.insertAdjacentHTML('afterbegin', `<span class="chg-chip ${ev > 0 ? 'ok' : 'bad'}">${ev > 0 ? '▲' : '▼'}${Math.abs(ev * 100).toFixed(1)}</span> `);
      }
    } else {
      vMain.textContent = `${votesFor(s)} for`;
      vSub.textContent = `${votesAgainst(s)} against`;
    }
  });
  renderForecasts();
  els.eraser.classList.toggle('active', ui.tool === 'erase');
}

const FC_MIN = 0.35;
const FC_MAX = 0.65;
const fcPos = (x) => `${(Math.min(1, Math.max(0, (x - FC_MIN) / (FC_MAX - FC_MIN))) * 100).toFixed(1)}%`;

function shortCushion(c) {
  if (c >= 0.5) return 'safe';
  if (c <= -0.5) return 'unwinnable';
  return c > 0 ? `flips at −${(c * 100).toFixed(1)}` : `needs +${(-c * 100).toFixed(1)}`;
}

function cushionText(c) {
  if (c >= 0.5) return 'Safe at any swing';
  if (c <= -0.5) return 'Cannot be won';
  const n = Math.abs(c * 100).toFixed(1);
  const an = /^(8|11|18)(\.|$)/.test(n) || n.startsWith('8') ? 'an' : 'a';
  return c > 0
    ? `Flips after ${an} ${n}-point swing against you`
    : `Needs ${an} ${n}-point swing toward you`;
}

// Forecast bar: plausible range (middle 90%), likely range (middle 50%),
// the expected result, the 50% line and any stress-test swing.
function renderForecasts() {
  const rows = els.districtList.querySelectorAll('.district-row');
  rows.forEach((row, d) => {
    const fc = row.querySelector('.forecast');
    const r = ui.sim ? ui.sim.ranges[d] : null;
    fc.hidden = !r;
    if (!r) return;
    const set = (sel, from, to) => {
      const el = fc.querySelector(sel);
      el.style.left = fcPos(from);
      el.style.width = `calc(${fcPos(to)} - ${fcPos(from)})`;
    };
    set('.fc-plausible', r.q05, r.q95);
    set('.fc-likely', r.q25, r.q75);
    fc.querySelector('.fc-mid').style.left = fcPos(0.5);
    const share = currentStats()[d].share;
    const dot = fc.querySelector('.fc-dot');
    dot.style.left = fcPos(share);
    dot.classList.toggle('lose', share <= 0.5);
    const sw = fc.querySelector('.fc-swing');
    sw.hidden = !stressTesting();
    if (stressTesting()) sw.style.left = fcPos(ui.scenario[d]);
    const crosses = r.q05 <= 0.5 && r.q95 > 0.5;
    fc.querySelector('.fc-text').innerHTML =
      `Likely ${fmtPct(r.q25, 0)}–${fmtPct(r.q75, 0)}` +
      (crosses ? ' · <span class="tossup">at risk</span>' : '') +
      ` · ${shortCushion(ui.cushions.cushions[d])}`;
    fc.title = cushionText(ui.cushions.cushions[d]) + (crosses ? '. Its likely range crosses 50%.' : '.');
  });
}

function renderControls() {
  for (const btn of els.viewButtons) {
    btn.setAttribute('aria-pressed', String(btn.dataset.view === ui.view));
    if (btn.dataset.view === 'regions') btn.hidden = !game.realistic;
    if (btn.dataset.view === 'turnout') btn.hidden = !game.turnout;
    if (btn.dataset.view === 'change') btn.hidden = !game.campaign;
  }
  els.uncertaintyBar.hidden = !(game.realistic && (ui.stressOpen || stressTesting()));
  els.stressToggle.hidden = !game.realistic;
  els.uncertaintyInfo.hidden = !game.realistic;
  els.stressToggle.setAttribute('aria-expanded', String(!els.uncertaintyBar.hidden));
  els.stressToggle.textContent = els.uncertaintyBar.hidden ? 'Stress test ▾' : 'Stress test ▴';
  els.swingSlider.value = String(Math.round(ui.swing * 1000) / 10);
  els.swingValue.textContent = ui.swing === 0 ? 'none' : `${fmtSwing(ui.swing)} pts ${ui.swing > 0 ? 'toward you' : 'toward opponent'}`;
  els.swingReset.disabled = ui.swing === 0 && ui.turnoutGap === 0;
  els.gapGroup.hidden = !game.turnout;
  els.gapSlider.value = String(Math.round(ui.turnoutGap * 100));
  els.gapValue.textContent = ui.turnoutGap === 0 ? 'even'
    : `${Math.abs(Math.round(ui.turnoutGap * 100))}% more ${ui.turnoutGap > 0 ? 'of your voters' : "of the opponent's voters"}`;
  for (const btn of els.labelButtons) if (btn.dataset.label === 'turnout') btn.hidden = !game.turnout;
  for (const btn of els.labelButtons) btn.setAttribute('aria-pressed', String(btn.dataset.label === ui.label));
  els.labelToggle.hidden = game.mode !== 'percent';
  els.partyToggle.hidden = !game.state;
  for (const btn of els.partyButtons) btn.setAttribute('aria-pressed', String(btn.dataset.party === game.party));
  const inLesson = game.lesson != null;
  for (const btn of els.modeButtons) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === (game.campaignMode ? 'campaign' : game.realistic ? 'realistic' : 'classic')));
    btn.disabled = inLesson;
    btn.title = inLesson ? 'Each lesson has its own rules' : '';
  }
  renderLegend();
  els.legend.classList.toggle('hidden', ui.view === 'districts');
}

function currentStats() {
  return computeStats(game.tiles, ui.assign, game.cfg.districts, game.ideal, game.tolerance);
}

function render() {
  if (!game) return;
  const stats = currentStats();
  // Sound: a chime when a district becomes legal while painting; a faster pulse while the map is legal.
  const legalNow = stats.map(isLegal);
  if (ui.painting && ui.legalPrev && legalNow.some((l, d) => l && !ui.legalPrev[d])) Sound.play('legal');
  ui.legalPrev = legalNow;
  Sound.setLegal(legalNow.every(Boolean) && ui.assign.every((d) => d >= 0));
  ui.sim = game.realistic ? simulatePlan(game, ui.assign) : null;
  ui.cushions = game.realistic ? computeCushions(game, ui.assign) : null;
  ui.scenario = game.realistic && (ui.swing !== 0 || ui.turnoutGap !== 0)
    ? districtTileIds(game, ui.assign).map((ids) => swungShare(game.tiles, ids, ui.swing, ui.turnoutGap))
    : null;
  renderTiles(stats);
  renderBorders();
  renderBadges(stats);
  renderStatus(stats);
  renderMission(stats);
  if (typeof renderCampaign === 'function') renderCampaign();
  els.goal.hidden = !!game.campaign;
  els.submit.textContent = game.campaignMode ? 'Start the decade' : 'Hold election';
  els.submit.hidden = !!game.campaign;
  els.reset.disabled = campaignLocked();
  els.eraser.disabled = campaignLocked();
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
    Sound.play(next === -1 ? 'erase' : 'paint');
    render();
  }
}

function bindEvents() {
  els.board.addEventListener('pointerdown', (e) => {
    const id = tileAt(e);
    if (!game || id == null || (e.button !== undefined && e.button !== 0)) return;
    if (campaignLocked()) return; // the map is locked during a campaign decade, except for a redraw
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
    if (!game || campaignLocked()) return;
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
  const seatsAtScenario = () => (ui.scenario ? ui.scenario.filter((x) => x > 0.5).length
    : currentStats().filter((x) => x.wins).length);
  els.swingSlider.addEventListener('input', () => {
    const before = seatsAtScenario();
    const oldPts = Math.trunc(ui.swing * 100);
    ui.swing = Number(els.swingSlider.value) / 100;
    render();
    if (seatsAtScenario() !== before) Sound.play('thud');
    else if (Math.trunc(ui.swing * 100) !== oldPts) Sound.play('tick');
  });
  els.swingReset.addEventListener('click', () => { ui.swing = 0; ui.turnoutGap = 0; render(); });
  els.gapSlider.addEventListener('input', () => {
    const before = seatsAtScenario();
    ui.turnoutGap = Number(els.gapSlider.value) / 100;
    render();
    Sound.play(seatsAtScenario() !== before ? 'thud' : 'tick');
  });
  // The ambient loop comes back when results (or any dialog) close.
  els.dialog.addEventListener('close', () => Sound.resume());
  els.uncertaintyInfo.addEventListener('click', showUncertaintyInfo);
  els.zoomIn.addEventListener('click', () => setZoom(ui.zoom * 1.25));
  els.zoomOut.addEventListener('click', () => setZoom(ui.zoom / 1.25));
  els.zoomFit.addEventListener('click', () => setZoom(1));
  // Keep the map sized to its space when the window or the panels above it change.
  if ('ResizeObserver' in window) new ResizeObserver(() => sizeBoard(true)).observe(els.boardScroll);
  else window.addEventListener('resize', () => sizeBoard(true));
  els.stressToggle.addEventListener('click', () => {
    ui.stressOpen = els.uncertaintyBar.hidden;
    if (!ui.stressOpen) { ui.swing = 0; ui.turnoutGap = 0; }
    render();
  });
  for (const btn of els.partyButtons) {
    btn.addEventListener('click', () => {
      ui.party = btn.dataset.party;
      storageSet(PARTY_KEY, ui.party);
      if (game && game.state) startGame(game.state.code);
    });
  }
  for (const btn of els.modeButtons) {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      const realistic = mode !== 'classic';
      storageSet(MODE_KEY, mode);
      ui.campaign = mode === 'campaign';
      if (game && game.lesson == null && realistic === !!game.realistic) {
        // Same map: switching between Realistic and Campaign before a decade starts keeps it.
        if (!game.campaign || !ui.campaign) {
          if (game.campaign && !ui.campaign) { startGame(els.size.value, randomSeed()); return; }
          game.campaignMode = ui.campaign;
          render();
          try {
            const url = new URL(window.location.href);
            url.searchParams.set('mode', ui.campaign ? 'campaign' : 'realistic');
            window.history.replaceState(null, '', url);
          } catch (err) { /* optional */ }
        }
        return;
      }
      ui.realistic = realistic;
      startGame(els.size.value, randomSeed());
    });
  }
  els.skipTutorial.addEventListener('click', leaveTutorial);

  document.addEventListener('keydown', (e) => {
    if (!game || els.dialog.open || e.target.closest('input, select, textarea')) return;
    if (document.body.classList.contains('start-open')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const num = Number(e.key);
    if (Number.isInteger(num) && num >= 1 && num <= game.cfg.districts) setTool(num - 1);
    else if (e.key === '0' && game.cfg.districts >= 10) setTool(9);
    else if (e.key === 'e' || e.key === 'E') setTool('erase');
    else if (e.key === '=' || e.key === '+') setZoom(ui.zoom * 1.25);
    else if (e.key === '-' || e.key === '_') setZoom(ui.zoom / 1.25);
    else if (e.key === 'v' || e.key === 'V') {
      const order = ['votes', 'districts', 'results'];
      if (game.realistic) order.push('regions');
      if (game.turnout) order.push('turnout');
      if (game.campaign) order.push('change');
      setView(order[(order.indexOf(ui.view) + 1) % order.length]);
    }
    else if ((e.key === 'l' || e.key === 'L') && game.mode === 'percent') {
      const order = game.turnout ? ['lean', 'pop', 'both', 'turnout', 'none'] : ['lean', 'pop', 'both', 'none'];
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

function realDelegation() {
  if (!game.state) return '';
  const a = game.state.actual2022;
  const yours = game.party === 'dem' ? a.dem : a.rep;
  return `<p class="small muted">For comparison, the real ${game.state.name} map elected ${a.dem} Democrats and ${a.rep} Republicans in 2022
    (${yours} for the ${youName()}).</p>`;
}

// ---------- Gerrymandering measures ----------
// Polsby–Popper compactness: 4π × area / perimeter². On this hex grid a
// single hex scores 0.91, a compact blob about 0.7 and a straight line of
// six hexes about 0.3.
const HEX_AREA = (3 * SQRT3) / 2; // area of a hex with side 1

function polsbyPopper(d) {
  let tiles = 0;
  let edges = 0;
  for (const t of game.tiles) {
    if (ui.assign[t.id] !== d) continue;
    tiles++;
    for (const j of t.nbrs) if (j < 0 || ui.assign[j] !== d) edges++;
  }
  return edges ? (4 * Math.PI * tiles * HEX_AREA) / (edges * edges) : 0;
}

function fairnessMetrics(stats) {
  let wastedYou = 0;
  let wastedOpp = 0;
  let total = 0;
  for (const s of stats) {
    const you = s.votes;
    const opp = s.voters - s.votes;
    const half = s.voters / 2;
    total += s.voters;
    // Wasted votes: every vote for the loser, and the winner's votes beyond 50%.
    if (you > half) { wastedYou += you - half; wastedOpp += opp; } else { wastedOpp += opp - half; wastedYou += you; }
  }
  const shares = stats.map((s) => s.share).sort((a, b) => a - b);
  const n = shares.length;
  const mean = shares.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? shares[(n - 1) / 2] : (shares[n / 2 - 1] + shares[n / 2]) / 2;
  const seats = stats.filter((s) => s.wins).length;
  const compact = stats.map((s, d) => polsbyPopper(d));
  return {
    efficiencyGap: (wastedOpp - wastedYou) / total, // positive = favours you
    meanMedian: median - mean,                       // positive = favours you
    seatShare: seats / n,
    voteShare: game.statewideShare,
    compact,
    avgCompact: compact.reduce((a, b) => a + b, 0) / n,
  };
}

const ppWord = (pp) => (pp >= 0.5 ? 'compact' : pp >= 0.3 ? 'irregular' : 'very irregular');
const favour = (x) => (x > 0 ? 'in your favour' : x < 0 ? "in the opponent's favour" : 'neutral');
const pts = (x) => Math.abs(x * 100).toFixed(1);

function gerrymanderVerdict(m) {
  const eg = Math.abs(m.efficiencyGap);
  const side = m.efficiencyGap >= 0 ? 'your favour' : "the opponent's favour";
  if (eg >= 0.07) return { level: 'strong', text: `Strong gerrymander in ${side}` };
  if (eg >= 0.03) return { level: 'moderate', text: `Moderate tilt in ${side}` };
  return { level: 'fair', text: 'Close to neutral' };
}

// The "How gerrymandered is this map?" section of the results dialog.
function metricsSection(stats, expected) {
  const m = fairnessMetrics(stats);
  const v = gerrymanderVerdict(m);
  const worst = m.compact.indexOf(Math.min(...m.compact));
  const bonus = m.seatShare - m.voteShare;
  const pp = m.compact.map((c, d) => `
      <span class="pp-chip"><span class="dot" style="background:${DISTRICT_COLORS[d]}"></span>${d + 1}: ${c.toFixed(2)}</span>`).join('');
  return `
    <h3 class="dialog-sub">How gerrymandered is this map?${expected ? ' (expected vote shares)' : ''}</h3>
    <p class="verdict verdict-${v.level}">${v.text}</p>
    <table class="results-table metrics-table">
      <tbody>
        <tr>
          <th scope="row">Seats vs votes</th>
          <td class="num">${fmtPct(m.seatShare, 0)} of seats<br><span class="muted small">from ${fmtPct(m.voteShare)} of votes</span></td>
          <td class="small">A seat bonus of <strong>${bonus >= 0 ? '+' : '−'}${pts(bonus)} points</strong>. In a neutral map seat share roughly tracks vote share.</td>
        </tr>
        <tr>
          <th scope="row">Efficiency gap</th>
          <td class="num"><strong>${pts(m.efficiencyGap)}%</strong><br><span class="muted small">${favour(m.efficiencyGap)}</span></td>
          <td class="small">Difference in "wasted" votes (all votes for a loser, plus a winner's votes beyond 50%) as a share of all votes. Gaps above about 7% are widely treated as a sign of gerrymandering.</td>
        </tr>
        <tr>
          <th scope="row">Mean–median difference</th>
          <td class="num"><strong>${pts(m.meanMedian)} pts</strong><br><span class="muted small">${favour(m.meanMedian)}</span></td>
          <td class="small">Your median district's vote share minus your average district's share. When the median sits above the mean, your voters were spread to win more seats; near 0 is symmetric.</td>
        </tr>
        <tr>
          <th scope="row">Polsby–Popper compactness</th>
          <td class="num"><strong>${m.avgCompact.toFixed(2)}</strong> average<br><span class="muted small">least compact: District ${worst + 1}</span></td>
          <td class="small">4π × area ÷ perimeter² for each district: 1 is a circle, and odd, stretched shapes score low. On this hex grid a compact blob scores about 0.7 and a line of six hexes about 0.3.
            <div class="pp-chips">${pp}</div></td>
        </tr>
      </tbody>
    </table>`;
}

function holdElection() {
  if (!game) return;
  if (game.campaignMode) {
    if (!game.campaign) startDecade();
    return;
  }
  const stats = currentStats();
  const problems = validatePlan(stats);
  if (problems.length) {
    Sound.play('buzz');
    openDialog(
      `<h2>This map isn't legal yet</h2>
       <p>Fix these problems before holding the election:</p>
       <ul>${problems.map((p) => `<li>${p}</li>`).join('')}</ul>`,
      [{ label: 'Keep drawing', primary: true }]
    );
    return;
  }

  if (game.realistic) {
    holdRealisticElection(stats);
    return;
  }

  const seats = stats.filter((s) => s.wins).length;
  const won = seats >= game.target;
  Sound.election(won);
  const rows = stats.map((s, d) => `
    <tr>
      <td><span class="dot" style="background:${DISTRICT_COLORS[d]}"></span>District ${d + 1}</td>
      <td class="num">${fmtInt(s.pop)}</td>
      <td class="num">${shareText(s)}</td>
      <td class="num">${polsbyPopper(d).toFixed(2)}</td>
      <td class="${s.wins ? 'win' : 'lose'}">${s.wins ? '✓ You' : '✗ Opponent'}</td>
    </tr>`).join('');

  const lesson = game.lesson != null ? TUTORIAL[game.lesson] : null;
  const unitHeader = game.mode === 'voters' ? 'Voters' : 'Population';
  const voteHeader = game.mode === 'percent' ? 'Your vote' : 'Votes';
  const title = lesson ? (won ? 'Lesson complete!' : 'Not quite') : won ? 'Victory!' : 'Defeat';
  const body = `
    <h2>${title}</h2>
    <p>${game.party ? `The ${youName()}` : 'Your candidate'} won <strong>${seats} of ${game.cfg.districts}</strong> seats
       (${fmtPct(seats / game.cfg.districts, 0)} of seats) with ${fmtPct(game.statewideShare)} of the statewide vote.
       ${won ? '' : `You needed ${game.target}.`}</p>
    ${realDelegation()}
    <table class="results-table">
      <thead><tr><th>District</th><th class="num">${unitHeader}</th><th class="num">${voteHeader}</th><th class="num" title="Polsby–Popper compactness">Compact.</th><th>Winner</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${metricsSection(stats, false)}
    ${lesson && won ? `<p class="debrief">${lesson.debrief}</p>` : ''}`;

  openDialog(body, electionActions(won));
}

// Dialog buttons after an election (shared by both modes).
function electionActions(won) {
  const lesson = game.lesson != null ? TUTORIAL[game.lesson] : null;
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
  return actions;
}

function showUncertaintyInfo() {
  const pts = (x) => (x * 100).toFixed(1).replace(/\.0$/, '');
  openDialog(`
    <h2>How uncertain are the results?</h2>
    <p>Every tile shows its <em>expected</em> vote share. On election day each tile actually moves by three amounts added together:</p>
    <ul>
      <li><strong>Statewide swing</strong> — the same for every tile, typically ±${pts(SWING_STATE)} points.</li>
      <li><strong>Regional swing</strong> — shared by nearby tiles, typically ±${pts(SWING_REGION)} points.
          The <em>Regions</em> colour view shows which tiles move together.</li>
      <li><strong>Local noise</strong> — different for each tile, typically ±${pts(SWING_TILE)} points.</li>
    </ul>
    ${game.turnout ? `<p><strong>Turnout</strong> varies too. Each hex has its own turnout (the share of adults who vote${game.state ? ', from the real 2020 results' : ''}).
       Districts must be equal in <em>people</em>, but they are decided by the <em>votes cast</em>, so a district full of low-turnout
       areas is decided by fewer votes. In each election, turnout across the state rises or falls by about ±${pts(TURNOUT_STATE)}% of its usual level,
       one side's voters can turn out about ${pts(TURNOUT_GAP)}% more than the other's (an "enthusiasm gap"), and each hex varies by about
       ±${pts(TURNOUT_TILE)}%. On the map, the outline is a hex's residents and the filled hex its votes cast.</p>` : ''}
    <p>"Typically" means about 2 elections in 3 fall within that range; bigger moves happen less often.
       Because most of the swing is shared, narrow districts tend to flip <em>together</em>.</p>
    <p>The game runs ${SIMULATIONS.toLocaleString('en-US')} simulated elections. You win if your map reaches the seat target in at least
       <strong>${Math.round(PASS_PROBABILITY * 100)}%</strong> of them.</p>
    <h3 class="dialog-sub">Reading the forecast</h3>
    <ul>
      <li><strong>Range bars</strong> (district list): the dark band is the likely range (middle half of simulations),
          the light band the plausible range (middle 90%). If the bar crosses the 50% line, that seat is at risk.</li>
      <li><strong>Breaking point</strong> (status bar): the statewide swing against you that would cost you the target.
          A bigger number means a sturdier map.</li>
      <li><strong>Swing slider</strong>: apply a statewide swing to see which districts fall first.</li>
      ${game.turnout ? `<li><strong>Turnout gap slider</strong>: make one side's voters turn out more than the other's.</li>` : ''}
    </ul>`, [{ label: 'Got it', primary: true }]);
}

function holdRealisticElection(stats) {
  const sim = simulatePlan(game, ui.assign);
  const won = sim.pTarget >= PASS_PROBABILITY;
  Sound.election(won);
  const n = game.cfg.districts;
  const need = Math.round(PASS_PROBABILITY * 100);

  // One simulated election night, for drama. It doesn't decide the result.
  const night = simulateOne(game, ui.assign, Math.floor(Math.random() * game.unc.sims));
  const nightSeats = night.shares.filter((x) => x > 0.5).length;
  const swingPts = Math.abs(night.swing * 100).toFixed(1);
  let swingText = Math.abs(night.swing) < 0.005
    ? 'barely moved'
    : `swung ${swingPts} points toward ${night.swing > 0 ? 'your candidate' : 'the opponent'}`;
  if (night.turnout != null) {
    const tPts = Math.abs(night.turnout * 100).toFixed(0);
    const gPts = Math.abs(night.gap * 100).toFixed(0);
    swingText += `, turnout was ${tPts}% ${night.turnout >= 0 ? 'higher' : 'lower'} than usual`;
    swingText += gPts === '0' ? ', with both sides turning out evenly'
      : `, and ${night.gap > 0 ? 'your' : "the opponent's"} voters turned out ${gPts}% more`;
  }

  const rows = stats.map((s, d) => {
    const p = sim.winProb[d];
    const nightWin = night.shares[d] > 0.5;
    return `
    <tr>
      <td><span class="dot" style="background:${DISTRICT_COLORS[d]}"></span>District ${d + 1}</td>
      <td class="num">${fmtPct(s.share)}</td>
      <td class="num" style="color:${chanceColor(p)}">${fmtChance(p)}</td>
      <td class="num">${fmtPct(night.shares[d])}</td>
      <td class="${nightWin ? 'win' : 'lose'}">${nightWin ? '✓ You' : '✗ Opp.'}</td>
    </tr>`;
  }).join('');

  const maxP = Math.max(...sim.seatProb);
  const bars = sim.seatProb.map((p, k) => `
    <div class="hist-row">
      <span class="hist-label">${k} seat${k === 1 ? '' : 's'}</span>
      <span class="hist-track"><span class="hist-bar ${k >= game.target ? 'enough' : ''}" style="width:${(p / maxP) * 100}%"></span></span>
      <span class="hist-val">${fmtChance(p)}</span>
    </div>`).join('');

  const lesson = game.lesson != null ? TUTORIAL[game.lesson] : null;
  const title = lesson ? (won ? 'Lesson complete!' : 'Too risky') : won ? 'Victory!' : 'Too risky';
  const body = `
    <h2>${title}</h2>
    ${realDelegation()}
    <p>Across ${game.unc.sims.toLocaleString('en-US')} simulated elections, your map wins ${game.target}+ of ${n} seats
       <strong>${fmtChance(sim.pTarget)}</strong> of the time (you need ${need}%). Expected seats: ${sim.expectedSeats.toFixed(1)}.</p>
    <h3 class="dialog-sub">Seats won across all simulations</h3>
    <div class="histogram">${bars}</div>
    <h3 class="dialog-sub">One simulated election night</h3>
    <p class="small">The state ${swingText}. You won <strong>${nightSeats} of ${n}</strong> seats.</p>
    <table class="results-table">
      <thead><tr><th>District</th><th class="num">Expected</th><th class="num">Win chance</th><th class="num">That night</th><th>Winner</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${metricsSection(stats, true)}
    ${lesson && won ? `<p class="debrief">${lesson.debrief}</p>` : ''}`;
  openDialog(body, electionActions(won));
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
  els.boardScroll = $('#board-scroll');
  els.zoomIn = $('#zoom-in');
  els.zoomOut = $('#zoom-out');
  els.zoomFit = $('#zoom-fit');
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
  els.statusItems = $('#status-items');
  els.modeButtons = document.querySelectorAll('[data-mode]');
  els.campaign = $('#campaign');
  els.partyButtons = document.querySelectorAll('[data-party]');
  els.partyToggle = $('#party-toggle');
  els.uncertaintyBar = $('#uncertainty-bar');
  els.swingSlider = $('#swing-slider');
  els.swingValue = $('#swing-value');
  els.gapGroup = $('#gap-group');
  els.gapSlider = $('#gap-slider');
  els.gapValue = $('#gap-value');
  els.swingReset = $('#swing-reset');
  els.uncertaintyInfo = $('#uncertainty-info');
  els.stressToggle = $('#stress-toggle');

  const generated = document.createElement('optgroup');
  generated.label = 'Generated maps';
  for (const [key, cfg] of Object.entries(SIZES)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = cfg.label;
    generated.append(opt);
  }
  els.size.append(generated);
  if (REAL_STATES.length) {
    const real = document.createElement('optgroup');
    real.label = 'Real states (2020 data)';
    for (const S of REAL_STATES) {
      const opt = document.createElement('option');
      opt.value = S.code;
      opt.textContent = `${S.name} · ${S.seats} districts`;
      real.append(opt);
    }
    els.size.append(real);
  }
  ui.party = storageGet(PARTY_KEY) === 'rep' ? 'rep' : 'dem';
  if (['pop', 'both', 'none', 'turnout'].includes(storageGet(LABEL_KEY))) ui.label = storageGet(LABEL_KEY);

  const params = new URLSearchParams(window.location.search);
  const stateParam = findState(params.get('state')) ? params.get('state') : null;
  const sizeKey = stateParam || (SIZES[params.get('size')] ? params.get('size') : 'medium');
  const seedParam = parseInt(params.get('seed'), 10);
  const savedMode = params.has('seed') || stateParam ? params.get('mode') : storageGet(MODE_KEY);
  ui.realistic = savedMode === 'realistic' || savedMode === 'campaign';
  ui.campaign = savedMode === 'campaign';
  if (stateParam && ['dem', 'rep'].includes(params.get('party'))) ui.party = params.get('party');
  els.size.value = sizeKey;
  bindEvents();
  initStartScreen();

  const lessonParam = parseInt(params.get('tutorial'), 10);
  if (lessonParam >= 1 && lessonParam <= TUTORIAL.length) {
    startLesson(lessonParam - 1);
  } else if (stateParam) {
    startGame(stateParam);
  } else if (Number.isFinite(seedParam) && seedParam >= 0) {
    startGame(sizeKey, seedParam);
  } else {
    // A normal visit opens the start screen; a map loads behind it so Menu has something to return to.
    startGame(sizeKey, randomSeed());
    showStartScreen();
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
if (typeof module !== 'undefined') {
  module.exports = { generateMap, computeStats, SIZES, TOLERANCE, buildGrid, sampleLegalPlans, findBestPlan, mulberry32, generateGeography, TUTORIAL,
    generateRealisticMap, simulatePlan, buildUncertainty, findRobustPlan, kthShare, planShares, PASS_PROBABILITY,
    buildMaskedGrid, anneal, growPartition };
}
