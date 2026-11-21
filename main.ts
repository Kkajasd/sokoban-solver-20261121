// Sokoban solver: one program answers a set of 5 levels, each in as few pushes as it can.
//
// Method: the levels are a hallway with independent rooms off it (a box pushed out of a
// room can never come back), so each level is split into its rooms and every room is
// solved on its own with a push-optimal search; the rooms' optima add up to the level's.
// The search is A* over pushes: a state is the boxes' squares plus the player's
// reachable region (named by its lowest square). A push costs 1; the estimate is the
// cheapest assignment of boxes to goals under the lone-box push distances, which never
// overestimates, so the first solved state popped is push-optimal. Two deadlocks are
// pruned: a box on a square from which no push can ever reach a goal (dead squares,
// found by pulling back from the goals), and a frozen 2x2 block of walls and boxes
// holding a box off its goal. Everything is budgeted by work counted, never by the
// wall clock, so two runs write the same bytes.
//
// No network, no clock reads, no randomness: the same input always gives the same output.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// [dx, dy, step letter, push letter]
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// Work budgets, counted in expanded states (deterministic; the clock is never read).
const ROOM_EXPANSION_CAP = 800000;
const GREEDY_EXPANSION_CAP = 400000;
const TOTAL_EXPANSION_CAP = 4000000;
let totalExpansions = 0;

/** A level parsed from XSB text. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals: goals.sort((a, b) => a - b), boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares from which a box alone can be pushed onto some goal (pulled back from the goals). */
function liveSquares(w, wall, goals) {
  const live = new Uint8Array(wall.length);
  const queue = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * For each goal, the fewest pushes a lone box needs from every square to that goal
 * (reverse BFS over box positions; a box at y pushed in direction d lands on y + d,
 * so the predecessors of x are the squares x - d whose push square x - 2d is open).
 * -1 where no push path exists.
 */
function pushDistances(w, wall, goals) {
  return goals.map((g) => {
    const dist = new Int32Array(wall.length).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const y = x - d;
        if (!wall[y] && !wall[y - d] && dist[y] < 0) {
          dist[y] = dist[x] + 1;
          queue.push(y);
        }
      }
    }
    return dist;
  });
}

