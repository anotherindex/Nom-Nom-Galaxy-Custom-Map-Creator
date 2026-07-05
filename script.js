'use strict';

/* =========================================================================
   CONSTANTS
   ========================================================================= */
const TILE_SIZE = 50;          // source image resolution, world px per tile
const MAX_CELLS = 200000;      // hard cap on total tiles in a map
const MAX_HISTORY = 20;        // undo/redo steps kept
const DEFAULT_MAP_NAME = 'My Custom NNG Map'; // shown in the Map Name field and used as a safe fallback
const BASE_MIN_ZOOM = 0.02;
let MIN_ZOOM = BASE_MIN_ZOOM;  // dynamically lowered for very large/thin maps so they can always fit on screen
const MAX_ZOOM = 8;

/* =========================================================================
   ELEMENT DEFINITIONS
   Index 0 is reserved for "empty" (rendered as white / #ffffff, exported as
   opaque white, and matched from either an opaque white or fully
   transparent pixel on import).
   Each of the 19 real elements has a fixed display name and an exact RGB
   color used for export, and matched exactly (not approximated) on import.
   ========================================================================= */
const ELEMENT_DEFS = [
  null, // index 0 unused (that's "empty")
  { name: "Dirt",       hex: "#000000" },
  { name: "Stone",      hex: "#808080" },
  { name: "Water",      hex: "#0000ff" },
  { name: "Crytal",     hex: "#ff0000" },
  { name: "Floppy",     hex: "#004080" },
  { name: "Matter",     hex: "#008040" },
  { name: "Oxygen",     hex: "#ff00ff" },
  { name: "Bison",      hex: "#ff8000" },
  { name: "Mammoth",    hex: "#ff8040" },
  { name: "Purana",     hex: "#de6868" },
  { name: "Strawburi",  hex: "#c02020" },
  { name: "Cornbug",    hex: "#808020" },
  { name: "Shroomba",   hex: "#20c020" },
  { name: "Tomaty",     hex: "#00ff20" },
  { name: "Squidfly",   hex: "#2020c0" },
  { name: "Tree",       hex: "#408040" },
  { name: "Oxygrass",   hex: "#80ffff" },
  { name: "Thornbloom", hex: "#804080" },
  { name: "Spawn",      hex: "#00ffff" }  // index 19 - limited to a single instance on the canvas, see SPAWN_ELEMENT_INDEX
];

const NUM_TILES = ELEMENT_DEFS.length - 1; // 19
const SPAWN_ELEMENT_INDEX = NUM_TILES;     // "Spawn" is always the last element (index 19)

const TILE_NAMES = ELEMENT_DEFS.slice(1).map(e => e.name);

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)];
}

/* =========================================================================
   PALETTE  (tile index 1..19  ->  exact RGB used on export / matched on import)
   ========================================================================= */
const PALETTE = (() => {
  const arr = [null]; // index 0 unused
  for (let i = 1; i <= NUM_TILES; i++) arr.push(hexToRgb(ELEMENT_DEFS[i].hex));
  return arr;
})();

// exact color -> tile index, for O(1) lookup on import (no nearest-color
// guessing - an import must match one of these colors exactly, or it's
// flagged as invalid and reported to the user)
const COLOR_TO_TILE = new Map();
for (let i = 1; i <= NUM_TILES; i++) {
  const [r, g, b] = PALETTE[i];
  COLOR_TO_TILE.set(r + ',' + g + ',' + b, i);
}

// A pixel counts as "empty" if it's meaningfully transparent, OR if it's
// opaque (or near-opaque) white - matching the "#ffffff" empty-space color.
function isEmptyPixel(r, g, b, a) {
  if (a < 128) return true;
  return r === 255 && g === 255 && b === 255;
}

// Exact match only. Returns a tile index (1..NUM_TILES) or null if the
// pixel doesn't correspond to any known element color.
function matchPixelToTile(r, g, b) {
  const found = COLOR_TO_TILE.get(r + ',' + g + ',' + b);
  return found === undefined ? null : found;
}

/* =========================================================================
   TILE IMAGES  (full-size artwork drawn on the canvas)
   ========================================================================= */
const tileImages = new Array(NUM_TILES + 1).fill(null);
function loadTileImages() {
  for (let i = 1; i <= NUM_TILES; i++) {
    const img = new Image();
    img.src = `images/${String(i).padStart(2, '0')}.png`;
    img.onload = () => requestRender();
    img.onerror = () => { img.failed = true; requestRender(); };
    tileImages[i] = img;
  }
}

/* =========================================================================
   ICON IMAGES  (separate, smaller artwork used only for the toolbar
   element-picker buttons - e.g. "images/icon_05.png" for element 5)
   ========================================================================= */
const iconImages = new Array(NUM_TILES + 1).fill(null);
function loadIconImages() {
  for (let i = 1; i <= NUM_TILES; i++) {
    const img = new Image();
    img.src = `images/icon_${String(i).padStart(2, '0')}.png`;
    img.onload = () => refreshTilePaletteThumbnail(i);
    img.onerror = () => { img.failed = true; refreshTilePaletteThumbnail(i); };
    iconImages[i] = img;
  }
}


/* =========================================================================
   ELEMENT OFFSETS
   Each of the 19 elements may use a source PNG larger than TILE_SIZE (50px).
   x/y define which pixel of the source image lines up with the tile's
   top-left corner: image top-left (world px) = tile top-left - (x, y).

   Edit these values by hand for any element whose image is bigger than
   50x50 and needs repositioning. Leave an entry at (0, 0) to keep the
   image's own top-left pixel pinned to the tile's top-left pixel (it will
   then overflow to the right/down only, if it's larger than the tile).

   Example: a 150x150 image with offset {x: 50, y: 50} is centered on its
   tile, overflowing 50px (one tile) in every direction.

   This is purely a rendering setting - it never affects the underlying
   grid data, and therefore never affects Export/Load Map, which stay one
   pixel-per-tile regardless of how big or offset the artwork is rendered.
   ========================================================================= */
const ELEMENT_OFFSETS = {
  1: { x: 0, y: 0 },   // Dirt
  2: { x: 0, y: 0 },   // Stone
  3: { x: 0, y: 0 },   // Water
  4: { x: 0, y: 0 },   // Crytal
  5: { x: 0, y: 0 },   // Floppy
  6: { x: 0, y: 0 },   // Matter
  7: { x: 0, y: 0 },   // Oxygen
  8: { x: 50, y: 0 },   // Bison
  9: { x: 250, y: 200 },   // Mammoth
  10: { x: 50, y: 50 },  // Purana
  11: { x: 100, y: 100 },  // Strawburi
  12: { x: 50, y: 150 },  // Cornbug
  13: { x: 50, y: 150 },  // Shroomba
  14: { x: 100, y: 200 },  // Tomaty
  15: { x: 50, y: 0 },  // Squidfly
  16: { x: 100, y: 400 },  // Tree
  17: { x: 50, y: 200 },  // Oxygrass
  18: { x: 50, y: 300 },  // Thornbloom
  19: { x: 150, y: 450 }   // Spawn
};

// Resolved per-element rendering info: actual image size (falls back to
// TILE_SIZE while unloaded/missing) plus its configured offset.
function getElementMeta(v) {
  const img = tileImages[v];
  const off = ELEMENT_OFFSETS[v] || { x: 0, y: 0 };
  const loaded = !!(img && img.complete && img.naturalWidth && !img.failed);
  return {
    img,
    loaded,
    w: loaded ? img.naturalWidth : TILE_SIZE,
    h: loaded ? img.naturalHeight : TILE_SIZE,
    offsetX: off.x,
    offsetY: off.y
  };
}

// Largest amount (world px) any element's image can bleed past its own
// tile's edges in each direction. Used to widen the visible-tile scan range
// so oversized/offset images bleeding in from just outside the viewport
// still get drawn. Cheap to recompute every frame (only 19 elements).
function computeMaxBleed() {
  let left = 0, top = 0, right = 0, bottom = 0;
  for (let i = 1; i <= NUM_TILES; i++) {
    const m = getElementMeta(i);
    left = Math.max(left, m.offsetX);
    top = Math.max(top, m.offsetY);
    right = Math.max(right, m.w - TILE_SIZE - m.offsetX);
    bottom = Math.max(bottom, m.h - TILE_SIZE - m.offsetY);
  }
  return {
    left: Math.max(0, left), top: Math.max(0, top),
    right: Math.max(0, right), bottom: Math.max(0, bottom)
  };
}

