const DIRECTIONS = {
  up: { dr: -1, dc: 0 },
  right: { dr: 0, dc: 1 },
  down: { dr: 1, dc: 0 },
  left: { dr: 0, dc: -1 }
};

const COLORS = ["#8b5cf6", "#f5b83d", "#3f83f8", "#f97316", "#22c55e", "#ec4899", "#14b8a6"];
const SHAPES = ["maze"];
const SVG_NS = "http://www.w3.org/2000/svg";

const boardEl = document.querySelector("#board");
const boardFrameEl = document.querySelector(".board-frame");
const statusOverlayEl = document.querySelector("#statusOverlay");
const levelLabelEl = document.querySelector("#levelLabel");
const clearedTextEl = document.querySelector("#clearedText");
const prevLevelBtn = document.querySelector("#prevLevel");
const nextLevelBtn = document.querySelector("#nextLevel");
const resetBtn = document.querySelector("#resetBtn");
const undoBtn = document.querySelector("#undoBtn");

const state = {
  level: 1,
  size: 10,
  arrows: [],
  history: [],
  isAnimating: false,
  activeAnimations: 0,
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
  points[points.length - 1] = pointToward(tip, before, 0.36);
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
  const headLength = 0.66;
  const headWidth = 0.34;
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
  const axis = rng() < 0.72 ? "horizontal" : "vertical";
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
    groupEl: null,
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
  const size = Math.min(56, 46 + Math.floor(levelNumber / 16));
  const shape = SHAPES[(levelNumber - 1) % SHAPES.length];
  const { cells: allowedCells, allowed } = shapeCells(size, shape);
  const occupied = new Set();
  const arrows = [];
  const desiredFill = Math.floor(allowedCells.length * 0.94 * densityScale);
  const maxTracks = Math.floor((260 + levelNumber * 0.55) * densityScale);
  let attempts = 0;

  function reservePath(path) {
    cellsForPath(path).forEach((key) => occupied.add(key));
    arrows.push(makeArrow(levelNumber, path, arrows.length));
  }

  function fillRemainingGaps() {
    for (let row = 0; row < size && occupied.size < desiredFill && arrows.length < maxTracks; row += 1) {
      let col = 0;
      while (col < size && occupied.size < desiredFill && arrows.length < maxTracks) {
        while (col < size && (!allowed.has(keyOf(row, col)) || occupied.has(keyOf(row, col)))) col += 1;
        const startCol = col;
        while (col < size && allowed.has(keyOf(row, col)) && !occupied.has(keyOf(row, col))) col += 1;
        const runLength = col - startCol;
        if (runLength < 2) continue;

        let cursor = startCol;
        while (cursor < startCol + runLength && occupied.size < desiredFill && arrows.length < maxTracks) {
          const remaining = startCol + runLength - cursor;
          const length = Math.min(remaining, 2 + Math.floor(rng() * Math.min(4, remaining)));
          if (length < 2) break;
          const path = [];
          for (let segmentCol = cursor; segmentCol < cursor + length; segmentCol += 1) {
            path.push({ row, col: segmentCol });
          }
          const oriented = (cursor + length / 2 < size / 2) ? path.reverse() : path;
          reservePath(oriented);
          cursor += length;
        }
      }
    }

    for (let col = 0; col < size && occupied.size < desiredFill && arrows.length < maxTracks; col += 1) {
      let row = 0;
      while (row < size && occupied.size < desiredFill && arrows.length < maxTracks) {
        while (row < size && (!allowed.has(keyOf(row, col)) || occupied.has(keyOf(row, col)))) row += 1;
        const startRow = row;
        while (row < size && allowed.has(keyOf(row, col)) && !occupied.has(keyOf(row, col))) row += 1;
        const runLength = row - startRow;
        if (runLength < 2) continue;

        let cursor = startRow;
        while (cursor < startRow + runLength && occupied.size < desiredFill && arrows.length < maxTracks) {
          const remaining = startRow + runLength - cursor;
          const length = Math.min(remaining, 2 + Math.floor(rng() * Math.min(4, remaining)));
          if (length < 2) break;
          const path = [];
          for (let segmentRow = cursor; segmentRow < cursor + length; segmentRow += 1) {
            path.push({ row: segmentRow, col });
          }
          const oriented = (cursor + length / 2 < size / 2) ? path.reverse() : path;
          reservePath(oriented);
          cursor += length;
        }
      }
    }
  }

  while (occupied.size < desiredFill && arrows.length < maxTracks && attempts < 26000) {
    attempts += 1;
    const start = allowedCells[Math.floor(rng() * allowedCells.length)];
    if (!start || occupied.has(keyOf(start.row, start.col))) continue;

    const longTrackQuota = Math.floor(maxTracks * 0.28);
    const lengthRange = arrows.length < longTrackQuota
      ? { min: 7, max: 13 }
      : rng() < 0.55
        ? { min: 5, max: 9 }
        : { min: 4, max: 7 };
    const motifPath = rng() < 0.94
      ? buildMotifPath(start.row, start.col, size, occupied, rng, allowed)
      : null;
    const path = motifPath || growPath(start.row, start.col, size, occupied, rng, allowed, lengthRange, 0.68);
    if (path.length < lengthRange.min || !canPlacePath(path, occupied, size, allowed)) continue;

    const oriented = orientPathForPlacement(path, occupied, size)
      || orientPathForEscape(path, occupied, size);
    reservePath(oriented);
  }

  fillRemainingGaps();

  return { size, arrows, targetCount: maxTracks, fillTarget: desiredFill, precheckedSolvable: true };
}

