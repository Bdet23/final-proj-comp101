# Gerrymander

A browser game about gerrymandering. Group hex tiles into districts so your candidate wins a majority of seats, even though they have fewer votes statewide.

## How to play

- Each hex tile shows its **population** and the **expected vote share** for your candidate.
- Divide every tile into the required number of districts.
- Every district must be **connected** and have a population within **±5%** of the ideal (total population ÷ number of districts).
- Your candidate wins a district when its population-weighted vote share is **above 50%**.
- Win at least the target number of districts (a majority) to win the map.

Controls: choose a district, then click or drag across tiles to paint them. Clicking a tile that is already in the chosen district removes it. Keyboard: `1`–`8` choose a district, `E` selects the eraser, `V` switches between the voter view and the district view.

Every generated map has at least one winning plan. If you lose, you can reveal one.
A map can be shared with its URL (`?size=medium&seed=42`).

## Running

The game is plain HTML, CSS and JavaScript with no build step. Open `index.html` in a browser, or publish it with GitHub Pages: **Settings → Pages → Deploy from a branch → `main` / root**.

## Files

- `index.html` – page layout
- `style.css` – styles (supports light and dark mode)
- `game.js` – map generation, district rules and game interface
