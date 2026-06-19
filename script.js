const DIRECTIONS = {
  up: { dr: -1, dc: 0 },
  right: { dr: 0, dc: 1 },
  down: { dr: 1, dc: 0 },
  left: { dr: 0, dc: -1 }
};

const COLORS = ["#8b5cf6", "#f5b83d", "#3f83f8", "#f97316", "#22c55e", "#ec4899", "#14b8a6"];
const YARN_COLORS = ["#ff7a59", "#ffd166", "#5eead4", "#60a5fa", "#c084fc", "#f472b6", "#34d399", "#fb923c"];
const SHAPES = ["maze"];
const SVG_NS = "http://www.w3.org/2000/svg";
const STORAGE_KEY = "arrow-glide-level";
const YARN_STORAGE_KEY = "arrow-glide-yarn-level";
const MODE_STORAGE_KEY = "arrow-glide-mode";
const MODE_ARROWS = "arrows";
const MODE_YARN = "yarn";

const boardEl = document.querySelector("#board");
const boardFrameEl = document.querySelector(".board-frame");
const statusOverlayEl = document.querySelector("#statusOverlay");
const levelLabelEl = document.querySelector("#levelLabel");
const clearedTextEl = document.querySelector("#clearedText");
const prevLevelBtn = document.querySelector("#prevLevel");
const nextLevelBtn = document.querySelector("#nextLevel");
const topNextLevelBtn = document.querySelector("#topNextLevel");
const arrowModeBtn = document.querySelector("#arrowMode");
const yarnModeBtn = document.querySelector("#yarnMode");
const undoBtn = document.querySelector("#undoBtn");

const state = {
  mode: MODE_ARROWS,
  level: 1,
  size: 10,
  arrows: [],
  yarn: null,
  history: [],
  isAnimating: false,
  activeAnimations: 0,
  runId: 0,
  completed: false,
  view: {
    scale: 1,
    x: 0,
    y: 0,
    pointers: new Map(),
    lastPinchDistance: 0,
    isDragging: false,
    dragged: false,
    lastX: 0,
    lastY: 0,
    suppressClickUntil: 0
  }
};

function createRng(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function keyOf(row, col) {
  return `${row},${col}`;
}

function makeSvgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function shuffle(items, rng) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function centerOf(cell) {
  return { x: cell.col + 0.5, y: cell.row + 0.5 };
}

function pointToward(from, to, distance) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    x: from.x + (dx / length) * distance,
    y: from.y + (dy / length) * distance
  };
}

function pointsToD(points) {
  if (points.length === 1) {
    const point = points[0];
    return `M ${point.x - 0.2} ${point.y} L ${point.x + 0.2} ${point.y}`;
  }

  const commands = [`M ${points[0].x} ${points[0].y}`];
  const radius = 0.28;

  for (let index = 1; index < points.length - 1; index += 1) {
    const prev = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const straight = (prev.x === current.x && current.x === next.x) || (prev.y === current.y && current.y === next.y);

    if (straight) {
      commands.push(`L ${current.x} ${current.y}`);
      continue;
    }

    const before = pointToward(current, prev, radius);
    const after = pointToward(current, next, radius);
    commands.push(`L ${before.x} ${before.y}`);
    commands.push(`Q ${current.x} ${current.y} ${after.x} ${after.y}`);
  }

  const last = points[points.length - 1];
  commands.push(`L ${last.x} ${last.y}`);
  return commands.join(" ");
}

function pathToD(path) {
  return pointsToD(path.map(centerOf));
}

function bodyPathToD(path) {
  const points = path.map(centerOf);
  if (points.length < 2) return pointsToD(points);

  const tip = points[points.length - 1];
  const before = points[points.length - 2];
  points[points.length - 1] = pointToward(tip, before, 0.62);
  return pointsToD(points);
}

function arrowHeadToD(path) {
  if (path.length < 2) return "";
  const points = path.map(centerOf);
  const tip = points[points.length - 1];
  const before = points[points.length - 2];
  const dx = tip.x - before.x;
  const dy = tip.y - before.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  const headLength = 1.06;
  const headWidth = 0.86;
  const base = {
    x: tip.x - ux * headLength,
    y: tip.y - uy * headLength
  };
  const left = {
    x: base.x + px * headWidth * 0.5,
    y: base.y + py * headWidth * 0.5
  };
  const right = {
    x: base.x - px * headWidth * 0.5,
    y: base.y - py * headWidth * 0.5
  };

  return `M ${tip.x} ${tip.y} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`;
}

function cellsForPath(path) {
  return path.map((cell) => keyOf(cell.row, cell.col));
}

function isInside(row, col, size) {
  return row >= 0 && row < size && col >= 0 && col < size;
}

function canPlacePath(path, occupied, size, allowed = null) {
  return path.every((cell) => (
    isInside(cell.row, cell.col, size)
    && !occupied.has(keyOf(cell.row, cell.col))
    && (!allowed || allowed.has(keyOf(cell.row, cell.col)))
  ));
}

function growPath(row, col, size, occupied, rng, allowed = null, lengthRange = null, turnChance = 0.28) {
  const path = [{ row, col }];
  const local = new Set([keyOf(row, col)]);
  let current = path[0];
  let dir = null;
  const minLength = lengthRange?.min ?? 5;
  const maxLength = lengthRange?.max ?? (minLength + 3 + Math.floor(rng() * 3));
  const targetLength = minLength + Math.floor(rng() * (maxLength - minLength + 1));

  while (path.length < targetLength) {
    const wantsTurn = dir && rng() < turnChance;
    const options = shuffle(Object.keys(DIRECTIONS), rng).sort((a, b) => {
      if (!dir) return 0;
      if (wantsTurn) {
        if (a !== dir && b === dir) return -1;
        if (a === dir && b !== dir) return 1;
        return 0;
      }
      if (a === dir && b !== dir) return -1;
      if (a !== dir && b === dir) return 1;
      return 0;
    });
    let next = null;
    let nextDir = null;

    for (const option of options) {
      const vector = DIRECTIONS[option];
      const candidate = { row: current.row + vector.dr, col: current.col + vector.dc };
      const key = keyOf(candidate.row, candidate.col);
      if (
        !isInside(candidate.row, candidate.col, size)
        || occupied.has(key)
        || local.has(key)
        || (allowed && !allowed.has(key))
      ) continue;
      next = candidate;
      nextDir = option;
      break;
    }

    if (!next) break;
    path.push(next);
    local.add(keyOf(next.row, next.col));
    current = next;
    dir = nextDir;
  }

  return path;
}

function vectorNamesForAxis(axis) {
  return axis === "horizontal" ? ["left", "right"] : ["up", "down"];
}

function turnNamesForAxis(axis) {
  return axis === "horizontal" ? ["up", "down"] : ["left", "right"];
}