/* =========================================================================
   GRID MODEL
   ========================================================================= */
const grid = { cols: 0, rows: 0, data: new Uint8Array(0) };

function createGrid(cols, rows) {
  grid.cols = cols;
  grid.rows = rows;
  grid.data = new Uint8Array(cols * rows); // all zero = empty
  spawnLocation = null; // a brand new grid always starts with no Spawn placed
}

function inBounds(c, r) {
  return c >= 0 && r >= 0 && c < grid.cols && r < grid.rows;
}
function getTile(c, r) {
  if (!inBounds(c, r)) return 0;
  return grid.data[r * grid.cols + c];
}
function setTile(c, r, v) {
  if (!inBounds(c, r)) return;
  grid.data[r * grid.cols + c] = v;
}
function gridHasContent() {
  for (let i = 0; i < grid.data.length; i++) if (grid.data[i] !== 0) return true;
  return false;
}

/* =========================================================================
   SPAWN UNIQUENESS
   The "Spawn" element (SPAWN_ELEMENT_INDEX) may only exist at one location
   on the whole canvas at a time. Placing a new one removes the old one.
   spawnLocation tracks that single location ({col,row} or null) so most
   operations can check/update it in O(1) instead of rescanning the grid.
   ========================================================================= */
let spawnLocation = null;

// Places any tile value at (c,r), automatically enforcing the Spawn
// single-instance rule: placing a new Spawn clears the previous one (if
// any, and if it's a different cell); overwriting the tracked Spawn cell
// with something else clears the tracking. Use this instead of setTile()
// for any single-cell interactive placement (pen clicks, shape anchors,
// fill, paste) where the painted value might be SPAWN_ELEMENT_INDEX.
function placeTile(c, r, value) {
  if (!inBounds(c, r)) return;
  if (value === SPAWN_ELEMENT_INDEX) {
    if (spawnLocation && (spawnLocation.col !== c || spawnLocation.row !== r)) {
      setTile(spawnLocation.col, spawnLocation.row, 0);
    }
    setTile(c, r, value);
    spawnLocation = { col: c, row: r };
  } else {
    setTile(c, r, value);
    if (spawnLocation && spawnLocation.col === c && spawnLocation.row === r) {
      spawnLocation = null;
    }
  }
}

// Cheap O(1) check to call after any bulk grid write (erasing a shape,
// flood fill, etc.) that might have overwritten the tracked Spawn cell
// without going through placeTile().
function verifySpawnStillPresent() {
  if (spawnLocation && getTile(spawnLocation.col, spawnLocation.row) !== SPAWN_ELEMENT_INDEX) {
    spawnLocation = null;
  }
}

// Full-grid scan to (re)locate the Spawn element. Only needed after the
// grid's data array is wholesale replaced (undo/redo, or right after
// loading a map, where the Spawn location is instead tracked incrementally
// during the pixel-matching loop itself). O(cells), but only ever called
// once per discrete action, so it's cheap even at the 200,000-tile cap.
function rebuildSpawnLocation() {
  spawnLocation = null;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      if (grid.data[r * grid.cols + c] === SPAWN_ELEMENT_INDEX) {
        spawnLocation = { col: c, row: r };
        return;
      }
    }
  }
}

/* =========================================================================
   VIEW (pan / zoom) state - world px = tile index * TILE_SIZE
   ========================================================================= */
const view = { zoom: 1, offsetX: 0, offsetY: 0 };

function screenToWorld(x, y) {
  return { wx: view.offsetX + x / view.zoom, wy: view.offsetY + y / view.zoom };
}
function worldToTile(wx, wy) {
  return { col: Math.floor(wx / TILE_SIZE), row: Math.floor(wy / TILE_SIZE) };
}
function screenToTile(x, y) {
  const { wx, wy } = screenToWorld(x, y);
  return worldToTile(wx, wy);
}

function updateMinZoomForGrid() {
  if (!grid.cols || !grid.rows) { MIN_ZOOM = BASE_MIN_ZOOM; return; }
  const rect = canvas.getBoundingClientRect();
  const availW = rect.width || 800, availH = rect.height || 600;
  const mapW = grid.cols * TILE_SIZE, mapH = grid.rows * TILE_SIZE;
  const fitZoom = Math.min(availW / mapW, availH / mapH);
  // leave a little headroom below the exact fit zoom so resetViewToFit's
  // clamp never collides with floating point rounding at the boundary
  MIN_ZOOM = Math.max(0.0005, Math.min(BASE_MIN_ZOOM, fitZoom * 0.8));
}

/* =========================================================================
   APP / TOOL STATE
   ========================================================================= */
const state = {
  tool: 'pen',
  selectedTile: 1,
  thickness: 1,
  mapName: DEFAULT_MAP_NAME,

  spaceDown: false,
  isPanning: false,
  panStart: null,        // {x,y, offsetX, offsetY}

  isDrawing: false,
  activeButton: 0,        // 0 = left (paint), 2 = right (erase)
  dragStartCell: null,
  hoverCell: null,
  beforeSnapshot: null,   // grid snapshot captured at gesture start
  lastPenCell: null,

  previewCells: null,     // Set of "c,r" strings currently highlighted

  selecting: false,
  selectStartCell: null,
  selection: null,        // {x0,y0,x1,y1} normalized inclusive tile bounds

  clipboard: null,        // {w,h,data:Uint8Array}
  pasteMode: false,
  pasteAnchor: null,      // {col,row} top-left of floating paste

  settings: { showGrid: true, checkerboard: false, advancedExport: false }
};

/* =========================================================================
   HISTORY (undo / redo)
   ========================================================================= */
let undoStack = [];
let redoStack = [];

function snapshotGrid() {
  return { cols: grid.cols, rows: grid.rows, data: grid.data.slice() };
}
function restoreSnapshot(s) {
  grid.cols = s.cols;
  grid.rows = s.rows;
  grid.data = s.data;
  rebuildSpawnLocation();
}
function commitAction(beforeSnapshot) {
  if (!beforeSnapshot) return;
  undoStack.push(beforeSnapshot);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  updateHistoryButtons();
  autosave();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshotGrid());
  if (redoStack.length > MAX_HISTORY) redoStack.shift();
  restoreSnapshot(undoStack.pop());
  clearTransientState();
  updateHistoryButtons();
  requestRender();
  autosave();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshotGrid());
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  restoreSnapshot(redoStack.pop());
  clearTransientState();
  updateHistoryButtons();
  requestRender();
  autosave();
}
function updateHistoryButtons() {
  document.getElementById('btnUndo').disabled = undoStack.length === 0;
  document.getElementById('btnRedo').disabled = redoStack.length === 0;
}
function clearTransientState() {
  state.selection = null;
  state.pasteMode = false;
  state.pasteAnchor = null;
  state.previewCells = null;
}

/* =========================================================================
   SHAPE / BRUSH GEOMETRY
   ========================================================================= */
function brushCells(center, thickness) {
  const cells = [];
  const radius = thickness / 2;
  const rad2 = radius * radius + 0.001;
  const span = Math.ceil(radius);
  for (let dr = -span; dr <= span; dr++) {
    for (let dc = -span; dc <= span; dc++) {
      const d2 = dc * dc + dr * dr;
      if (d2 <= rad2) cells.push({ col: center.col + dc, row: center.row + dr });
    }
  }
  return cells;
}

