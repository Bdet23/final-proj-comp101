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
  small:  { label: 'Small · 4 districts',  cols: 6,  rows: 6, districts: 4 },
  medium: { label: 'Medium · 6 districts', cols: 8,  rows: 7, districts: 6 },
  large:  { label: 'Large · 8 districts',  cols: 10, rows: 8, districts: 8 },
};
const TOLERANCE = 0.05;          // districts must be within ±5% of ideal population
const PEOPLE_PER_TILE = 4000;    // average tile population
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
// The generator first draws a hidden, valid district plan, then sets
// populations and vote shares so that this plan wins for the player.
// That guarantees every map has at least one winning solution.

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

function growPartition(tiles, n, rand) {
  const owner = new Array(tiles.length).fill(-1);
  const sizes = new Array(n).fill(0);
  pickSeeds(tiles, n, rand).forEach((s, d) => {
    owner[s] = d;
    sizes[d] = 1;
  });
  let remaining = tiles.length - n;
  while (remaining > 0) {
    const order = range(n).sort((a, b) => sizes[a] - sizes[b] || rand() - 0.5);
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
        sizes[d]++;
        remaining--;
        grew = true;
        break;
      }
    }
    if (!grew) return null;
  }
  const avg = tiles.length / n;
  if (Math.min(...sizes) < avg * 0.6) return null;
  return owner;
}

function assignPopulations(tiles, plan, n, rand) {
  // A few "cities" make nearby tiles more populous.
  const cityCount = 1 + Math.floor(n / 3);
  const cities = range(cityCount).map(() => tiles[Math.floor(rand() * tiles.length)]);
  const spread = 2 * (HEX * 2.5) ** 2;
  const weight = tiles.map((t) =>
    1 + rand() * 0.8 + cities.reduce((s, c) => s + 4 * Math.exp(-((t.x - c.x) ** 2 + (t.y - c.y) ** 2) / spread), 0)
  );

  const ideal = Math.round(((tiles.length / n) * PEOPLE_PER_TILE) / 1000) * 1000;
  for (let d = 0; d < n; d++) {
    const ids = tiles.filter((t) => plan[t.id] === d).map((t) => t.id);
    const total = ids.reduce((s, i) => s + weight[i], 0);
    let sum = 0;
    for (const i of ids) {
      tiles[i].pop = Math.max(200, Math.round((ideal * weight[i]) / total / 10) * 10);
      sum += tiles[i].pop;
    }
    // Put any rounding difference on the largest tile so the hidden plan is exact.
    const biggest = ids.reduce((a, b) => (tiles[a].pop >= tiles[b].pop ? a : b));
    tiles[biggest].pop += ideal - sum;
  }
  return ideal;
}

function assignLeans(tiles, plan, n, target, rand) {
  const winners = new Set(shuffle(range(n), rand).slice(0, target));
  const base = range(n).map((d) => (winners.has(d) ? 0.525 + rand() * 0.045 : 0.22 + rand() * 0.16));

  let lean = tiles.map((t) => base[plan[t.id]] + (rand() - 0.5) * 0.22);
  // Blur across tiles so the hidden plan's borders are not obvious.
  for (let pass = 0; pass < 2; pass++) {
    lean = tiles.map((t) => {
      const ns = t.nbrs.filter((j) => j >= 0);
      const avg = ns.reduce((s, j) => s + lean[j], 0) / ns.length;
      return 0.55 * lean[t.id] + 0.45 * avg;
    });
  }
  // Re-center every hidden district on its intended vote share.
  for (let it = 0; it < 6; it++) {
    for (let d = 0; d < n; d++) {
      let pop = 0;
      let votes = 0;
      for (const t of tiles) {
        if (plan[t.id] === d) {
          pop += t.pop;
          votes += t.pop * lean[t.id];
        }
      }
      const shift = base[d] - votes / pop;
      for (const t of tiles) {
        if (plan[t.id] === d) lean[t.id] = Math.min(0.95, Math.max(0.05, lean[t.id] + shift));
      }
    }
  }
  for (const t of tiles) t.lean = Math.round(lean[t.id] * 100);
}

function generateMap(sizeKey, seed) {
  const cfg = SIZES[sizeKey];
  const n = cfg.districts;
  const target = Math.floor(n / 2) + 1;
  for (let attempt = 0; attempt < 50; attempt++) {
    const rand = mulberry32(seed * 7919 + attempt);
    const tiles = buildGrid(cfg.cols, cfg.rows);
    let plan = null;
    for (let k = 0; k < 100 && !plan; k++) plan = growPartition(tiles, n, rand);
    if (!plan) continue;
    const ideal = assignPopulations(tiles, plan, n, rand);
    assignLeans(tiles, plan, n, target, rand);

    const stats = computeStats(tiles, plan, n, ideal);
    const seats = stats.filter((s) => s.wins).length;
    const valid = stats.every((s) => s.popOk && s.connected);
    const totalVotes = stats.reduce((s, d) => s + d.votes, 0);
    const totalPop = stats.reduce((s, d) => s + d.pop, 0);
    // Keep only maps that are solvable and where the player trails statewide.
    if (valid && seats >= target && totalVotes / totalPop < 0.5) {
      return { sizeKey, cfg, seed, tiles, ideal, target, solution: plan, totalPop, statewideShare: totalVotes / totalPop };
    }
  }
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
  game = generateMap(sizeKey, seed);
  ui.assign = new Array(game.tiles.length).fill(-1);
  ui.tool = 0;
  ui.revealed = false;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('size', sizeKey);
    url.searchParams.set('seed', String(seed));
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
    <p class="muted">Map #${game.seed}</p>`;
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
    if (els.dialog.open || e.target.closest('input, select, textarea')) return;
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