function tryStepPath(path, dir, steps, size, occupied, allowed, local) {
  const vector = DIRECTIONS[dir];
  let current = path[path.length - 1];

  for (let step = 0; step < steps; step += 1) {
    const next = { row: current.row + vector.dr, col: current.col + vector.dc };
    const key = keyOf(next.row, next.col);
    if (
      !isInside(next.row, next.col, size)
      || occupied.has(key)
      || local.has(key)
      || (allowed && !allowed.has(key))
    ) return false;
    path.push(next);
    local.add(key);
    current = next;
  }

  return true;
}

function buildMotifPath(row, col, size, occupied, rng, allowed) {
  const path = [{ row, col }];
  const local = new Set([keyOf(row, col)]);
  const motif = rng();
  const axis = rng() < 0.52 ? "horizontal" : "vertical";
  const mainDir = vectorNamesForAxis(axis)[Math.floor(rng() * 2)];
  const sideDir = turnNamesForAxis(axis)[Math.floor(rng() * 2)];
  const reverseMain = mainDir === "left" ? "right" : mainDir === "right" ? "left" : mainDir === "up" ? "down" : "up";

  if (motif < 0.26) {
    const runs = [3 + Math.floor(rng() * 6), 1 + Math.floor(rng() * 3), 3 + Math.floor(rng() * 6)];
    if (
      tryStepPath(path, mainDir, runs[0], size, occupied, allowed, local)
      && tryStepPath(path, sideDir, runs[1], size, occupied, allowed, local)
      && tryStepPath(path, reverseMain, runs[2], size, occupied, allowed, local)
    ) return path;
  } else if (motif < 0.54) {
    const backSide = sideDir === "up" ? "down" : sideDir === "down" ? "up" : sideDir === "left" ? "right" : "left";
    if (
      tryStepPath(path, mainDir, 5 + Math.floor(rng() * 5), size, occupied, allowed, local)
      && tryStepPath(path, sideDir, 2 + Math.floor(rng() * 3), size, occupied, allowed, local)
      && tryStepPath(path, reverseMain, 4 + Math.floor(rng() * 4), size, occupied, allowed, local)
      && tryStepPath(path, backSide, 1 + Math.floor(rng() * 2), size, occupied, allowed, local)
      && tryStepPath(path, mainDir, 2 + Math.floor(rng() * 4), size, occupied, allowed, local)
    ) return path;
  } else if (motif < 0.78) {
    const runs = [
      2 + Math.floor(rng() * 4),
      1 + Math.floor(rng() * 3),
      2 + Math.floor(rng() * 4),
      1 + Math.floor(rng() * 3),
      2 + Math.floor(rng() * 4)
    ];
    if (
      tryStepPath(path, mainDir, runs[0], size, occupied, allowed, local)
      && tryStepPath(path, sideDir, runs[1], size, occupied, allowed, local)
      && tryStepPath(path, mainDir, runs[2], size, occupied, allowed, local)
      && tryStepPath(path, sideDir, runs[3], size, occupied, allowed, local)
      && tryStepPath(path, reverseMain, runs[4], size, occupied, allowed, local)
    ) return path;
  } else if (motif < 0.96) {
    const innerSide = sideDir === "up" ? "down" : sideDir === "down" ? "up" : sideDir === "left" ? "right" : "left";
    if (
      tryStepPath(path, mainDir, 4 + Math.floor(rng() * 4), size, occupied, allowed, local)
      && tryStepPath(path, sideDir, 2 + Math.floor(rng() * 2), size, occupied, allowed, local)
      && tryStepPath(path, reverseMain, 3 + Math.floor(rng() * 3), size, occupied, allowed, local)
      && tryStepPath(path, innerSide, 1 + Math.floor(rng() * 2), size, occupied, allowed, local)
      && tryStepPath(path, mainDir, 2 + Math.floor(rng() * 2), size, occupied, allowed, local)
    ) return path;
  } else if (tryStepPath(path, mainDir, 5 + Math.floor(rng() * 7), size, occupied, allowed, local)) {
    return path;
  }

  return null;
}

function makeArrow(levelNumber, path, index) {
  return {
    id: `arrow-${levelNumber}-${index}`,
    path,
    dir: directionFromTail(path),
    color: COLORS[(index + levelNumber) % COLORS.length],
    removed: false,
    blocked: false,
    exiting: false,
    animating: false,
    runId: 0,
    groupEl: null,
    hitEl: null,
    lineEl: null,
    headEl: null
  };
}

function normalizedCell(row, col, size) {
  return {
    x: ((col + 0.5) / size - 0.5) * 2,
    y: ((row + 0.5) / size - 0.5) * 2
  };
}

function isInShape(row, col, size, shape) {
  const { x, y } = normalizedCell(row, col, size);
  if (shape === "maze") {
    return Math.abs(x) <= 0.995 && Math.abs(y) <= 0.995;
  }
  if (shape === "heart") {
    const hx = x * 1.08;
    const hy = -y * 1.18 + 0.18;
    return Math.pow(hx * hx + hy * hy - 0.62, 3) - hx * hx * Math.pow(hy, 3) <= 0;
  }
  if (shape === "diamond") {
    return Math.abs(x * 0.9) + Math.abs(y * 0.92) <= 1.02;
  }
  if (shape === "skull") {
    const head = x * x / 0.72 + Math.pow(y + 0.2, 2) / 0.58 <= 1;
    const jaw = Math.abs(x) < 0.48 && y > 0.05 && y < 0.82;
    const cheek = Math.abs(x) < 0.7 && y > 0.0 && y < 0.42;
    return head || jaw || cheek;
  }
  return x * x / 0.88 + y * y / 0.8 <= 1;
}

function shapeCells(size, shape) {
  const cells = [];
  const allowed = new Set();
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!isInShape(row, col, size, shape)) continue;
      const cell = { row, col };
      cells.push(cell);
      allowed.add(keyOf(row, col));
    }
  }
  return { cells, allowed };
}

function directionFromTail(path) {
  if (path.length < 2) return "right";
  const before = path[path.length - 2];
  const tip = path[path.length - 1];
  const dr = tip.row - before.row;
  const dc = tip.col - before.col;
  if (dr < 0) return "up";
  if (dr > 0) return "down";
  if (dc < 0) return "left";
  return "right";
}

function rayBlockCount(path, occupied, size) {
  const dir = directionFromTail(path);
  const vector = DIRECTIONS[dir];
  const ownCells = new Set(cellsForPath(path));
  const tip = path[path.length - 1];
  let row = tip.row + vector.dr;
  let col = tip.col + vector.dc;
  let blockers = 0;
  let distance = 0;

  while (isInside(row, col, size)) {
    distance += 1;
    const key = keyOf(row, col);
    if (occupied.has(key) && !ownCells.has(key)) blockers += 1;
    row += vector.dr;
    col += vector.dc;
  }

  return { blockers, distance };
}