function lineCellsRaw(a, b) {
  // Bresenham between two tile coordinates, inclusive
  const pts = [];
  let x0 = a.col, y0 = a.row, x1 = b.col, y1 = b.row;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x1 >= x0 ? 1 : -1, sy = y1 >= y0 ? 1 : -1;
  let err = dx - dy;
  let x = x0, y = y0;
  while (true) {
    pts.push({ col: x, row: y });
    if (x === x1 && y === y1) break;
    const e2 = err * 2;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return pts;
}

function lineCells(a, b, thickness) {
  const set = new Map();
  for (const p of lineCellsRaw(a, b)) {
    for (const c of brushCells(p, thickness)) set.set(c.col + ',' + c.row, c);
  }
  return Array.from(set.values());
}

function rectCells(a, b) {
  const x0 = Math.min(a.col, b.col), x1 = Math.max(a.col, b.col);
  const y0 = Math.min(a.row, b.row), y1 = Math.max(a.row, b.row);
  const cells = [];
  for (let r = y0; r <= y1; r++) for (let c = x0; c <= x1; c++) cells.push({ col: c, row: r });
  return cells;
}

function circleCells(center, edge) {
  const dx = edge.col - center.col, dy = edge.row - center.row;
  const radius = Math.sqrt(dx * dx + dy * dy);
  const r2 = (radius + 0.5) * (radius + 0.5);
  const span = Math.ceil(radius) + 1;
  const cells = [];
  for (let dr = -span; dr <= span; dr++) {
    for (let dc = -span; dc <= span; dc++) {
      if (dc * dc + dr * dr <= r2) cells.push({ col: center.col + dc, row: center.row + dr });
    }
  }
  return cells;
}

function paintCells(cells, value) {
  for (const c of cells) setTile(c.col, c.row, value);
}

function floodFill(startCol, startRow, value) {
  const target = getTile(startCol, startRow);
  if (target === value) return;
  if (!inBounds(startCol, startRow)) return;
  const stack = [[startCol, startRow]];
  const cols = grid.cols, rows = grid.rows;
  while (stack.length) {
    const [c, r] = stack.pop();
    if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
    if (grid.data[r * cols + c] !== target) continue;
    grid.data[r * cols + c] = value;
    stack.push([c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]);
  }
}

/* =========================================================================
   CANVAS / RENDERING
   ========================================================================= */
const canvas = document.getElementById('mainCanvas');
const ctx = canvas.getContext('2d');
let renderRequested = false;

function requestRender() {
  if (renderRequested) return;
  renderRequested = true;
  requestAnimationFrame(() => { renderRequested = false; render(); });
}

function resizeCanvasToContainer() {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function render() {
  resizeCanvasToContainer();
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // outside-of-canvas background
  ctx.fillStyle = '#c2c2c2';
  ctx.fillRect(0, 0, w, h);

  if (!grid.cols || !grid.rows) return;

  const wx0 = view.offsetX, wy0 = view.offsetY;
  const zoom = view.zoom;
  const ts = TILE_SIZE * zoom;

  const boundsX0 = (0 - wx0) * zoom;
  const boundsY0 = (0 - wy0) * zoom;
  const boundsX1 = (grid.cols * TILE_SIZE - wx0) * zoom;
  const boundsY1 = (grid.rows * TILE_SIZE - wy0) * zoom;

  // drawable area background (distinguishes in-bounds empty tiles from outside-gray)
  if (state.settings.checkerboard) {
    drawCheckerboard(boundsX0, boundsY0, boundsX1, boundsY1, ts);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(boundsX0, boundsY0, boundsX1 - boundsX0, boundsY1 - boundsY0);
  }

  const wx1 = wx0 + w / zoom, wy1 = wy0 + h / zoom;
  const bleed = computeMaxBleed();
  const c0 = Math.max(0, Math.floor(wx0 / TILE_SIZE) - Math.ceil(bleed.left / TILE_SIZE));
  const r0 = Math.max(0, Math.floor(wy0 / TILE_SIZE) - Math.ceil(bleed.top / TILE_SIZE));
  const c1 = Math.min(grid.cols - 1, Math.ceil(wx1 / TILE_SIZE) + Math.ceil(bleed.right / TILE_SIZE));
  const r1 = Math.min(grid.rows - 1, Math.ceil(wy1 / TILE_SIZE) + Math.ceil(bleed.bottom / TILE_SIZE));

  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const v = grid.data[r * grid.cols + c];
      if (v === 0) continue;
      drawTileAt(v, c, r);
    }
  }

  // grid lines are computed from the un-expanded on-screen tile range so they
  // only ever cover the actual viewport, regardless of image bleed
  const gc0 = Math.max(0, Math.floor(wx0 / TILE_SIZE));
  const gr0 = Math.max(0, Math.floor(wy0 / TILE_SIZE));
  const gc1 = Math.min(grid.cols - 1, Math.ceil(wx1 / TILE_SIZE));
  const gr1 = Math.min(grid.rows - 1, Math.ceil(wy1 / TILE_SIZE));

  if (state.settings.showGrid && ts >= 4) {
    drawGridLines(gc0, gr0, gc1, gr1, wx0, wy0, zoom, boundsX0, boundsY0, boundsX1, boundsY1, w, h);
  }

  drawOverlays();
}

function drawCheckerboard(x0, y0, x1, y1, ts) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.clip();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.fillStyle = '#e6e6e6';
  const step = Math.max(ts, 4);
  let toggle = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0 + ((toggle % 2) ? step : 0); x < x1; x += step * 2) {
      ctx.fillRect(x, y, step, step);
    }
    toggle++;
  }
  ctx.restore();
}

