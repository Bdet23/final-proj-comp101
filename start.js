'use strict';

/* ==========================================================================
   Start screen: the first thing a player sees on a normal visit.

   Layout (desktop): a dimmed Lesson 3 map fills the background; the title
   logo sits at the top centre; below it, a "How to play" card (left, always
   visible) and a "Choose how to play" card (right); a legend strip along the
   bottom. On phones the cards stack: logo, buttons, how to play, legend.
   Enter activates the highlighted button; the header's Menu button reopens
   this screen. Direct links (?tutorial=, ?state=, ?seed=) skip it.

   Uses globals from game.js: TUTORIAL, SIZES, REAL_STATES, ui, els, game,
   startLesson, startGame, randomSeed, storageSet, lessonsCompleted, MODE_KEY,
   buildGrid, leanColor, hexPoints, hexCorner, HEX, PAD, SQRT3.
   ========================================================================== */

const startEls = {};
let startMode = 'classic';

function initStartScreen() {
  startEls.screen = document.querySelector('#start-screen');
  startEls.bg = document.querySelector('#start-bg');
  startEls.tutorial = document.querySelector('#start-tutorial');
  startEls.dots = document.querySelector('#start-dots');
  startEls.play = document.querySelector('#start-play');
  startEls.size = document.querySelector('#start-size');
  startEls.modes = document.querySelectorAll('[data-start-mode]');
  startEls.menu = document.querySelector('#menu-btn');
  startEls.mute = document.querySelector('#mute-btn');

  startEls.size.innerHTML = els.size.innerHTML; // same options as the header's Map menu
  drawStartBackground();

  startEls.tutorial.addEventListener('click', () => {
    Sound.startAmbient();
    const done = lessonsCompleted();
    hideStartScreen();
    startLesson(done >= TUTORIAL.length ? 0 : done);
  });
  startEls.play.addEventListener('click', () => {
    Sound.startAmbient();
    ui.realistic = startMode !== 'classic';
    ui.campaign = startMode === 'campaign';
    storageSet(MODE_KEY, startMode);
    els.size.value = startEls.size.value;
    hideStartScreen();
    startGame(startEls.size.value, randomSeed());
  });
  for (const b of startEls.modes) {
    b.addEventListener('click', () => {
      startMode = b.dataset.startMode;
      renderStartModes();
    });
  }
  startEls.menu.addEventListener('click', showStartScreen);
  startEls.mute.addEventListener('click', () => {
    Sound.setMuted(!Sound.isMuted());
    renderMuteButton();
  });
  renderMuteButton();

  document.addEventListener('keydown', (e) => {
    if (startEls.screen.hidden || e.key !== 'Enter') return;
    if (e.target.closest('button, select, input, a')) return; // let focused controls handle Enter
    e.preventDefault();
    startEls.screen.querySelector('.start-primary').click();
  });
}

function renderMuteButton() {
  const m = Sound.isMuted();
  startEls.mute.setAttribute('aria-pressed', String(m));
  startEls.mute.textContent = m ? '🔇 Sound off' : '🔊 Sound on';
  startEls.mute.title = m ? 'Turn sound on' : 'Mute all sound';
}

function renderStartModes() {
  for (const b of startEls.modes) b.setAttribute('aria-pressed', String(b.dataset.startMode === startMode));
}

function showStartScreen() {
  const done = lessonsCompleted();
  const total = TUTORIAL.length;
  // Tutorial button: start, continue or replay; it is the highlighted choice until the tutorial is done.
  const tutorialFirst = done < total;
  startEls.tutorial.textContent = done === 0 ? 'Start tutorial'
    : done < total ? `Continue tutorial: Lesson ${done + 1}` : 'Replay tutorial';
  startEls.dots.innerHTML = TUTORIAL.map((L, i) =>
    `<span class="dot ${i < done ? 'done' : i === done ? 'next' : ''}" title="${L.title}"></span>`).join('');
  startEls.dots.setAttribute('aria-label', `${done} of ${total} lessons complete`);
  startEls.tutorial.classList.toggle('primary', tutorialFirst);
  startEls.tutorial.classList.toggle('start-primary', tutorialFirst);
  startEls.play.classList.toggle('primary', !tutorialFirst);
  startEls.play.classList.toggle('start-primary', !tutorialFirst);

  startMode = ui.campaign ? 'campaign' : ui.realistic ? 'realistic' : 'classic';
  renderStartModes();
  startEls.size.value = els.size.value;

  startEls.screen.hidden = false;
  document.body.classList.add('start-open');
  Sound.setMenuOpen(true);
  startEls.screen.querySelector('.start-primary').focus({ preventScroll: true });
}

function hideStartScreen() {
  startEls.screen.hidden = true;
  document.body.classList.remove('start-open');
  Sound.setMenuOpen(false);
}

// A finished Lesson 3 map, dimmed behind the start screen.
function drawStartBackground() {
  const L = TUTORIAL[2];
  const tiles = buildGrid(L.cols, L.rows);
  tiles.forEach((t, i) => { t.lean = L.leans[i]; });
  const w = PAD * 2 + SQRT3 * HEX * (L.cols + 0.5);
  const h = PAD * 2 + HEX * 2 + 1.5 * HEX * (L.rows - 1);
  let svg = '';
  for (const t of tiles) {
    svg += `<polygon points="${hexPoints(t.x, t.y, HEX)}" fill="${leanColor(t.lean)}" stroke="#fff" stroke-width="1.5"/>`;
  }
  let edges = '';
  for (const t of tiles) {
    const a = L.solution[t.id];
    for (let k = 0; k < 6; k++) {
      const j = t.nbrs[k];
      if (j >= 0 && (j < t.id || L.solution[j] === a)) continue;
      const [x1, y1] = hexCorner(t.x, t.y, HEX, k);
      const [x2, y2] = hexCorner(t.x, t.y, HEX, (k + 1) % 6);
      edges += `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`;
    }
  }
  startEls.bg.setAttribute('viewBox', `0 0 ${w.toFixed(1)} ${h.toFixed(1)}`);
  startEls.bg.innerHTML = `${svg}<path d="${edges}" fill="none" stroke="#1b1d21" stroke-width="4" stroke-linecap="round"/>`;
}