function orientPathForEscape(path, occupied, size) {
  const forward = path.map((cell) => ({ ...cell }));
  const reversed = [...path].reverse().map((cell) => ({ ...cell }));
  const forwardRay = rayBlockCount(forward, occupied, size);
  const reversedRay = rayBlockCount(reversed, occupied, size);
  const forwardScore = forwardRay.blockers * 20 + forwardRay.distance;
  const reversedScore = reversedRay.blockers * 20 + reversedRay.distance;

  return reversedScore < forwardScore ? reversed : forward;
}

function canPathEscape(path, arrows, size, exceptId) {
  const vector = DIRECTIONS[directionFromTail(path)];
  const occupied = occupiedForArrows(arrows, exceptId);
  const tip = path[path.length - 1];
  let row = tip.row + vector.dr;
  let col = tip.col + vector.dc;

  while (isInside(row, col, size)) {
    if (occupied.has(keyOf(row, col))) return false;
    row += vector.dr;
    col += vector.dc;
  }

  return true;
}

function canPathEscapeThroughOccupied(path, occupied, size) {
  const vector = DIRECTIONS[directionFromTail(path)];
  const tip = path[path.length - 1];
  let row = tip.row + vector.dr;
  let col = tip.col + vector.dc;

  while (isInside(row, col, size)) {
    if (occupied.has(keyOf(row, col))) return false;
    row += vector.dr;
    col += vector.dc;
  }

  return true;
}

function orientPathForPlacement(path, occupied, size) {
  const forward = path.map((cell) => ({ ...cell }));
  if (canPathEscapeThroughOccupied(forward, occupied, size)) return forward;

  const reversed = [...path].reverse().map((cell) => ({ ...cell }));
  if (canPathEscapeThroughOccupied(reversed, occupied, size)) return reversed;

  return null;
}

function orientArrowsForSolvability(arrows, size) {
  const simulated = arrows.map((arrow, index) => ({
    ...arrow,
    originalIndex: index,
    path: arrow.path.map((cell) => ({ ...cell })),
    removed: false
  }));
  let progress = true;

  while (progress) {
    progress = false;

    for (const arrow of simulated) {
      if (arrow.removed) continue;

      const forward = arrow.path.map((cell) => ({ ...cell }));
      const reversed = [...arrow.path].reverse().map((cell) => ({ ...cell }));
      let chosen = null;

      if (canPathEscape(forward, simulated, size, arrow.id)) {
        chosen = forward;
      } else if (canPathEscape(reversed, simulated, size, arrow.id)) {
        chosen = reversed;
      }

      if (!chosen) continue;

      arrow.path = chosen;
      arrow.dir = directionFromTail(chosen);
      arrow.removed = true;
      arrows[arrow.originalIndex].path = chosen.map((cell) => ({ ...cell }));
      arrows[arrow.originalIndex].dir = directionFromTail(chosen);
      progress = true;
    }
  }

  arrows.forEach((arrow) => {
    arrow.removed = false;
  });

  return simulated.every((arrow) => arrow.removed);
}

function occupiedForArrows(arrows, exceptId = "") {
  const occupied = new Set();
  arrows.forEach((arrow) => {
    if (arrow.removed || arrow.id === exceptId) return;
    arrow.path.forEach((cell) => occupied.add(keyOf(Math.round(cell.row), Math.round(cell.col))));
  });
  return occupied;
}

function canEscapeFromArrows(arrow, arrows, size) {
  const vector = DIRECTIONS[arrow.dir];
  const occupied = occupiedForArrows(arrows, arrow.id);
  const tip = tipOf(arrow);
  let row = tip.row + vector.dr;
  let col = tip.col + vector.dc;

  while (isInside(row, col, size)) {
    if (occupied.has(keyOf(row, col))) return false;
    row += vector.dr;
    col += vector.dc;
  }

  return true;
}

function countBlockedArrows(arrows, size) {
  return arrows.filter((arrow) => !canEscapeFromArrows(arrow, arrows, size)).length;
}

function isSolvable(arrows, size) {
  const simulated = arrows.map((arrow) => ({
    ...arrow,
    path: arrow.path.map((cell) => ({ ...cell })),
    removed: false
  }));
  let removedThisPass = true;

  while (removedThisPass) {
    removedThisPass = false;
    for (const arrow of simulated) {
      if (arrow.removed || !canEscapeFromArrows(arrow, simulated, size)) continue;
      arrow.removed = true;
      removedThisPass = true;
    }
  }

  return simulated.every((arrow) => arrow.removed);
}

function buildLevelLayout(levelNumber, salt, densityScale = 1) {
  const rng = createRng(9209 + levelNumber * 149 + salt * 7919);
  const size = Math.min(58, 54 + Math.floor(levelNumber / 24));
  const shape = SHAPES[(levelNumber - 1) % SHAPES.length];
  const { cells: allowedCells, allowed } = shapeCells(size, shape);
  const occupied = new Set();
  const arrows = [];
  const desiredFill = Math.floor(allowedCells.length * 0.94 * densityScale);
  const maxTracks = Math.floor((295 + levelNumber * 0.7) * densityScale);
  let attempts = 0;

  function distanceFromCenter(cell) {
    return Math.hypot(cell.row - size / 2, cell.col - size / 2);
  }

  function chooseStartCell(centerBias = 0.5) {
    let best = null;
    const samples = rng() < centerBias ? 14 : 5;

    for (let sample = 0; sample < samples; sample += 1) {
      const candidate = allowedCells[Math.floor(rng() * allowedCells.length)];
      if (!candidate || occupied.has(keyOf(candidate.row, candidate.col))) continue;
      if (!best || distanceFromCenter(candidate) < distanceFromCenter(best)) best = candidate;
    }

    return best || allowedCells[Math.floor(rng() * allowedCells.length)];
  }

  function reservePath(path) {
    cellsForPath(path).forEach((key) => occupied.add(key));
    arrows.push(makeArrow(levelNumber, path, arrows.length));
  }

  function fillRemainingGaps() {
    let gapAttempts = 0;
    const maxGapAttempts = Math.max(14000, maxTracks * 90);

    while (occupied.size < desiredFill && arrows.length < maxTracks && gapAttempts < maxGapAttempts) {
      gapAttempts += 1;
      const start = chooseStartCell(0.38);
      if (!start || occupied.has(keyOf(start.row, start.col))) continue;

      const lengthRange = rng() < 0.68
        ? { min: 4, max: 7 }
        : { min: 5, max: 9 };
      const path = rng() < 0.55
        ? buildMotifPath(start.row, start.col, size, occupied, rng, allowed)
        : growPath(start.row, start.col, size, occupied, rng, allowed, lengthRange, 0.88);
      if (!path || path.length < 3 || !canPlacePath(path, occupied, size, allowed)) continue;

      const oriented = orientPathForPlacement(path, occupied, size);
      if (!oriented) continue;
      reservePath(oriented);
    }
  }

  while (occupied.size < desiredFill && arrows.length < maxTracks && attempts < 26000) {
    attempts += 1;
    const centerBias = arrows.length < maxTracks * 0.62 ? 0.92 : 0.58;
    const start = chooseStartCell(centerBias);
    if (!start || occupied.has(keyOf(start.row, start.col))) continue;

    const longTrackQuota = Math.floor(maxTracks * 0.08);
    const lengthRange = arrows.length < longTrackQuota
      ? { min: 5, max: 9 }
      : rng() < 0.62
        ? { min: 4, max: 7 }
        : { min: 5, max: 8 };
    const motifPath = rng() < 0.75
      ? buildMotifPath(start.row, start.col, size, occupied, rng, allowed)
      : null;
    const path = motifPath || growPath(start.row, start.col, size, occupied, rng, allowed, lengthRange, 0.84);
    if (path.length < lengthRange.min || !canPlacePath(path, occupied, size, allowed)) continue;

    const oriented = orientPathForPlacement(path, occupied, size);
    if (!oriented) continue;
    reservePath(oriented);
  }

  fillRemainingGaps();

  return { size, arrows, targetCount: maxTracks, fillTarget: desiredFill, precheckedSolvable: isSolvable(arrows, size) };
}