function drawTileAt(v, col, row) {
  const meta = getElementMeta(v);
  if (meta.loaded) {
    const worldX = col * TILE_SIZE - meta.offsetX;
    const worldY = row * TILE_SIZE - meta.offsetY;
    const sx = (worldX - view.offsetX) * view.zoom;
    const sy = (worldY - view.offsetY) * view.zoom;
    const sw = meta.w * view.zoom;
    const sh = meta.h * view.zoom;
    ctx.drawImage(meta.img, sx, sy, sw, sh);
  } else {
    // image not loaded (yet, or missing) - fall back to a plain numbered
    // tile-sized square at the tile's own position, ignoring any configured
    // offset since we don't know the real artwork's intended footprint
    const sx = (col * TILE_SIZE - view.offsetX) * view.zoom;
    const sy = (row * TILE_SIZE - view.offsetY) * view.zoom;
    const ts = TILE_SIZE * view.zoom;
    const colr = PALETTE[v];
    ctx.fillStyle = `rgb(${colr[0]},${colr[1]},${colr[2]})`;
    ctx.fillRect(sx, sy, ts, ts);
    if (ts > 12) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.font = `${Math.max(8, Math.min(20, ts * 0.4))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(v), sx + ts / 2, sy + ts / 2);
    }
  }
}

function drawGridLines(c0, r0, c1, r1, wx0, wy0, zoom, bx0, by0, bx1, by1, w, h) {
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const top = Math.max(0, by0), bottom = Math.min(h, by1);
  const left = Math.max(0, bx0), right = Math.min(w, bx1);
  for (let c = c0; c <= c1 + 1; c++) {
    const sx = Math.round((c * TILE_SIZE - wx0) * zoom) + 0.5;
    ctx.moveTo(sx, top);
    ctx.lineTo(sx, bottom);
  }
  for (let r = r0; r <= r1 + 1; r++) {
    const sy = Math.round((r * TILE_SIZE - wy0) * zoom) + 0.5;
    ctx.moveTo(left, sy);
    ctx.lineTo(right, sy);
  }
  ctx.stroke();
}

function tileToScreenRect(c, r) {
  const sx = (c * TILE_SIZE - view.offsetX) * view.zoom;
  const sy = (r * TILE_SIZE - view.offsetY) * view.zoom;
  const ts = TILE_SIZE * view.zoom;
  return { sx, sy, ts };
}

function drawOverlays() {
  // live preview of cells about to be painted
  if (state.previewCells && state.previewCells.length) {
    ctx.fillStyle = state.activeButton === 2 ? 'rgba(255,70,70,0.45)' : 'rgba(60,140,255,0.40)';
    for (const cell of state.previewCells) {
      const { sx, sy, ts } = tileToScreenRect(cell.col, cell.row);
      ctx.fillRect(sx, sy, ts, ts);
    }
  }

  // selection in progress (dragging) - soft but noticeable red
  if (state.selecting && state.selectStartCell && state.hoverCell) {
    drawSelectionRect(state.selectStartCell, state.hoverCell, 'rgba(255,90,90,0.30)', '#ff6b6b');
  }
  // finalized selection - stronger, more noticeable blue
  if (state.selection) {
    const s = state.selection;
    drawSelectionRect({ col: s.x0, row: s.y0 }, { col: s.x1, row: s.y1 }, 'rgba(40,130,255,0.28)', '#2f8fff');
  }

  // floating paste preview
  if (state.pasteMode && state.clipboard && state.pasteAnchor) {
    const cb = state.clipboard;
    ctx.globalAlpha = 0.75;
    for (let r = 0; r < cb.h; r++) {
      for (let c = 0; c < cb.w; c++) {
        const v = cb.data[r * cb.w + c];
        if (v === 0) continue;
        drawTileAt(v, state.pasteAnchor.col + c, state.pasteAnchor.row + r);
      }
    }
    ctx.globalAlpha = 1;
    const a = state.pasteAnchor;
    drawSelectionRect(a, { col: a.col + cb.w - 1, row: a.row + cb.h - 1 }, 'transparent', '#ffd54a');
  }
}

function drawSelectionRect(a, b, fill, strokeColor) {
  const x0 = Math.min(a.col, b.col), x1 = Math.max(a.col, b.col);
  const y0 = Math.min(a.row, b.row), y1 = Math.max(a.row, b.row);
  const sx = (x0 * TILE_SIZE - view.offsetX) * view.zoom;
  const sy = (y0 * TILE_SIZE - view.offsetY) * view.zoom;
  const sw = (x1 - x0 + 1) * TILE_SIZE * view.zoom;
  const sh = (y1 - y0 + 1) * TILE_SIZE * view.zoom;
  if (fill && fill !== 'transparent') {
    ctx.fillStyle = fill;
    ctx.fillRect(sx, sy, sw, sh);
  }
  ctx.save();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(sx + 0.75, sy + 0.75, sw - 1.5, sh - 1.5);
  ctx.restore();
}

/* =========================================================================
   PREVIEW COMPUTATION
   ========================================================================= */
function updatePreview() {
  const tool = state.tool;
  if (!state.hoverCell) { state.previewCells = null; return; }

  if (state.pasteMode) {
    state.previewCells = null;
    return;
  }

  if (state.isDrawing) {
    const paintValue = state.activeButton === 2 ? 0 : state.selectedTile;
    const spawnPlacement = paintValue === SPAWN_ELEMENT_INDEX;
    if (tool === 'line') {
      state.previewCells = spawnPlacement
        ? [{ col: state.dragStartCell.col, row: state.dragStartCell.row }]
        : lineCells(state.dragStartCell, state.hoverCell, state.thickness);
    } else if (tool === 'rect') {
      state.previewCells = spawnPlacement
        ? [{ col: state.dragStartCell.col, row: state.dragStartCell.row }]
        : rectCells(state.dragStartCell, state.hoverCell);
    } else if (tool === 'circle') {
      state.previewCells = spawnPlacement
        ? [{ col: state.dragStartCell.col, row: state.dragStartCell.row }]
        : circleCells(state.dragStartCell, state.hoverCell);
    } else {
      // pen paints directly into the grid as the cursor moves, so the
      // freshly-painted pixels themselves are the feedback - no overlay needed.
      state.previewCells = null;
    }
  } else {
    const spawnSelected = state.selectedTile === SPAWN_ELEMENT_INDEX;
    if (tool === 'pen' || tool === 'line' || tool === 'circle') {
      state.previewCells = spawnSelected
        ? [{ col: state.hoverCell.col, row: state.hoverCell.row }]
        : brushCells(state.hoverCell, state.thickness);
    } else if (tool === 'rect') {
      state.previewCells = [{ col: state.hoverCell.col, row: state.hoverCell.row }];
    } else if (tool === 'fill') {
      state.previewCells = [{ col: state.hoverCell.col, row: state.hoverCell.row }];
    } else {
      state.previewCells = null;
    }
  }
}

/* =========================================================================
   TOOL PALETTE UI
   ========================================================================= */
// canvas 2D contexts for each palette button's 32x32 thumbnail, keyed by
// element index, so icon images that finish loading asynchronously (or
// fail to load) can redraw just their own thumbnail without rebuilding
// the whole palette.
const tilePaletteThumbCtx = new Array(NUM_TILES + 1).fill(null);

function drawPaletteThumbnail(i) {
  const tctx = tilePaletteThumbCtx[i];
  if (!tctx) return;
  tctx.clearRect(0, 0, 32, 32);
  const img = iconImages[i];
  if (img && img.complete && img.naturalWidth && !img.failed) {
    tctx.drawImage(img, 0, 0, 32, 32);
  } else {
    const col = PALETTE[i];
    tctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
    tctx.fillRect(0, 0, 32, 32);
    tctx.fillStyle = 'rgba(0,0,0,0.55)';
    tctx.font = '11px sans-serif';
    tctx.textAlign = 'center';
    tctx.textBaseline = 'middle';
    tctx.fillText(String(i), 16, 17);
  }
}

function refreshTilePaletteThumbnail(i) {
  drawPaletteThumbnail(i);
}

function buildTilePalette() {
  const container = document.getElementById('tilePalette');
  container.innerHTML = '';
  for (let i = 1; i <= NUM_TILES; i++) {
    const btn = document.createElement('div');
    btn.className = 'tileBtn';
    btn.dataset.tile = i;
    btn.title = TILE_NAMES[i - 1];

    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 32;
    thumbCanvas.height = 32;
    tilePaletteThumbCtx[i] = thumbCanvas.getContext('2d');
    drawPaletteThumbnail(i);

    const label = document.createElement('div');
    label.className = 'tileName';
    label.textContent = TILE_NAMES[i - 1];

    btn.appendChild(thumbCanvas);
    btn.appendChild(label);
    btn.addEventListener('click', () => selectTile(i));
    container.appendChild(btn);
  }
  refreshTilePaletteActive();
}

function refreshTilePaletteActive() {
  document.querySelectorAll('.tileBtn').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.tile) === state.selectedTile);
  });
}

function selectTile(i) {
  state.selectedTile = i;
  refreshTilePaletteActive();
  document.getElementById('statusTile').textContent = `Element: ${TILE_NAMES[i - 1]}`;
}

function setTool(tool) {
  state.tool = tool;
  state.isDrawing = false;
  state.selecting = false;
  document.querySelectorAll('.toolBtn').forEach(el => {
    el.classList.toggle('active', el.dataset.tool === tool);
  });
  document.getElementById('statusTool').textContent =
    `Tool: ${tool.charAt(0).toUpperCase()}${tool.slice(1)}`;
  canvas.classList.toggle('cursor-hand', tool === 'hand');
  if (tool !== 'select') {
    // keep selection visible across tool switches; only clear paste mode
  }
  requestRender();
}

/* =========================================================================
   STATUS BAR
   ========================================================================= */
function updateStatusBar() {
  document.getElementById('statusSize').textContent = `Map: ${grid.cols} x ${grid.rows}`;
  document.getElementById('statusZoom').textContent = `Zoom: ${Math.round(view.zoom * 100)}%`;
  if (state.hoverCell) {
    document.getElementById('statusCursor').textContent = `Cursor: ${state.hoverCell.col}, ${state.hoverCell.row}`;
  } else {
    document.getElementById('statusCursor').textContent = `Cursor: -, -`;
  }
}

/* =========================================================================
   MOUSE / KEYBOARD INTERACTION
   ========================================================================= */
function getCanvasRelativePos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const { x, y } = getCanvasRelativePos(e);
  const before = screenToWorld(x, y);
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
  view.offsetX = before.wx - x / view.zoom;
  view.offsetY = before.wy - y / view.zoom;
  updateStatusBar();
  requestRender();
}, { passive: false });

canvas.addEventListener('mousedown', e => {
  const { x, y } = getCanvasRelativePos(e);
  const cell = screenToTile(x, y);
  state.hoverCell = cell;

  const wantsPan = state.spaceDown || state.tool === 'hand';
  if (wantsPan && e.button === 0) {
    state.isPanning = true;
    state.panStart = { x, y, offsetX: view.offsetX, offsetY: view.offsetY };
    canvas.classList.add('cursor-panning');
    return;
  }

  if (state.pasteMode) {
    if (e.button === 0) commitPaste();
    return;
  }

  if (state.tool === 'hand') return;

  if (e.button !== 0 && e.button !== 2) return;
  state.activeButton = e.button;
  const paintValue = e.button === 2 ? 0 : state.selectedTile;

  if (state.tool === 'fill') {
    const before = snapshotGrid();
    if (paintValue === SPAWN_ELEMENT_INDEX) {
      // flood-filling with Spawn would place many instances at once, which
      // isn't allowed - only the single clicked pixel becomes Spawn.
      placeTile(cell.col, cell.row, paintValue);
    } else {
      floodFill(cell.col, cell.row, paintValue);
      verifySpawnStillPresent();
    }
    commitAction(before);
    requestRender();
    return;
  }

  if (state.tool === 'select') {
    state.selecting = true;
    state.selectStartCell = cell;
    state.selection = null;
    requestRender();
    return;
  }

  // pen / line / rect / circle
  state.isDrawing = true;
  state.dragStartCell = cell;
  state.beforeSnapshot = snapshotGrid();

  if (state.tool === 'pen') {
    state.lastPenCell = cell;
    if (paintValue === SPAWN_ELEMENT_INDEX) {
      // only the very first pixel of a Spawn stroke counts - dragging
      // further will not paint more Spawn instances (see mousemove)
      placeTile(cell.col, cell.row, paintValue);
    } else {
      paintCells(brushCells(cell, state.thickness), paintValue);
      verifySpawnStillPresent();
    }
    state.previewCells = null;
    requestRender();
  } else {
    updatePreview();
    requestRender();
  }
});

window.addEventListener('mousemove', e => {
  const { x, y } = getCanvasRelativePos(e);
  const cell = screenToTile(x, y);
  state.hoverCell = cell;

  if (state.isPanning) {
    const dx = x - state.panStart.x, dy = y - state.panStart.y;
    view.offsetX = state.panStart.offsetX - dx / view.zoom;
    view.offsetY = state.panStart.offsetY - dy / view.zoom;
    requestRender();
    updateStatusBar();
    return;
  }

  if (state.selecting) {
    requestRender();
    updateStatusBar();
    return;
  }

  if (state.isDrawing) {
    const paintValue = state.activeButton === 2 ? 0 : state.selectedTile;
    if (state.tool === 'pen') {
      if (paintValue === SPAWN_ELEMENT_INDEX) {
        // Spawn was already placed on mousedown; ignore further drag -
        // only the very first clicked pixel of a stroke can become Spawn.
      } else {
        const path = lineCellsRaw(state.lastPenCell, cell);
        for (const p of path) paintCells(brushCells(p, state.thickness), paintValue);
        verifySpawnStillPresent();
      }
      state.lastPenCell = cell;
    }
    updatePreview();
    requestRender();
    updateStatusBar();
    return;
  }

  updatePreview();
  requestRender();
  updateStatusBar();
});

window.addEventListener('mouseup', e => {
  if (state.isPanning) {
    state.isPanning = false;
    canvas.classList.remove('cursor-panning');
    return;
  }

  if (state.selecting) {
    state.selecting = false;
    const a = state.selectStartCell, b = state.hoverCell || a;
    state.selection = {
      x0: Math.min(a.col, b.col), x1: Math.max(a.col, b.col),
      y0: Math.min(a.row, b.row), y1: Math.max(a.row, b.row)
    };
    requestRender();
    return;
  }

  if (state.isDrawing) {
    const paintValue = state.activeButton === 2 ? 0 : state.selectedTile;
    const spawnPlacement = paintValue === SPAWN_ELEMENT_INDEX;
    if (state.tool === 'line') {
      if (spawnPlacement) {
        placeTile(state.dragStartCell.col, state.dragStartCell.row, paintValue);
      } else {
        paintCells(lineCells(state.dragStartCell, state.hoverCell, state.thickness), paintValue);
      }
    } else if (state.tool === 'rect') {
      if (spawnPlacement) {
        placeTile(state.dragStartCell.col, state.dragStartCell.row, paintValue);
      } else {
        paintCells(rectCells(state.dragStartCell, state.hoverCell), paintValue);
      }
    } else if (state.tool === 'circle') {
      if (spawnPlacement) {
        placeTile(state.dragStartCell.col, state.dragStartCell.row, paintValue);
      } else {
        paintCells(circleCells(state.dragStartCell, state.hoverCell), paintValue);
      }
    }
    if (!spawnPlacement) verifySpawnStillPresent();
    state.isDrawing = false;
    commitAction(state.beforeSnapshot);
    state.beforeSnapshot = null;
    state.previewCells = null;
    requestRender();
  }
});

canvas.addEventListener('mouseleave', () => {
  state.hoverCell = null;
  if (!state.isDrawing && !state.isPanning && !state.selecting) {
    state.previewCells = null;
    requestRender();
  }
  updateStatusBar();
});

/* ---- keyboard ---- */
const TOOL_HOTKEYS = { a: 'pen', s: 'line', d: 'rect', f: 'circle', g: 'fill', h: 'select', j: 'hand' };
const VALID_TOOLS = new Set(Object.values(TOOL_HOTKEYS));

window.addEventListener('keydown', e => {
  const tag = document.activeElement && document.activeElement.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA';

  if (e.code === 'Space' && !typing) {
    state.spaceDown = true;
    canvas.classList.add('cursor-hand');
    e.preventDefault();
    return;
  }

  if (typing) return;

  // While any modal (New Map / Settings / Info-Guide) is open, hotkeys
  // shouldn't affect the canvas underneath - Escape just closes it.
  if (!modalOverlay.classList.contains('hidden')) {
    if (e.key === 'Escape') closeModals();
    return;
  }

  const key = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;

  if (mod && key === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (mod && key === 'y') { e.preventDefault(); redo(); return; }
  if (mod && key === 'c') { e.preventDefault(); copySelection(); return; }
  if (mod && key === 'x') { e.preventDefault(); cutSelection(); return; }
  if (mod && key === 'v') { e.preventDefault(); startPaste(); return; }

  if (e.key === 'Escape') {
    state.pasteMode = false;
    state.pasteAnchor = null;
    state.selection = null;
    state.isDrawing = false;
    state.selecting = false;
    requestRender();
    return;
  }

  // Number keys 1-9 and 0 select the first ten elements (0 = element 10)
  if (!mod && /^[0-9]$/.test(e.key)) {
    const digit = e.key === '0' ? 10 : parseInt(e.key, 10);
    if (digit <= NUM_TILES) selectTile(digit);
    return;
  }

  // Q / E cycle to the previous/next element, wrapping around at the ends
  // (Q on element 1 wraps to the last element; E on the last element wraps to 1)
  if (!mod && (key === 'q' || key === 'e')) {
    const dir = key === 'q' ? -1 : 1;
    let next = state.selectedTile + dir;
    if (next < 1) next = NUM_TILES;
    if (next > NUM_TILES) next = 1;
    selectTile(next);
    return;
  }

  if (!mod && TOOL_HOTKEYS[key]) {
    setTool(TOOL_HOTKEYS[key]);
  }
});

window.addEventListener('keyup', e => {
  if (e.code === 'Space') {
    state.spaceDown = false;
    if (state.tool !== 'hand') canvas.classList.remove('cursor-hand');
  }
});

/* =========================================================================
   COPY / CUT / PASTE
   ========================================================================= */
function copySelection() {
  if (!state.selection) return;
  const s = state.selection;
  const w = s.x1 - s.x0 + 1, h = s.y1 - s.y0 + 1;
  const data = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      data[r * w + c] = getTile(s.x0 + c, s.y0 + r);
    }
  }
  state.clipboard = { w, h, data };
}

function cutSelection() {
  if (!state.selection) return;
  const before = snapshotGrid();
  copySelection();
  const s = state.selection;
  for (let r = s.y0; r <= s.y1; r++) {
    for (let c = s.x0; c <= s.x1; c++) setTile(c, r, 0);
  }
  verifySpawnStillPresent();
  commitAction(before);
  requestRender();
}

function startPaste() {
  if (!state.clipboard) return;
  state.pasteMode = true;
  state.pasteAnchor = state.hoverCell || { col: 0, row: 0 };
  requestRender();
}

function commitPaste() {
  if (!state.clipboard || !state.pasteAnchor) return;
  const before = snapshotGrid();
  const cb = state.clipboard, a = state.pasteAnchor;
  for (let r = 0; r < cb.h; r++) {
    for (let c = 0; c < cb.w; c++) {
      const v = cb.data[r * cb.w + c];
      // placeTile (rather than a raw setTile) keeps the Spawn single-instance
      // rule intact even when pasting a region that contains a Spawn pixel.
      if (v !== 0) placeTile(a.col + c, a.row + r, v);
    }
  }
  commitAction(before);
  state.pasteMode = false;
  state.pasteAnchor = null;
  requestRender();
}

/* =========================================================================
   MARKDOWN GUIDE
   A small, dependency-free markdown-lite renderer for the Info/Guide modal.
   Supports: headers (# .. ######, six font sizes), **bold**, *italic*,
   `inline code`, [link text](url) and ![alt text](image url), bullet (-)
   and numbered (1.) lists, horizontal rules (---), and paragraphs.

   Edit GUIDE_MARKDOWN below to change what shows up in the Info/Guide
   popup - it's rendered once, the first time the button is clicked.
   ========================================================================= */
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdownInline(text) {
  // images: ![alt text](url "optional title")
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (m, alt, url, title) => {
    const t = title ? ` title="${title}"` : '';
    return `<img src="${url}" alt="${alt}"${t}>`;
  });
  // links: [link text](url "optional title") - rendered as text, underlined via CSS
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (m, label, url, title) => {
    const t = title ? ` title="${title}"` : '';
    return `<a href="${url}"${t} target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  // bold, then italic (order matters so **x** isn't half-consumed by *x*)
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  // inline code
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  return text;
}

function renderMarkdown(md) {
  const rawLines = md.replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let paragraphLines = [];
  let listType = null; // 'ul' | 'ol' | null
  let listItems = [];

  function flushParagraph() {
    if (paragraphLines.length) {
      const joined = paragraphLines.map(l => renderMarkdownInline(escapeHtml(l))).join('<br>');
      html += `<p>${joined}</p>`;
      paragraphLines = [];
    }
  }
  function flushList() {
    if (listType) {
      const items = listItems.map(it => `<li>${renderMarkdownInline(escapeHtml(it))}</li>`).join('');
      html += listType === 'ul' ? `<ul>${items}</ul>` : `<ol>${items}</ol>`;
      listType = null;
      listItems = [];
    }
  }

  for (const line of rawLines) {
    const trimmed = line.trim();

    if (trimmed === '') { flushParagraph(); flushList(); continue; }

    const headerMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (headerMatch) {
      flushParagraph(); flushList();
      const level = headerMatch[1].length;
      html += `<h${level}>${renderMarkdownInline(escapeHtml(headerMatch[2]))}</h${level}>`;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph(); flushList();
      html += '<hr>';
      continue;
    }

    const ulMatch = /^[-*]\s+(.*)$/.exec(trimmed);
    if (ulMatch) {
      flushParagraph();
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listItems.push(ulMatch[1]);
      continue;
    }

    const olMatch = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (olMatch) {
      flushParagraph();
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listItems.push(olMatch[1]);
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }
  flushParagraph();
  flushList();
  return html;
}

const GUIDE_MARKDOWN = `# Nom Nom Galaxy Custom Map Creator
*v0.8 - by @anotherindex and Claude... but mainly Claude lol*

A tool to create custom maps for the videogame **PixelJunk™ Nom Nom Galaxy** ([Steam page](https://store.steampowered.com/app/226100/PixelJunk_Nom_Nom_Galaxy/)).

## I. How to use this map creator

- Use **New Map** (top left) to create a new blank map, or **Load Map** to load a previously created one.
- Use the Tools and Elements to place things on the map or edit it.
- Hotkeys are simple and highly recommended:
- Pen (A), Line (S), Rectangle (D), Circle (F), Fill bucket (G), Select (H), Hand/Pan (J)
- Number keys **1-9** and **0** jump straight to elements 1-10.
- **Q** / **E** step to the previous / next element, wrapping around at both ends.
- *Right-click* with any drawing tool erases instead of painting.
- Hold *Space* and drag to pan the canvas from any tool.
- Mouse wheel scrolls to zoom in and out.

The **Select tool (H)** is a powerful tool that lets you copy, cut, and paste areas of the map:

1. Pick the tool, then select an area on the map.
2. Press Ctrl+C to copy, or Ctrl+X to cut the selected area.
3. Hover your mouse over the top-left corner of where you want to paste.
4. Press Ctrl+V - a preview of the pasted selection appears. Left-click to place it; hover elsewhere and press Ctrl+V again to reposition; press Esc to cancel.

You can paste the same copied/cut area multiple times, a bit like a stamp.

## II. How to export and play a custom map

*(If you are using a Chromium-based browser like Chrome or Edge you can try enabling the "Advanced Map Export" in the Settings, but note that it is an experimental feature. A detailed tutorial can be found below the default one.)*

1. Once your map is ready, make sure you've placed a Spawn point, then click **Export Map** (top left). This downloads a .png file.
2. Navigate to your Nom Nom Galaxy folder, usually in your Steam directory: \`steamapps\\common\\NomNomGalaxy\\custom_planets\`. The easiest way there is to right-click Nom Nom Galaxy in your Steam library, select "Manage", then "Browse Local Files".
3. Open the \`custom_planets\` folder and create a new folder with the name you want for your map, e.g. "My New Map". Place the downloaded .png inside and rename it to your folder's name with \`_map.png\` at the end.

Examples:
- \`NomNomGalaxy\\custom_planets\\Squidfly Planet 04\\Squidfly Planet 04_map.png\`
- \`NomNomGalaxy\\custom_planets\\test_planet_461\\test_planet_461_map.png\`
- \`NomNomGalaxy\\custom_planets\\Hello World\\Hello World_map.png\`

Launch Nom Nom Galaxy, go to **Corporate Conquest** (the main story mode), and navigate to **SoupCo Planet Database**, located near the very beginning. From there you should be able to select your map.

![Element 5 icon](images/guide_planet.jpg)

*Note: you can add new folders and maps while the game is running, no restart needed. You cannot, however, edit any folders or maps the game has already detected and loaded during that session.*

### Advanced Map Export (optional)
If you are using a Chromium-based browser like Google Chrome or Microsoft Edge you can enable the "Advanced Map Export" feature in the Settings. The Setting button can be found next to the "Load Map" button.
If enabled, the "Export Map" button will now ask you for the location of your Nom Nom Galaxy "custom_planets" folder. 
(The easiest way to do that is to right-click Nom Nom Galaxy in your Steam library, select "Manage", then "Browse Local Files". Then create a shortcut to that folder on for example your Desktop for easy access.)
Once you selected your "custom_planets" during export, the browser will prompt you if you want the page to allow aditing files on your computer. This is generally a promt you should not accept, but if you made it far I think you know what you're doing. If you accept it, the Custom Map Creator will have created a folder and map file read to be loaded from inside Nom Nom Galaxy.

## III. Tips, tricks and more

- Don't fully block the sky with stone - the spaceship has to land somewhere, and you need to be able to shoot rockets to ship soup.
- Chickenberry Trees need at least one block directly beneath them, otherwise the map will not load!
- The planet's background and foreground colors are currently randomized, so try changing a pixel if you aren't happy with the result - one small change may do the trick.
- Make sure the bottom layer of your planet is filled in. Floating islands are possible, but you'll still need sturdy ground somewhere.
- Be reasonable with map size and the amount of monster spawns you place - the game might crash under extreme conditions.

## IV. FAQ and troubleshooting

**My map doesn't show up in the game.**
Make sure you named the folder and .png file correctly, as described in step 3 above. Don't use special characters in map or folder names, except for underscores \`_\`, dashes \`-\`, and the pound symbol \`#\`.

**My game crashes the moment I try to launch a custom map.**
The most common reason is a Chickenberry Tree (the teal apple-looking tree) missing a block directly below its trunk. If it still crashes, check for things placed too close together or areas that are too densely populated. You can also ask for help on the [Nom Nom Galaxy Discord](https://discord.gg/NgzyprT) or the [Q-Games Ltd. Discord](https://discord.com/invite/qgamesforever) (in the #classic-q-games channel).

**Can I build with more than the 19 selectable elements?**
No - things like single mushrooms, Kabochasers (the pumpkins), Stabgrass, and more can't be placed manually. They may generate automatically and randomly across the map.

**Can I play against an enemy soup company?**
Not currently. These maps can only be played as S.O.O.P. Simulations - essentially free-play, where the goal is whatever you set for yourself. Try challenging yourself to something like earning 5000 gold within a set number of days, or defeating every enemy without dying once.

**I found a bug with the Map Creator, what should I do?**
Report it on the [GitHub page](https://github.com/anotherindex/Nom-Nom-Galaxy-Custom-Map-Creator), or send a message on Discord to **@anotherindex** (Index) - usually reachable on the Nom Nom Galaxy Discord or the Q-Games Ltd. Discord (in the #classic-q-games channel).

---

For more detailed information, visit the [GitHub page](https://github.com/anotherindex/Nom-Nom-Galaxy-Custom-Map-Creator).

*- Index*`;

/* =========================================================================
   NEW MAP / MODALS
   ========================================================================= */
const modalOverlay = document.getElementById('modalOverlay');
const modalNewMap = document.getElementById('modalNewMap');
const modalSettings = document.getElementById('modalSettings');
const modalInfoGuide = document.getElementById('modalInfoGuide');

function openModal(modalEl) {
  modalOverlay.classList.remove('hidden');
  modalEl.classList.remove('hidden');
}
function closeModals() {
  modalOverlay.classList.add('hidden');
  modalNewMap.classList.add('hidden');
  modalSettings.classList.add('hidden');
  modalInfoGuide.classList.add('hidden');
}
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModals(); });