function generateLevel(levelNumber) {
  const layout = buildLevelLayout(levelNumber, 0, 1);
  return { size: layout.size, arrows: layout.arrows };
}

function loadLevel(levelNumber) {
  const level = generateLevel(levelNumber);
  state.level = levelNumber;
  state.size = level.size;
  state.arrows = level.arrows;
  state.history = [];
  state.isAnimating = false;
  state.activeAnimations = 0;
  state.completed = false;
  resetView();
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
      lineEl: null,
      headEl: null,
      blocked: false,
      exiting: false,
      animating: false
    }))
  });
}

function updateHud() {
  const total = state.arrows.length;
  const cleared = state.arrows.filter((arrow) => arrow.removed || arrow.exiting).length;
  levelLabelEl.textContent = `LEVEL ${state.level}`;
  clearedTextEl.textContent = `${cleared}/${total}`;
  statusOverlayEl.hidden = !state.completed;
  prevLevelBtn.disabled = state.level <= 1 || state.isAnimating;
  nextLevelBtn.disabled = state.isAnimating;
  undoBtn.disabled = !state.history.length || state.isAnimating;
}

function beginArrowAnimation(arrow) {
  if (arrow.animating || arrow.removed) return false;
  arrow.animating = true;
  state.activeAnimations += 1;
  state.isAnimating = state.activeAnimations > 0;
  updateHud();
  return true;
}

function finishArrowAnimation(arrow) {
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
  const forward = isForwardStep(fromPath, toPath);
  const backward = isBackwardStep(fromPath, toPath);
  const route = forward
    ? fromPath.concat(toPath[toPath.length - 1])
    : toPath.concat(fromPath[fromPath.length - 1]);

  function step(now) {
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

function undo() {
  const snapshot = state.history.pop();
  if (!snapshot || state.isAnimating) return;
  state.arrows = snapshot.arrows.map((arrow) => ({
    ...arrow,
    path: arrow.path.map((cell) => ({ ...cell })),
    groupEl: null,
    lineEl: null,
    headEl: null
  }));
  render();
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
  group.appendChild(line);
  group.appendChild(head);
  group.addEventListener("pointerup", (event) => {
    if (event.pointerType !== "mouse" || event.button === 0) {
      onArrowTap(arrow.id);
    }
  });
  arrow.groupEl = group;
  arrow.lineEl = line;
  arrow.headEl = head;
  svg.appendChild(group);
}

function render() {
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

  renderDefs(svg);
  state.arrows.filter((arrow) => !arrow.removed).forEach((arrow) => renderArrow(svg, arrow));

  boardFrameEl.style.setProperty("--dot-step", dotStep);
  boardEl.replaceChildren(svg);
  applyBoardTransform();
  updateHud();
}

prevLevelBtn.addEventListener("click", () => loadLevel(Math.max(1, state.level - 1)));
nextLevelBtn.addEventListener("click", () => loadLevel(state.level + 1));
resetBtn.addEventListener("click", () => loadLevel(state.level));
undoBtn.addEventListener("click", undo);

boardFrameEl.addEventListener("wheel", (event) => {
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1.14 : 0.88;
  zoomAt(event.clientX, event.clientY, state.view.scale * factor);
}, { passive: false });

boardFrameEl.addEventListener("pointerdown", (event) => {
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
  if (event.key.toLowerCase() === "r") loadLevel(state.level);
  if (event.key === "0") {
    resetView();
  }
});

loadLevel(1);