function generateLevel(levelNumber) {
  const densityScale = Math.min(1, 0.78 + levelNumber * 0.008);
  let bestLayout = null;

  for (let salt = 0; salt < 10; salt += 1) {
    const layout = buildLevelLayout(levelNumber, salt, densityScale);
    if (!bestLayout || layout.arrows.length > bestLayout.arrows.length) bestLayout = layout;
    if (layout.precheckedSolvable && layout.arrows.length >= Math.floor(layout.targetCount * 0.6)) {
      return { size: layout.size, arrows: layout.arrows };
    }
  }

  if (bestLayout && orientArrowsForSolvability(bestLayout.arrows, bestLayout.size) && isSolvable(bestLayout.arrows, bestLayout.size)) {
    return { size: bestLayout.size, arrows: bestLayout.arrows };
  }

  const fallback = buildLevelLayout(levelNumber, 999, Math.max(0.48, densityScale * 0.75));
  orientArrowsForSolvability(fallback.arrows, fallback.size);
  return { size: fallback.size, arrows: fallback.arrows };
}

function storageKeyForMode(mode) {
  return mode === MODE_YARN ? YARN_STORAGE_KEY : STORAGE_KEY;
}

function readSavedMode() {
  try {
    return window.localStorage.getItem(MODE_STORAGE_KEY) === MODE_YARN ? MODE_YARN : MODE_ARROWS;
  } catch {
    return MODE_ARROWS;
  }
}

function saveMode(mode) {
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // Storage can be unavailable in private browsing; the game still works.
  }
}

function readSavedLevel(mode = state.mode) {
  try {
    const saved = Number(window.localStorage.getItem(storageKeyForMode(mode)));
    return Number.isFinite(saved) ? Math.max(1, Math.floor(saved)) : 1;
  } catch {
    return 1;
  }
}

function saveLevelProgress(levelNumber, mode = state.mode) {
  try {
    window.localStorage.setItem(storageKeyForMode(mode), String(levelNumber));
  } catch {
    // Storage can be unavailable in private browsing; the game still works.
  }
}

function loadLevel(levelNumber) {
  if (state.mode === MODE_YARN) {
    loadYarnLevel(levelNumber);
    return;
  }
  loadArrowLevel(levelNumber);
}

function loadArrowLevel(levelNumber) {
  const nextLevel = Math.max(1, Math.floor(Number(levelNumber) || 1));
  const level = generateLevel(nextLevel);
  state.mode = MODE_ARROWS;
  state.runId += 1;
  state.level = nextLevel;
  state.size = level.size;
  state.arrows = level.arrows;
  state.yarn = null;
  state.history = [];
  state.isAnimating = false;
  state.activeAnimations = 0;
  state.completed = false;
  saveMode(MODE_ARROWS);
  saveLevelProgress(nextLevel, MODE_ARROWS);
  resetView();
  render();
}

function isYarnLevelComplete(yarn) {
  return yarn.cells.every((color) => !color);
}

function buildYarnLevel(levelNumber) {
  const rng = createRng(42533 + levelNumber * 977);
  const colorCount = Math.min(7, 4 + Math.floor((levelNumber - 1) / 5));
  const colors = YARN_COLORS.slice(0, colorCount);
  const pieceCount = 34 + Math.min(24, Math.floor(levelNumber / 2));
  const cells = [];
  const pieces = [];
  const targets = new Map(colors.map((color) => [color, 0]));

  for (let index = 0; index < pieceCount; index += 1) {
    const color = colors[Math.floor((index * 1.7 + rng() * colors.length) % colors.length)];
    cells.push(color);
    pieces.push(yarnPieceLayout(index, pieceCount, levelNumber));
    targets.set(color, targets.get(color) + 1);
  }

  return {
    rows: 1,
    cols: 1,
    colors,
    cells,
    pieces,
    hits: [],
    targets: Object.fromEntries(targets),
    collected: Object.fromEntries(colors.map((color) => [color, 0])),
    activeColor: null
  };
}

function yarnPieceLayout(position, count, levelNumber) {
  const motif = (levelNumber - 1) % 4;
  const golden = position * 2.39996323;
  const spread = Math.sqrt((position + 0.5) / Math.max(1, count));

  if (motif === 0) {
    const trunk = position > count * 0.7;
    return {
      x: trunk ? 450 + ((position % 5) - 2) * 24 : 450 + Math.cos(golden) * spread * 275,
      y: trunk ? 585 + ((position - Math.floor(count * 0.7)) % 9) * 22 : 405 + Math.sin(golden) * spread * 215,
      r: trunk ? 34 : 43 + (position % 4) * 4,
      tilt: (position % 7 - 3) * 0.18,
      depth: position
    };
  }

  if (motif === 1) {
    const petal = position % 10;
    const angle = (petal / 10) * Math.PI * 2;
    const ring = 145 + Math.floor(position / 10) * 26;
    return {
      x: 450 + Math.cos(angle) * ring,
      y: 455 + Math.sin(angle) * ring * 0.78,
      r: petal === 0 ? 52 : 40 + (position % 3) * 4,
      tilt: angle,
      depth: position
    };
  }

  if (motif === 2) {
    const row = Math.floor(position / 7);
    const col = position % 7;
    const width = Math.max(3, 7 - Math.floor(row / 2));
    return {
      x: 450 + (col - width / 2) * 56 + (row % 2) * 24,
      y: 260 + row * 48,
      r: 39 + (row % 3) * 4,
      tilt: (col - 3) * 0.18,
      depth: position
    };
  }

  const row = Math.floor(position / 8);
  const col = position % 8;
  return {
    x: 190 + col * 78 + Math.sin(row + col) * 18,
    y: 245 + row * 54,
    r: 36 + ((row + col) % 4) * 4,
    tilt: ((row * 3 + col) % 9 - 4) * 0.16,
    depth: position
  };
}