/** The squares the player reaches from `from` with `occupied` in the way; returns the lowest reached. */
function reach(w, wall, occupied, from, seen, stamp, stack) {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(w, wall, occupied, goal, t) {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(w, wall, occupied, from, to) {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The player square after `moves` (case aside) from `from` on a board `w` wide. */
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/** All orderings of 0..n-1, for the assignment heuristic (n is at most 4 in a room). */
function permutations(n) {
  const out = [];
  const a = [];
  for (let i = 0; i < n; i++) a.push(i);
  const gen = (k) => {
    if (k === n) {
      out.push(a.slice());
      return;
    }
    for (let i = k; i < n; i++) {
      [a[k], a[i]] = [a[i], a[k]];
      gen(k + 1);
      [a[k], a[i]] = [a[i], a[k]];
    }
  };
  gen(0);
  return out;
}

/**
 * Push-optimal (mode 'astar') or greedy best-first (mode 'greedy') search over pushes
 * for one level: {pushes, moves}, or null when the budget runs out or no solution exists.
 * The A* estimate is the cheapest box-to-goal assignment under the lone-box push
 * distances: admissible and consistent, so 'astar' is push-optimal.
 */
function searchPush(level, cap, mode) {
  const { w, h, wall, goals, boxes: boxes0, player: player0 } = level;
  const size = wall.length;
  const n = boxes0.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(w, wall, goals);
  if (boxes0.some((b) => !live[b])) return null;
  const dist = pushDistances(w, wall, goals);
  const perms = n <= 4 ? permutations(n) : null;

  const heuristic = (bs) => {
    if (perms !== null) {
      let best = Infinity;
      for (const perm of perms) {
        let sum = 0;
        for (let j = 0; j < n; j++) {
          const d = dist[perm[j]][bs[j]];
          if (d < 0) {
            sum = Infinity;
            break;
          }
          sum += d;
        }
        if (sum < best) best = sum;
      }
      return best;
    }
    let sum = 0;
    for (const b of bs) {
      let m = Infinity;
      for (let g = 0; g < goals.length; g++) {
        const d = dist[g][b];
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      sum += m;
    }
    return sum;
  };

  const solved = (bs) => {
    for (const b of bs) if (!goal[b]) return false;
    return true;
  };

  // State keys: exact numeric encoding while size ** (n + 1) stays under 2 ** 53.
  const numericKey = size ** (n + 1) < 2 ** 53;
  const keyOf = (bs, low) => {
    if (numericKey) {
      let k = low;
      for (const b of bs) k = k * size + b;
      return k;
    }
    return `${low}|${bs.join(',')}`;
  };

  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const occupied = new Uint8Array(size);

  // The states: boxes, player square, parent, and the push that made them.
  const sBoxes = [boxes0.slice()];
  const sPlayer = [player0];
  const sParent = [-1];
  const sFrom = [-1];
  const sTo = [-1];
  const sDir = [-1];
  const sG = [0];
  const best = new Map();
  for (const b of boxes0) occupied[b] = 1;
  const low0 = reach(w, wall, occupied, player0, seen, ++stamp, stack);
  for (const b of boxes0) occupied[b] = 0;
  const sKey = [keyOf(boxes0, low0)];
  const h0 = heuristic(boxes0);
  if (h0 === Infinity) return null;
  best.set(sKey[0], 0);

  // Binary heap on (f asc, g desc, insertion asc). f is g + h for A*, h alone for greedy.
  const hf = [];
  const hg = [];
  const hs = [];
  const hq = [];
  let seq = 0;
  const less = (i, j) =>
    hf[i] < hf[j] || (hf[i] === hf[j] && (hg[i] > hg[j] || (hg[i] === hg[j] && hq[i] < hq[j])));
  const hpush = (f, g, s) => {
    let i = hf.length;
    hf.push(f);
    hg.push(g);
    hs.push(s);
    hq.push(seq++);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(i, p)) break;
      [hf[i], hf[p]] = [hf[p], hf[i]];
      [hg[i], hg[p]] = [hg[p], hg[i]];
      [hs[i], hs[p]] = [hs[p], hs[i]];
      [hq[i], hq[p]] = [hq[p], hq[i]];
      i = p;
    }
  };
  const hpop = () => {
    const topF = hf[0];
    const topG = hg[0];
    const topS = hs[0];
    const lastF = hf.pop();
    const lastG = hg.pop();
    const lastS = hs.pop();
    const lastQ = hq.pop();
    if (hf.length > 0) {
      hf[0] = lastF;
      hg[0] = lastG;
      hs[0] = lastS;
      hq[0] = lastQ;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= hf.length) break;
        if (c + 1 < hf.length && less(c + 1, c)) c++;
        if (!less(c, i)) break;
        [hf[i], hf[c]] = [hf[c], hf[i]];
        [hg[i], hg[c]] = [hg[c], hg[i]];
        [hs[i], hs[c]] = [hs[c], hs[i]];
        [hq[i], hq[c]] = [hq[c], hq[i]];
        i = c;
      }
    }
    return [topF, topG, topS];
  };

  hpush(h0, 0, 0);
  let expanded = 0;
  let found = -1;
  while (hf.length > 0) {
    const [, g, s] = hpop();
    const bs = sBoxes[s];
    // Stale heap entry (a better path to this state was found since): skip.
    if (best.get(sKey[s]) !== g) continue;
    if (solved(bs)) {
      found = s;
      break;
    }
    if (expanded >= cap || totalExpansions >= TOTAL_EXPANSION_CAP) return null;
    expanded++;
    totalExpansions++;
    for (const b of bs) occupied[b] = 1;
    const here = ++stamp;
    reach(w, wall, occupied, sPlayer[s], seen, here, stack);
    for (let bi = 0; bi < n; bi++) {
      const b = bs[bi];
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[k];
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(w, wall, occupied, goal, t);
        let next = null;
        let key = -1;
        if (!frozen) {
          next = bs.slice();
          next[bi] = t;
          next.sort((a, b2) => a - b2);
          const low = reach(w, wall, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, low);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen) continue;
        const g2 = g + 1;
        const prev = best.get(key);
        if (prev !== undefined && prev <= g2) continue;
        const h2 = heuristic(next);
        if (h2 === Infinity) continue;
        best.set(key, g2);
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(s);
        sFrom.push(b);
        sTo.push(t);
        sDir.push(k);
        sG.push(g2);
        sKey.push(key);
        hpush(mode === 'astar' ? g2 + h2 : h2, g2, sBoxes.length - 1);
      }
    }
    for (const b of bs) occupied[b] = 0;
  }
  if (found < 0) return null;

  // Rebuild the moves: walk to each push square, then push.
  const path = [];
  for (let s = found; s > 0; s = sParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = player0;
  let boxes = boxes0.slice();
  for (const s of path) {
    const from = sFrom[s];
    const k = sDir[s];
    const [dx, dy, , pushLetter] = DIRS[k];
    const d = dy * w + dx;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += pushLetter;
    player = from;
    const idx = boxes.indexOf(from);
    boxes[idx] = sTo[s];
    boxes.sort((a, b) => a - b);
  }
  return { pushes: path.length, moves };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box there
 * reaches no goal) out of the floor; each part left holding boxes is a room. Null when
 * some part holds more or fewer boxes than goals, or a box starts in the hallway.
 */
function roomsOf(level) {
  const { w, h, wall, goals, boxes, player } = level;
  const live = liveSquares(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]].boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Solve one level room by room (falling back to the whole level), or null when it gives up. */
function solveLevel(text) {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms !== null) {
    let player = level.player;
    let pushes = 0;
    let moves = '';
    for (const room of rooms) {
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
      }
      const sub = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      let sol = searchPush(sub, ROOM_EXPANSION_CAP, 'astar');
      if (sol === null) sol = searchPush(sub, GREEDY_EXPANSION_CAP, 'greedy');
      if (sol === null) return solveWhole(level);
      pushes += sol.pushes;
      moves += sol.moves;
      player = endOf(level.w, player, sol.moves);
      room.done = true;
    }
    return { pushes, moves };
  }
  return solveWhole(level);
}

/** Whole-level search, for levels that are no set of rooms. */
function solveWhole(level) {
  let sol = searchPush(level, ROOM_EXPANSION_CAP, 'astar');
  if (sol === null) sol = searchPush(level, GREEDY_EXPANSION_CAP, 'greedy');
  return sol;
}

for (const id of readdirSync(I).sort()) {
  const sol = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  const moves = sol === null ? '' : sol.moves;
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