function updateNewMapTotal() {
  const w = Math.max(1, parseInt(document.getElementById('newMapWidth').value, 10) || 0);
  const h = Math.max(1, parseInt(document.getElementById('newMapHeight').value, 10) || 0);
  const total = w * h;
  document.getElementById('newMapTotal').textContent =
    `Total tiles: ${total.toLocaleString()} / ${MAX_CELLS.toLocaleString()} max`;
  const errEl = document.getElementById('newMapError');
  const exceeds = total > MAX_CELLS;
  errEl.classList.toggle('hidden', !exceeds);
  document.getElementById('btnNewMapCreate').disabled = exceeds;
  return { w, h, exceeds };
}

document.getElementById('newMapWidth').addEventListener('input', updateNewMapTotal);
document.getElementById('newMapHeight').addEventListener('input', updateNewMapTotal);

document.getElementById('btnNewMap').addEventListener('click', () => {
  updateNewMapTotal();
  openModal(modalNewMap);
});
document.getElementById('btnNewMapCancel').addEventListener('click', closeModals);
document.getElementById('btnNewMapCreate').addEventListener('click', () => {
  const { w, h, exceeds } = updateNewMapTotal();
  if (exceeds) return;
  if (gridHasContent() && !confirm('This will replace the current map. Continue?')) return;
  createGrid(w, h);
  resetViewToFit();
  undoStack = []; redoStack = [];
  clearTransientState();
  updateHistoryButtons();
  updateStatusBar();
  closeModals();
  requestRender();
  autosave();
});