function loadYarnLevel(levelNumber) {
  const nextLevel = Math.max(1, Math.floor(Number(levelNumber) || 1));
  state.mode = MODE_YARN;
  state.runId += 1;
  state.level = nextLevel;
  state.arrows = [];
  state.yarn = buildYarnLevel(nextLevel);
  state.history = [];
  state.isAnimating = false;
  state.activeAnimations = 0;
  state.completed = isYarnLevelComplete(state.yarn);
  saveMode(MODE_YARN);
  saveLevelProgress(nextLevel, MODE_YARN);
  resetView();
  render();
}

function switchMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  saveMode(mode);
  loadLevel(readSavedLevel(mode));
}

function recordYarnHistory() {
  state.history.push({
    cells: [...state.yarn.cells],
    collected: { ...state.yarn.collected },
    activeColor: state.yarn.activeColor
  });
}

function collectWoolGroup(index) {
  const color = state.yarn.cells[index];
  if (!color) return false;
  recordYarnHistory();
  state.yarn.cells[index] = null;
  state.yarn.collected[color] += 1;
  state.yarn.activeColor = color;
  state.completed = isYarnLevelComplete(state.yarn);
  render();
  return true;
}

function onWoolCellTap(index) {
  if (state.completed || !state.yarn) return;
  collectWoolGroup(index);
}

function undoYarn() {
  const snapshot = state.history.pop();
  if (!snapshot || !state.yarn) return;
  state.yarn.cells = [...snapshot.cells];
  state.yarn.collected = { ...snapshot.collected };
  state.yarn.activeColor = snapshot.activeColor;
  state.completed = isYarnLevelComplete(state.yarn);
  render();
}

function activeArrows() {
  return state.arrows.filter((arrow) => !arrow.removed && !arrow.exiting);
}

function getOccupied(exceptId = "") {
  const occupied = new Set();
  state.arrows.forEach((arrow) => {
    if (arrow.removed || arrow.exiting || arrow.id === exceptId) return;
    arrow.path.forEach((cell) => occupied.add(keyOf(cell.row, cell.col)));
  });
  return occupied;
}

function tipOf(arrow) {
  return arrow.path[arrow.path.length - 1];
}

function canEscape(arrow) {
  const vector = DIRECTIONS[arrow.dir];
  const occupied = getOccupied(arrow.id);
  const tip = tipOf(arrow);
  let row = tip.row + vector.dr;
  let col = tip.col + vector.dc;

  while (isInside(row, col, state.size)) {
    if (occupied.has(keyOf(row, col))) {
      return false;
    }
    row += vector.dr;
    col += vector.dc;
  }

  return true;
}

function blockingDistance(arrow) {
  const vector = DIRECTIONS[arrow.dir];
  const occupied = getOccupied(arrow.id);
  const tip = tipOf(arrow);
  let row = tip.row + vector.dr;
  let col = tip.col + vector.dc;
  let distance = 1;

  while (isInside(row, col, state.size)) {
    if (occupied.has(keyOf(row, col))) return distance;
    row += vector.dr;
    col += vector.dc;
    distance += 1;
  }

  return 0;
}

function recordHistory() {
  state.history.push({
    arrows: state.arrows.map((arrow) => ({
      ...arrow,
      path: arrow.path.map((cell) => ({ ...cell })),
      groupEl: null,
      hitEl: null,
      lineEl: null,
      headEl: null,
      blocked: false,
      exiting: false,
      animating: false,
      runId: state.runId
    }))
  });
}

function updateHud() {
  const isYarn = state.mode === MODE_YARN;
  const total = isYarn ? state.yarn.colors.length : state.arrows.length;
  const cleared = isYarn
    ? state.yarn.colors.filter((color) => state.yarn.collected[color] >= state.yarn.targets[color]).length
    : state.arrows.filter((arrow) => arrow.removed || arrow.exiting).length;
  levelLabelEl.textContent = `${isYarn ? "YARN" : "LEVEL"} ${state.level}`;
  clearedTextEl.textContent = `${cleared}/${total}`;
  statusOverlayEl.hidden = !state.completed;
  prevLevelBtn.disabled = state.level <= 1;
  nextLevelBtn.disabled = false;
  topNextLevelBtn.disabled = false;
  undoBtn.disabled = !state.history.length || state.isAnimating;
  arrowModeBtn.classList.toggle("active", !isYarn);
  yarnModeBtn.classList.toggle("active", isYarn);
}

function beginArrowAnimation(arrow) {
  if (arrow.animating || arrow.removed) return false;
  arrow.animating = true;
  arrow.runId = state.runId;
  state.activeAnimations += 1;
  state.isAnimating = state.activeAnimations > 0;
  updateHud();
  return true;
}

function finishArrowAnimation(arrow) {
  if (arrow.runId !== state.runId) return;
  if (arrow.animating) {
    arrow.animating = false;
    state.activeAnimations = Math.max(0, state.activeAnimations - 1);
  }
  state.isAnimating = state.activeAnimations > 0;
  state.completed = activeArrows().length === 0 && state.activeAnimations === 0;
  updateHud();
}

function nextFrame(callback) {
  if (window.requestAnimationFrame) {
    window.requestAnimationFrame(callback);
    return;
  }
  window.setTimeout(() => callback(performance.now()), 16);
}

function easeInOut(progress) {
  return progress < 0.5
    ? 2 * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 2) / 2;
}

function easeOut(progress) {
  return 1 - Math.pow(1 - progress, 3);
}

function sameCell(a, b) {
  return Math.abs(a.row - b.row) < 0.001 && Math.abs(a.col - b.col) < 0.001;
}

function isForwardStep(fromPath, toPath) {
  return fromPath.slice(1).every((cell, index) => sameCell(cell, toPath[index]));
}

function isBackwardStep(fromPath, toPath) {
  return toPath.slice(1).every((cell, index) => sameCell(cell, fromPath[index]));
}

function distanceBetween(a, b) {
  return Math.hypot(a.row - b.row, a.col - b.col);
}

function samplePathAt(route, distance) {
  let remaining = distance;
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index];
    const end = route[index + 1];
    const segmentLength = distanceBetween(start, end) || 1;
    if (remaining <= segmentLength) {
      const amount = remaining / segmentLength;
      return {
        row: start.row + (end.row - start.row) * amount,
        col: start.col + (end.col - start.col) * amount
      };
    }
    remaining -= segmentLength;
  }

  return { ...route[route.length - 1] };
}

function sampleSnakePath(route, offset, count) {
  const sampled = [];
  for (let index = 0; index < count; index += 1) {
    sampled.push(samplePathAt(route, offset + index));
  }
  return sampled;
}

function onArrowTap(id) {
  if (performance.now() < state.view.suppressClickUntil) return;
  if (state.completed) return;
  const arrow = state.arrows.find((item) => item.id === id);
  if (!arrow || arrow.removed || arrow.exiting || arrow.animating) return;

  if (!canEscape(arrow)) {
    bounceBlockedArrow(arrow);
    return;
  }

  recordHistory();
  slideArrowOut(arrow);
}

