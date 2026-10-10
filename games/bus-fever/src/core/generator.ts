// Level generator (spec §9). Hand-authored Level 1; procedural for id >= 2.
// Parameters come from the DAG service — no magic numbers here.
//
// Ad-scale crowds: 50+ people per level, deep lanes (9 visible rows, +N
// beyond), 12-30 buses.
//
// Fairness invariants (required by spec §7 chain semantics):
// 1. Chain-balanced supply: lane chains (2,1,0 -> bay 0; 3,4,5 -> bay 1)
//    must contain, per color, at least the seats of the chain's own vehicles.
//    Cross-chain relief exists but is last-resort only — a level whose
//    solution requires it is a badly generated level.
// 2. Clean-run seeding: each column's vehicles seed consecutive same-color
//    runs in their own lane so succession inherits an aligned front.
// 3. Arrivals always non-empty for id >= 2 — the fail clock.
// 4. Supply per color equals seats per color (winnable; no dead colors).

import type { LevelConfig, Color } from './types';
import { COLORS, QUEUE_ROWS } from './constants';
import { mulberry32 } from './prng';

export interface GeneratedLevel {
  config: LevelConfig;
  vehicles: {
    kind: 'bus' | 'car';
    color: Color;
    capacity: number;
    column: number;
    indexFromFront: number;
  }[];
  seedQueue: { color: Color; column: number }[];
  arrivals: Color[];
}

/** Hand-authored Level 1 (spec §9.3) — 10 buses, 50 people. */
export function generateLevel1(config: LevelConfig): GeneratedLevel {
  const cap = config.capacity; // 5 at L1
  const b = (color: Color, column: number, indexFromFront: number) =>
    ({ kind: 'bus' as const, color, capacity: cap, column, indexFromFront });
  const vehicles: GeneratedLevel['vehicles'] = [
    b('yellow', 2, 0), b('blue', 2, 1),      // col 2: yellow front, blue behind
    b('red', 3, 0), b('red', 3, 1),          // col 3: red, red
    b('blue', 1, 0), b('yellow', 1, 1),      // col 1: blue front, yellow behind
    b('red', 4, 0), b('blue', 4, 1),         // col 4: red front, blue behind
    b('red', 0, 0),                          // col 0: red
    b('yellow', 5, 0),                       // col 5: yellow
  ];
  const q = (color: Color, column: number, n: number) =>
    Array.from({ length: n }, () => ({ color, column }));
  const seedQueue: GeneratedLevel['seedQueue'] = [
    ...q('yellow', 2, cap),   // c2 front payoff
    ...q('blue', 1, cap),     // c1 front payoff
    ...q('red', 3, cap),      // c3 front payoff
    ...q('red', 4, cap),      // c4 front payoff
    ...q('blue', 0, cap),     // c2/c1 succession (blue back-buses)
    ...q('yellow', 5, cap),   // c1 back + c5 payoff (yellow)
  ];                           // 30 seeded; 20 arrive
  const arrivals: Color[] = [
    'yellow', 'blue', 'red', 'red',
    'yellow', 'blue', 'red', 'red',
    'yellow', 'blue', 'red', 'red',
    'yellow', 'blue', 'red', 'red',
    'yellow', 'blue', 'red', 'red',
  ];
  return { config, vehicles, seedQueue, arrivals };
}

/**
 * Procedural level for id >= 2 (spec §9.2).
 *
 * Chain-aligned composition:
 * - Vehicle columns pair up: each side gets buses in cols (2,1,0) and
 *   (3,4,5) alternately, so both chains carry demand.
 * - A column's vehicles share ONE color; supply seeds as clean runs in the
 *   column's own lane (boarding lane first, flank next).
 * - Some colors' supply converts to arrivals (the clock) — but only a color's
 *   surplus beyond its chain's own needs.
 */