document.getElementById('btnSettings').addEventListener('click', () => openModal(modalSettings));
document.getElementById('btnSettingsClose').addEventListener('click', closeModals);
document.getElementById('settingShowGrid').addEventListener('change', e => {
  state.settings.showGrid = e.target.checked;
  requestRender();
  autosave();
});
document.getElementById('settingCheckerboard').addEventListener('change', e => {
  state.settings.checkerboard = e.target.checked;
  requestRender();
  autosave();
});
document.getElementById('settingAdvancedExport').addEventListener('change', e => {
  state.settings.advancedExport = e.target.checked;
  autosave();
});

document.getElementById('btnInfoGuide').addEventListener('click', () => {
  const contentEl = document.getElementById('guideContent');
  if (!contentEl.dataset.rendered) {
    contentEl.innerHTML = renderMarkdown(GUIDE_MARKDOWN);
    contentEl.dataset.rendered = '1';
  }
  openModal(modalInfoGuide);
});
document.getElementById('btnInfoGuideClose').addEventListener('click', closeModals);

function resetViewToFit() {
  updateMinZoomForGrid();
  const rect = canvas.getBoundingClientRect();
  const availW = rect.width || 800, availH = rect.height || 600;
  const mapW = grid.cols * TILE_SIZE, mapH = grid.rows * TILE_SIZE;
  const zoomX = availW / mapW, zoomY = availH / mapH;
  view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(zoomX, zoomY, 1)));
  view.offsetX = -(availW / view.zoom - mapW) / 2;
  view.offsetY = -(availH / view.zoom - mapH) / 2;
}