function bounceBlockedArrow(arrow) {
  if (!beginArrowAnimation(arrow)) return;
  const vector = DIRECTIONS[arrow.dir];
  const distance = blockingDistance(arrow);
  const originalPath = arrow.path.map((cell) => ({ ...cell }));
  const steps = Math.max(1, distance);
  const pathStack = [originalPath];
  arrow.blocked = true;
  updateArrowClass(arrow);

  crawlBlockedForward(arrow, vector, steps, 0, pathStack);
}

function crawlBlockedForward(arrow, vector, maxSteps, completedSteps, pathStack) {
  if (arrow.runId !== state.runId) return;
  if (completedSteps >= maxSteps) {
    window.setTimeout(() => crawlBlockedBack(arrow, pathStack), 70);
    return;
  }

  const fromPath = arrow.path.map((cell) => ({ ...cell }));
  const tip = fromPath[fromPath.length - 1];
  const nextHead = { row: tip.row + vector.dr, col: tip.col + vector.dc };
  const toPath = fromPath.slice(1).concat(nextHead);
  animatePathBetween(arrow, fromPath, toPath, 50, () => {
    arrow.path = toPath.map((cell) => ({ ...cell }));
    pathStack.push(arrow.path.map((cell) => ({ ...cell })));
    crawlBlockedForward(arrow, vector, maxSteps, completedSteps + 1, pathStack);
  });
}

function crawlBlockedBack(arrow, pathStack) {
  if (arrow.runId !== state.runId) return;
  if (pathStack.length <= 1) {
    arrow.path = pathStack[0].map((cell) => ({ ...cell }));
    updateArrowPath(arrow);
    arrow.blocked = false;
    updateArrowClass(arrow);
    finishArrowAnimation(arrow);
    return;
  }

  const fromPath = pathStack.pop().map((cell) => ({ ...cell }));
  const toPath = pathStack[pathStack.length - 1].map((cell) => ({ ...cell }));
  animatePathBetween(arrow, fromPath, toPath, 46, () => {
    arrow.path = toPath.map((cell) => ({ ...cell }));
    crawlBlockedBack(arrow, pathStack);
  });
}

function slideArrowOut(arrow) {
  if (arrow.runId && arrow.runId !== state.runId) return;
  if (!arrow.exiting && !beginArrowAnimation(arrow)) return;
  const vector = DIRECTIONS[arrow.dir];
  const fromPath = arrow.path.map((cell) => ({ ...cell }));
  const tip = fromPath[fromPath.length - 1];
  const nextHead = { row: tip.row + vector.dr, col: tip.col + vector.dc };
  const toPath = fromPath.slice(1).concat(nextHead);
  arrow.exiting = true;
  updateArrowClass(arrow);
  updateHud();

  animatePathBetween(arrow, fromPath, toPath, 58, () => {
    arrow.path = toPath;
    const stillVisible = arrow.path.some((cell) => isInside(cell.row, cell.col, state.size));
    if (!stillVisible) {
      arrow.removed = true;
      if (arrow.groupEl) arrow.groupEl.remove();
      finishArrowAnimation(arrow);
      return;
    }

    nextFrame(() => slideArrowOut(arrow));
  });
}

function animatePathBetween(arrow, fromPath, toPath, duration, onDone) {
  const startedAt = performance.now();
  const runId = arrow.runId;
  const forward = isForwardStep(fromPath, toPath);
  const backward = isBackwardStep(fromPath, toPath);
  const route = forward
    ? fromPath.concat(toPath[toPath.length - 1])
    : toPath.concat(fromPath[fromPath.length - 1]);

  function step(now) {
    if (runId !== state.runId) return;
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = easeInOut(progress);
    if (forward) {
      arrow.path = sampleSnakePath(route, eased, fromPath.length);
    } else if (backward) {
      arrow.path = sampleSnakePath(route, 1 - eased, fromPath.length);
    } else {
      arrow.path = fromPath.map((cell, index) => ({
        row: cell.row + (toPath[index].row - cell.row) * eased,
        col: cell.col + (toPath[index].col - cell.col) * eased
      }));
    }
    updateArrowPath(arrow);

    if (progress < 1) {
      nextFrame(step);
      return;
    }

    onDone();
  }
  nextFrame(step);
}

function undoArrows() {
  const snapshot = state.history.pop();
  if (!snapshot || state.isAnimating) return;
  state.arrows = snapshot.arrows.map((arrow) => ({
    ...arrow,
    path: arrow.path.map((cell) => ({ ...cell })),
    groupEl: null,
    hitEl: null,
    lineEl: null,
    headEl: null
  }));
  render();
}

function undo() {
  if (state.mode === MODE_YARN) {
    undoYarn();
    return;
  }
  undoArrows();
}

function resetView() {
  state.view.scale = 1;
  state.view.x = 0;
  state.view.y = 0;
  state.view.pointers.clear();
  state.view.lastPinchDistance = 0;
  state.view.isDragging = false;
  state.view.dragged = false;
  applyBoardTransform();
}

function clampView() {
  const rect = boardFrameEl.getBoundingClientRect();
  const scale = state.view.scale;
  if (scale <= 1) {
    state.view.scale = 1;
    state.view.x = 0;
    state.view.y = 0;
    return;
  }

  state.view.x = Math.min(0, Math.max(rect.width - rect.width * scale, state.view.x));
  state.view.y = Math.min(0, Math.max(rect.height - rect.height * scale, state.view.y));
}