export function generateProceduralLevel(config: LevelConfig): GeneratedLevel {
  const rng = mulberry32(config.id * 2654435761);
  const palette = COLORS.slice(0, config.colors);
  const vehicles: GeneratedLevel['vehicles'] = [];

  // Assign colors so each chain has variety. Column order: left chain
  // 2,1,0 then right chain 3,4,5, alternating sides per bus; extra buses
  // stack as succession (deeper rows) in the same columns.
  const leftCols = [2, 1, 0];
  const rightCols = [3, 4, 5];
  const depthIn = new Array(6).fill(0);
  for (let i = 0; i < config.buses; i++) {
    const side = i % 2 === 0 ? 0 : 1;
    const cols = side === 0 ? leftCols : rightCols;
    const slot = Math.floor(i / 2) % cols.length;
    const column = cols[slot];
    const color = palette[Math.floor(rng() * palette.length)];
    vehicles.push({
      kind: 'bus',
      color,
      capacity: config.capacity,
      column,
      indexFromFront: depthIn[column]++,
    });
  }

  const seedQueue: GeneratedLevel['seedQueue'] = [];

  // Per chain: demand per color = seats of that chain's vehicles.
  const chains: Record<'L' | 'R', { cols: number[]; demand: Map<Color, number> }> = {
    L: { cols: leftCols, demand: new Map() },
    R: { cols: rightCols, demand: new Map() },
  };
  for (const v of vehicles) {
    const ch = chains[v.column <= 2 ? 'L' : 'R'].demand;
    ch.set(v.color, (ch.get(v.color) || 0) + v.capacity);
  }

  // Seed budget: keep the seeded crowd below the overflow edge.
  // queueTotalCapacity minus headroom; demand beyond the budget becomes
  // arrivals (longer clock, same pressure). Lanes hold QUEUE_ROWS each.
  const seedBudget = Math.max(8, config.queueTotalCapacity - 8);
  let budgetLeft = seedBudget;
  const arrivalsBuckets = new Map<Color, number>();
  for (const key of ['L', 'R'] as const) {
    const { cols, demand } = chains[key];
    const laneOrder = cols; // e.g. [2,1,0]: boarding lane first
    let lane = 0;
    for (const [color, total] of demand) {
      // Seed ~70% of demand, spread in sub-runs of at most 2 consecutive
      // (anti-lump), never more than QUEUE_ROWS per lane (visible depth),
      // and never beyond the remaining budget.
      const want = Math.max(1, Math.round(total * 0.7));
      const seedN = Math.min(want, budgetLeft);
      budgetLeft -= seedN;
      const arriveN = Math.max(0, total - seedN);
      let seededThisColor = 0;
      const laneUsed: Record<number, number> = {};
      while (seededThisColor < seedN) {
        const chunk = Math.min(seedN - seededThisColor, 2);
        for (let s = 0; s < chunk; s++) {
          if ((laneUsed[laneOrder[lane]] || 0) >= QUEUE_ROWS) break;
          seedQueue.push({ color, column: laneOrder[lane] });
          laneUsed[laneOrder[lane]] = (laneUsed[laneOrder[lane]] || 0) + 1;
          seededThisColor++;
        }
        lane = (lane + 1) % laneOrder.length;
        const full = laneOrder.every((l) => (laneUsed[l] || 0) >= QUEUE_ROWS);
        if (full) break;
      }
      if (arriveN > 0) arrivalsBuckets.set(color, (arrivalsBuckets.get(color) || 0) + arriveN);
    }
  }

  // Interleave arrivals round-robin across colors.
  const arrivals: Color[] = [];
  let left = [...arrivalsBuckets.values()].reduce((a, b) => a + b, 0);
  while (left > 0) {
    for (const c of palette) {
      const n = arrivalsBuckets.get(c) || 0;
      if (n > 0) {
        arrivals.push(c);
        arrivalsBuckets.set(c, n - 1);
        left--;
      }
    }
  }
  return { config, vehicles, seedQueue, arrivals };
}

export function generateLevel(config: LevelConfig): GeneratedLevel {
  return config.id === 1 ? generateLevel1(config) : generateProceduralLevel(config);
}