/* =========================================================================
   AUTOSAVE  (persists the current map + a few view/tool settings in the
   browser's localStorage, so refreshing or reopening the page restores the
   work in progress instead of losing it)
   ========================================================================= */
const AUTOSAVE_KEY = 'pixelMapTool.autosave.v1';

function uint8ToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
function base64ToUint8(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function autosave() {
  if (!grid.cols || !grid.rows) return;
  try {
    const payload = {
      cols: grid.cols,
      rows: grid.rows,
      data: uint8ToBase64(grid.data),
      selectedTile: state.selectedTile,
      tool: state.tool,
      thickness: state.thickness,
      mapName: state.mapName,
      zoom: view.zoom,
      offsetX: view.offsetX,
      offsetY: view.offsetY,
      settings: state.settings
    };
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
  } catch (e) {
    // localStorage full/unavailable (e.g. private browsing) - non-critical,
    // just means this particular save didn't persist.
  }
}

// Attempts to restore a previously autosaved map. Returns true on success.
function loadAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return false;
    const payload = JSON.parse(raw);
    if (!payload || !Number.isFinite(payload.cols) || !Number.isFinite(payload.rows)) return false;
    if (payload.cols <= 0 || payload.rows <= 0 || payload.cols * payload.rows > MAX_CELLS) return false;

    const bytes = base64ToUint8(payload.data);
    if (bytes.length !== payload.cols * payload.rows) return false; // corrupted - bail out safely

    grid.cols = payload.cols;
    grid.rows = payload.rows;
    grid.data = bytes;
    rebuildSpawnLocation();

    if (Number.isInteger(payload.selectedTile) && payload.selectedTile >= 1 && payload.selectedTile <= NUM_TILES) {
      state.selectedTile = payload.selectedTile;
    }
    if (typeof payload.tool === 'string') state.tool = payload.tool;
    if (Number.isFinite(payload.thickness)) state.thickness = payload.thickness;
    if (typeof payload.mapName === 'string' && payload.mapName.length > 0) state.mapName = payload.mapName;
    if (Number.isFinite(payload.zoom)) view.zoom = payload.zoom;
    if (Number.isFinite(payload.offsetX)) view.offsetX = payload.offsetX;
    if (Number.isFinite(payload.offsetY)) view.offsetY = payload.offsetY;
    if (payload.settings && typeof payload.settings === 'object') {
      Object.assign(state.settings, payload.settings);
    }
    return true;
  } catch (e) {
    return false; // corrupted/unavailable storage - caller falls back to a fresh map
  }
}

/* =========================================================================
   MAP NAME  (used to name the exported file / folder)
   ========================================================================= */
const mapNameInput = document.getElementById('mapNameInput');