function applyBoardTransform() {
  if (!boardEl) return;
  boardEl.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.scale})`;
}

function zoomAt(clientX, clientY, nextScale) {
  const rect = boardFrameEl.getBoundingClientRect();
  const oldScale = state.view.scale;
  const scale = Math.min(5.5, Math.max(1, nextScale));
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  const contentX = (localX - state.view.x) / oldScale;
  const contentY = (localY - state.view.y) / oldScale;

  state.view.scale = scale;
  state.view.x = localX - contentX * scale;
  state.view.y = localY - contentY * scale;
  clampView();
  applyBoardTransform();
}

function pointerDistance(first, second) {
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

function pointerCenter(first, second) {
  return {
    x: (first.clientX + second.clientX) / 2,
    y: (first.clientY + second.clientY) / 2
  };
}

function arrowClassName(arrow) {
  return ["arrow-piece", arrow.blocked ? "blocked" : "", arrow.exiting ? "exiting" : ""].filter(Boolean).join(" ");
}

function updateArrowClass(arrow) {
  if (arrow.groupEl) arrow.groupEl.setAttribute("class", arrowClassName(arrow));
}

function updateArrowPath(arrow) {
  if (!arrow.lineEl || !arrow.headEl) return;
  if (arrow.hitEl) arrow.hitEl.setAttribute("d", bodyPathToD(arrow.path));
  arrow.lineEl.setAttribute("d", bodyPathToD(arrow.path));
  arrow.headEl.setAttribute("d", arrowHeadToD(arrow.path));
}

function renderDefs(svg) {
  svg.appendChild(makeSvgElement("defs"));
}

function renderArrow(svg, arrow) {
  const group = makeSvgElement("g", {
    class: arrowClassName(arrow),
    "data-id": arrow.id
  });
  group.style.color = arrow.color;
  const hit = makeSvgElement("path", {
    class: "arrow-hit",
    d: bodyPathToD(arrow.path)
  });
  const line = makeSvgElement("path", {
    class: "arrow-line",
    d: bodyPathToD(arrow.path),
    stroke: arrow.color
  });
  const head = makeSvgElement("path", {
    class: "arrow-head",
    d: arrowHeadToD(arrow.path),
    fill: arrow.color
  });
  group.appendChild(hit);
  group.appendChild(line);
  group.appendChild(head);
  group.addEventListener("pointerup", (event) => {
    if (event.pointerType !== "mouse" || event.button === 0) {
      onArrowTap(arrow.id);
    }
  });
  arrow.groupEl = group;
  arrow.hitEl = hit;
  arrow.lineEl = line;
  arrow.headEl = head;
  svg.appendChild(group);
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const value = parseInt(clean.length === 3
    ? clean.split("").map((char) => char + char).join("")
    : clean, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255
  };
}

function rgbString(rgb) {
  return `rgb(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)})`;
}

function mixColor(hex, amount) {
  const rgb = hexToRgb(hex);
  const target = amount >= 0 ? 255 : 0;
  const weight = Math.abs(amount);
  return rgbString({
    r: rgb.r + (target - rgb.r) * weight,
    g: rgb.g + (target - rgb.g) * weight,
    b: rgb.b + (target - rgb.b) * weight
  });
}

function drawRoundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawYarnBox(ctx, x, y, width, height, color, collected, target) {
  ctx.save();
  ctx.shadowColor = "rgba(56, 67, 93, 0.25)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 8;
  drawRoundRect(ctx, x, y, width, height, 18);
  ctx.fillStyle = "rgba(247, 253, 255, 0.96)";
  ctx.fill();
  ctx.lineWidth = 9;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.shadowColor = "transparent";

  drawRoundRect(ctx, x + width * 0.38, y - 13, width * 0.24, 16, 5);
  ctx.fillStyle = "#bb7437";
  ctx.fill();

  const fillRatio = collected / Math.max(1, target);
  for (let index = 0; index < 4; index += 1) {
    const cx = x + width * (0.35 + (index % 2) * 0.3);
    const cy = y + height * (0.38 + Math.floor(index / 2) * 0.32);
    const filled = fillRatio > index / 4;
    const hole = ctx.createRadialGradient(cx - 5, cy - 6, 2, cx, cy, 17);
    hole.addColorStop(0, "#ffffff");
    hole.addColorStop(0.45, filled ? mixColor(color, 0.28) : "#d7e6ef");
    hole.addColorStop(1, filled ? mixColor(color, -0.2) : "#8299a8");
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.fillStyle = hole;
    ctx.fill();
  }

  ctx.fillStyle = "#526077";
  ctx.font = "900 18px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`${collected}/${target}`, x + width / 2, y + height + 22);
  ctx.restore();
}

function drawPeg(ctx, x, y, radius) {
  const gradient = ctx.createRadialGradient(x - radius * 0.35, y - radius * 0.35, 2, x, y, radius);
  gradient.addColorStop(0, "#ffffff");
  gradient.addColorStop(0.45, "#dceaf1");
  gradient.addColorStop(1, "#879eac");
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.shadowColor = "rgba(76, 91, 116, 0.18)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 4;
  ctx.fill();
  ctx.shadowColor = "transparent";
}

function drawYarnBall(ctx, piece, color, active) {
  ctx.save();
  ctx.translate(piece.x, piece.y);
  ctx.rotate(piece.tilt);
  ctx.scale(1.08, 0.9);

  const r = piece.r * (active ? 1.08 : 1);
  ctx.shadowColor = "rgba(42, 46, 72, 0.25)";
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 10;

  const gradient = ctx.createRadialGradient(-r * 0.35, -r * 0.38, 4, 0, 0, r);
  gradient.addColorStop(0, mixColor(color, 0.55));
  gradient.addColorStop(0.34, color);
  gradient.addColorStop(1, mixColor(color, -0.32));
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.shadowColor = "transparent";

  ctx.lineWidth = Math.max(3, r * 0.09);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
  for (let offset = -r * 0.72; offset <= r * 0.72; offset += r * 0.34) {
    ctx.beginPath();
    ctx.ellipse(offset, 0, r * 0.25, r * 0.88, 0.9, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(0, 0, 0, 0.16)";
  ctx.lineWidth = Math.max(2, r * 0.055);
  for (let offset = -r * 0.66; offset <= r * 0.66; offset += r * 0.38) {
    ctx.beginPath();
    ctx.ellipse(offset, 0, r * 0.22, r * 0.78, -0.9, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (active) {
    ctx.beginPath();
    ctx.arc(0, 0, r + 5, 0, Math.PI * 2);
    ctx.lineWidth = 5;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.stroke();
  }

  ctx.restore();
}

function drawYarnScene(canvas) {
  const ctx = canvas.getContext("2d");
  const logicalSize = 900;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(canvas.width / logicalSize, 0, 0, canvas.height / logicalSize, 0, 0);
  state.yarn.hits = [];

  const bg = ctx.createLinearGradient(0, 0, logicalSize, logicalSize);
  bg.addColorStop(0, "#bcefff");
  bg.addColorStop(0.44, "#ffe4fa");
  bg.addColorStop(1, "#fff1bd");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, logicalSize, logicalSize);

  for (let sparkle = 0; sparkle < 18; sparkle += 1) {
    const x = 80 + ((sparkle * 151) % 740);
    const y = 165 + ((sparkle * 97) % 620);
    ctx.fillStyle = "rgba(255, 255, 255, 0.68)";
    ctx.beginPath();
    ctx.moveTo(x, y - 9);
    ctx.lineTo(x + 4, y);
    ctx.lineTo(x, y + 9);
    ctx.lineTo(x - 4, y);
    ctx.closePath();
    ctx.fill();
  }

  const boxWidth = Math.min(116, 680 / state.yarn.colors.length);
  const gap = 14;
  const totalWidth = state.yarn.colors.length * boxWidth + (state.yarn.colors.length - 1) * gap;
  let x = (logicalSize - totalWidth) / 2;
  state.yarn.colors.forEach((color) => {
    drawYarnBox(ctx, x, 55, boxWidth, 78, color, state.yarn.collected[color], state.yarn.targets[color] || 1);
    x += boxWidth + gap;
  });

  for (let index = 0; index < 5; index += 1) {
    drawPeg(ctx, 330 + index * 60, 183, 17);
  }

  ctx.save();
  ctx.fillStyle = "rgba(80, 68, 94, 0.16)";
  ctx.beginPath();
  ctx.ellipse(450, 750, 260, 60, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const visible = state.yarn.cells
    .map((color, index) => ({ color, index, piece: state.yarn.pieces[index] }))
    .filter((item) => item.color && item.piece)
    .sort((a, b) => a.piece.depth - b.piece.depth);

  visible.forEach((item) => {
    drawYarnBall(ctx, item.piece, item.color, item.color === state.yarn.activeColor);
    state.yarn.hits.push({
      index: item.index,
      x: item.piece.x,
      y: item.piece.y,
      r: item.piece.r * 1.25
    });
  });
}

function onYarnCanvasTap(canvas, event) {
  if (state.completed || !state.yarn) return;
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * 900;
  const y = ((event.clientY - rect.top) / rect.height) * 900;
  const hit = [...state.yarn.hits].reverse().find((zone) => Math.hypot(x - zone.x, y - zone.y) <= zone.r);
  if (!hit) return;
  collectWoolGroup(hit.index);
}

function renderYarn() {
  boardFrameEl.classList.add("yarn-mode");
  boardFrameEl.style.removeProperty("--dot-step");

  const yarnCanvas = document.createElement("canvas");
  yarnCanvas.className = "yarn-canvas";
  yarnCanvas.setAttribute("aria-label", "Yarn sorting puzzle");
  yarnCanvas.addEventListener("pointerup", (event) => {
    event.preventDefault();
    onYarnCanvasTap(yarnCanvas, event);
  });

  boardEl.replaceChildren(yarnCanvas);
  boardEl.style.transform = "";
  nextFrame(() => drawYarnScene(yarnCanvas));
  updateHud();
}

function renderArrows() {
  const total = state.arrows.length;
  const cleared = state.arrows.filter((arrow) => arrow.removed).length;
  const dotStep = `${100 / state.size}%`;
  const edgePadding = 1.35;
  const svg = makeSvgElement("svg", {
    viewBox: `${-edgePadding} ${-edgePadding} ${state.size + edgePadding * 2} ${state.size + edgePadding * 2}`,
    class: "board-svg",
    role: "img",
    "aria-label": `Level ${state.level} arrow puzzle`
  });

  boardFrameEl.classList.remove("yarn-mode");
  renderDefs(svg);
  state.arrows.filter((arrow) => !arrow.removed).forEach((arrow) => renderArrow(svg, arrow));

  boardFrameEl.style.setProperty("--dot-step", dotStep);
  boardEl.replaceChildren(svg);
  applyBoardTransform();
  updateHud();
}

function render() {
  if (state.mode === MODE_YARN) {
    renderYarn();
    return;
  }
  renderArrows();
}

prevLevelBtn.addEventListener("click", () => loadLevel(Math.max(1, state.level - 1)));
nextLevelBtn.addEventListener("click", () => loadLevel(state.level + 1));
topNextLevelBtn.addEventListener("click", () => loadLevel(state.level + 1));
arrowModeBtn.addEventListener("click", () => switchMode(MODE_ARROWS));
yarnModeBtn.addEventListener("click", () => switchMode(MODE_YARN));
undoBtn.addEventListener("click", undo);

boardFrameEl.addEventListener("wheel", (event) => {
  if (state.mode !== MODE_ARROWS) return;
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1.14 : 0.88;
  zoomAt(event.clientX, event.clientY, state.view.scale * factor);
}, { passive: false });

["gesturestart", "gesturechange", "gestureend"].forEach((eventName) => {
  document.addEventListener(eventName, (event) => event.preventDefault(), { passive: false });
});

let lastTouchEndAt = 0;

document.addEventListener("touchend", (event) => {
  if (!event.target.closest(".board-frame")) return;
  const now = Date.now();
  if (now - lastTouchEndAt < 450) {
    event.preventDefault();
  }
  lastTouchEndAt = now;
}, { passive: false, capture: true });

document.addEventListener("dblclick", (event) => {
  event.preventDefault();
}, { passive: false, capture: true });

boardFrameEl.addEventListener("pointerdown", (event) => {
  if (state.mode !== MODE_ARROWS) return;
  if (event.button !== undefined && event.button !== 0) return;
  state.view.pointers.set(event.pointerId, {
    clientX: event.clientX,
    clientY: event.clientY
  });
  state.view.isDragging = state.view.pointers.size === 1;
  state.view.dragged = false;
  state.view.lastX = event.clientX;
  state.view.lastY = event.clientY;

  if (state.view.pointers.size === 2) {
    boardFrameEl.setPointerCapture(event.pointerId);
    const pointers = [...state.view.pointers.values()];
    state.view.lastPinchDistance = pointerDistance(pointers[0], pointers[1]);
  }
});

boardFrameEl.addEventListener("pointermove", (event) => {
  if (state.mode !== MODE_ARROWS) return;
  if (!state.view.pointers.has(event.pointerId)) return;
  const previous = state.view.pointers.get(event.pointerId);
  state.view.pointers.set(event.pointerId, {
    clientX: event.clientX,
    clientY: event.clientY
  });

  if (state.view.pointers.size >= 2) {
    event.preventDefault();
    const pointers = [...state.view.pointers.values()];
    const distance = pointerDistance(pointers[0], pointers[1]);
    const center = pointerCenter(pointers[0], pointers[1]);
    if (state.view.lastPinchDistance > 0) {
      zoomAt(center.x, center.y, state.view.scale * (distance / state.view.lastPinchDistance));
    }
    state.view.lastPinchDistance = distance;
    state.view.dragged = true;
    state.view.suppressClickUntil = performance.now() + 180;
    return;
  }

  const dx = event.clientX - previous.clientX;
  const dy = event.clientY - previous.clientY;
  if (state.view.scale > 1 && Math.hypot(dx, dy) > 0) {
    event.preventDefault();
    if (boardFrameEl.hasPointerCapture && !boardFrameEl.hasPointerCapture(event.pointerId)) {
      boardFrameEl.setPointerCapture(event.pointerId);
    }
    state.view.x += dx;
    state.view.y += dy;
    clampView();
    applyBoardTransform();
    state.view.dragged = true;
    state.view.suppressClickUntil = performance.now() + 180;
  }
});

function releaseBoardPointer(event) {
  if (state.mode !== MODE_ARROWS) return;
  if (state.view.dragged) {
    state.view.suppressClickUntil = performance.now() + 220;
  }
  state.view.pointers.delete(event.pointerId);
  state.view.lastPinchDistance = 0;
  state.view.isDragging = state.view.pointers.size > 0;
}

boardFrameEl.addEventListener("pointerup", releaseBoardPointer);
boardFrameEl.addEventListener("pointercancel", releaseBoardPointer);

window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "z") undo();
  if (event.key === "0") {
    resetView();
  }
});

state.mode = readSavedMode();
loadLevel(readSavedLevel(state.mode));