// Keeps only letters, digits, spaces, dash, underscore, and the pound
// symbol - safe for both a Windows folder/file name and the game's own
// naming rules. Anything else (including punctuation illegal in Windows
// paths, like \ / : * ? " < > |) is silently stripped. Falls back to the
// default name if that leaves nothing usable.
function sanitizeMapName(rawName) {
  if (typeof rawName !== 'string') return DEFAULT_MAP_NAME;
  let cleaned = rawName.replace(/[^A-Za-z0-9 _\-#]/g, '');
  cleaned = cleaned.trim().replace(/\s+/g, ' ');
  return cleaned.length > 0 ? cleaned : DEFAULT_MAP_NAME;
}

mapNameInput.addEventListener('input', () => {
  state.mapName = mapNameInput.value;
  autosave();
});

/* =========================================================================
   EXPORT MAP  (one pixel per tile, exact palette colors; empty = opaque
   white). Two export modes:
   - Normal (default): downloads "<Map Name>_map.png" like any browser download.
   - Advanced (opt-in, Settings): asks the user to pick their local
     "custom_planets" folder and writes the file directly into a matching
     "<Map Name>/<Map Name>_map.png" subfolder, via the File System Access
     API. Only supported in Chromium-based browsers.
   ========================================================================= */

function buildMapPngBlob() {
  return new Promise((resolve, reject) => {
    const out = document.createElement('canvas');
    out.width = grid.cols;
    out.height = grid.rows;
    const octx = out.getContext('2d');
    const imgData = octx.createImageData(grid.cols, grid.rows);
    for (let i = 0; i < grid.data.length; i++) {
      const v = grid.data[i];
      const o = i * 4;
      if (v === 0) {
        // empty space = opaque white (#ffffff)
        imgData.data[o] = 255; imgData.data[o + 1] = 255; imgData.data[o + 2] = 255; imgData.data[o + 3] = 255;
      } else {
        const [r, g, b] = PALETTE[v];
        imgData.data[o] = r; imgData.data[o + 1] = g; imgData.data[o + 2] = b; imgData.data[o + 3] = 255;
      }
    }
    octx.putImageData(imgData, 0, 0);
    out.toBlob(blob => {
      if (blob) resolve(blob); else reject(new Error('Failed to encode the map as a PNG.'));
    }, 'image/png');
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function supportsAdvancedExport() {
  return typeof window.showDirectoryPicker === 'function';
}

// Opens the folder picker as the very first step (before any other async
// work) so the click's user-activation is still fresh when the browser
// evaluates the permission prompt, then writes the file directly via the
// File System Access API.
async function runAdvancedExport(mapName) {
  const rootHandle = await window.showDirectoryPicker({ id: 'nng-custom-planets', mode: 'readwrite' });

  if (rootHandle.name.toLowerCase() !== 'custom_planets') {
    const proceed = confirm(
      `The selected folder is named "${rootHandle.name}", not "custom_planets" - ` +
      `are you sure this is the right folder?\n\nClick OK to save here anyway, or Cancel to pick again.`
    );
    if (!proceed) return; // silently abort - the user can click Export Map again to retry
  }

  const blob = await buildMapPngBlob();
  const mapDirHandle = await rootHandle.getDirectoryHandle(mapName, { create: true });
  const fileHandle = await mapDirHandle.getFileHandle(`${mapName}_map.png`, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  // Browsers deliberately don't expose the full absolute path of a
  // user-picked folder (only its own name), so the confirmation can only
  // describe the structure relative to the folder that was selected.
  alert(`Saved inside the "${rootHandle.name}" folder you selected, as:\n${mapName}\\${mapName}_map.png`);
}

document.getElementById('btnExportMap').addEventListener('click', async () => {
  if (!grid.cols || !grid.rows) { alert('Nothing to export - create a map first.'); return; }
  const mapName = sanitizeMapName(mapNameInput.value);

  if (state.settings.advancedExport) {
    if (!supportsAdvancedExport()) {
      alert('Advanced Map Export isn\'t supported in this browser (it currently only works in Chromium-based browsers like Chrome or Edge). Falling back to a normal download.');
    } else {
      try {
        await runAdvancedExport(mapName);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // user cancelled the folder picker
        console.error(e);
        alert(`Advanced export failed: ${e && e.message ? e.message : 'unknown error'}\n\nFalling back to a normal download.`);
      }
    }
  }

  try {
    const blob = await buildMapPngBlob();
    downloadBlob(blob, `${mapName}_map.png`);
  } catch (e) {
    console.error(e);
    alert('Failed to create the export file.');
  }
});

/* =========================================================================
   LOAD MAP  (reverse of export - exact color match per pixel; anything that
   isn't one of the 19 exact element colors or empty/white/transparent is
   reported to the user and cleared to empty)
   ========================================================================= */
const fileInput = document.getElementById('fileInput');
document.getElementById('btnLoadMap').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  handleLoadMapFile(file);
});

// Decodes an image file into raw pixel data without letting the browser
// apply any color management on top of it. Some PNGs (very commonly ones
// exported by Photoshop) embed an ICC color profile and/or gAMA/cHRM
// chunks; browsers that honor those while decoding through an <img> +
// canvas will subtly shift every pixel's RGB values - invisible to the
// eye, but enough to break this tool's exact-color matching on import,
// even though the file's raw pixel bytes are completely unaffected (the
// same map exported from this tool, then re-saved unchanged by an editor
// that adds such a profile, would otherwise fail to reload correctly).
// createImageBitmap's colorSpaceConversion:'none' option decodes the raw
// sample values as-is, sidestepping that color management entirely.
async function decodeImageFileToPixels(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { colorSpaceConversion: 'none' });
  } catch (e) {
    // Older browsers may not support the options argument - fall back to
    // a plain decode (still works, just re-exposes the color-management
    // risk the option above exists to avoid).
    bitmap = await createImageBitmap(file);
  }

  const w = bitmap.width, h = bitmap.height;
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(bitmap, 0, 0);
  if (bitmap.close) bitmap.close();
  const data = tctx.getImageData(0, 0, w, h).data;
  return { w, h, data };
}

async function handleLoadMapFile(file) {
  let decoded;
  try {
    decoded = await decodeImageFileToPixels(file);
  } catch (e) {
    alert('Could not load that file as an image.');
    return;
  }
  const { w, h, data } = decoded;

  if (w * h > MAX_CELLS) {
    alert(`This image is ${w}x${h} (${(w * h).toLocaleString()} pixels), which exceeds the ${MAX_CELLS.toLocaleString()} tile limit.`);
    return;
  }
  if (gridHasContent() && !confirm('Loading a map will replace the current canvas. Continue?')) return;

  createGrid(w, h);
  let unmatchedCount = 0;
  let duplicateSpawnCount = 0;
  let spawnAlreadyFound = false;

  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3];

    if (isEmptyPixel(r, g, b, a)) {
      grid.data[i] = 0;
      continue;
    }

    const matched = matchPixelToTile(r, g, b);
    if (matched === null) {
      grid.data[i] = 0;
      unmatchedCount++;
      continue;
    }

    if (matched === SPAWN_ELEMENT_INDEX) {
      if (spawnAlreadyFound) {
        // Spawn is limited to one instance - keep the first one found
        // (scanning left-to-right, top-to-bottom) and clear the rest.
        grid.data[i] = 0;
        duplicateSpawnCount++;
        continue;
      }
      spawnAlreadyFound = true;
      spawnLocation = { col: i % w, row: Math.floor(i / w) };
    }

    grid.data[i] = matched;
  }

  resetViewToFit();
  undoStack = []; redoStack = [];
  clearTransientState();
  updateHistoryButtons();
  updateStatusBar();
  requestRender();
  autosave();

  const messages = [];
  if (unmatchedCount > 0) {
    messages.push(`${unmatchedCount.toLocaleString()} pixel(s) from the imported image did not have an associated element and were removed.`);
  }
  if (duplicateSpawnCount > 0) {
    messages.push(`${duplicateSpawnCount.toLocaleString()} extra "Spawn" pixel(s) were found (only one Spawn is allowed on the map) and were removed, keeping the first one.`);
  }
  if (messages.length) alert(messages.join('\n\n'));
}

/* =========================================================================
   THICKNESS CONTROL
   ========================================================================= */
const thicknessInput = document.getElementById('thicknessInput');
function setThickness(v) {
  v = Math.max(1, Math.min(50, Math.round(v) || 1));
  state.thickness = v;
  thicknessInput.value = v;
  updatePreview();
  requestRender();
}
thicknessInput.addEventListener('input', () => setThickness(parseInt(thicknessInput.value, 10)));
document.getElementById('thicknessMinus').addEventListener('click', () => setThickness(state.thickness - 1));
document.getElementById('thicknessPlus').addEventListener('click', () => setThickness(state.thickness + 1));

/* =========================================================================
   TOOL / HISTORY BUTTON WIRING
   ========================================================================= */
document.querySelectorAll('.toolBtn').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});
document.getElementById('btnUndo').addEventListener('click', undo);
document.getElementById('btnRedo').addEventListener('click', redo);

/* =========================================================================
   RESIZE HANDLING
   ========================================================================= */
new ResizeObserver(() => requestRender()).observe(document.getElementById('canvasArea'));

/* =========================================================================
   INIT
   ========================================================================= */
function init() {
  loadTileImages();
  loadIconImages();
  buildTilePalette();

  const restored = loadAutosave();
  if (!restored) {
    createGrid(50, 50);
  }

  setTool(state.tool && VALID_TOOLS.has(state.tool) ? state.tool : 'pen');
  selectTile(state.selectedTile >= 1 && state.selectedTile <= NUM_TILES ? state.selectedTile : 1);
  setThickness(state.thickness || 1);
  updateHistoryButtons();

  if (restored) {
    // grid + view were already restored by loadAutosave - just re-clamp the
    // zoom in case the browser window is a different size than last time
    updateMinZoomForGrid();
    view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom));
  } else {
    resetViewToFit();
  }

  document.getElementById('settingShowGrid').checked = state.settings.showGrid;
  document.getElementById('settingCheckerboard').checked = state.settings.checkerboard;
  document.getElementById('settingAdvancedExport').checked = !!state.settings.advancedExport;

  mapNameInput.value = (typeof state.mapName === 'string' && state.mapName.length > 0) ? state.mapName : DEFAULT_MAP_NAME;

  updateStatusBar();
  requestRender();
}
init();

// last-chance save on tab close / reload, so the very latest camera
// position and any in-flight state gets captured too
window.addEventListener('beforeunload', autosave);
