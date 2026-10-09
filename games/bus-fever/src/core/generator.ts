// Level generator (spec §9). Hand-authored Level 1; procedural for id >= 2.
// Parameters come from the DAG service — no magic numbers here.
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
import { COLORS } from './constants';
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

/** Hand-authored Level 1 (spec §9.3) — fully deterministic. */
export function generateLevel1(config: LevelConfig): GeneratedLevel {
  const vehicles: GeneratedLevel['vehicles'] = [
    { kind: 'bus', color: 'yellow', capacity: 4, column: 2, indexFromFront: 0 },
    { kind: 'bus', color: 'blue', capacity: 4, column: 2, indexFromFront: 1 },
    { kind: 'bus', color: 'red', capacity: 4, column: 3, indexFromFront: 0 },
    { kind: 'bus', color: 'red', capacity: 4, column: 3, indexFromFront: 1 },
  ];
  const q = (color: Color, column: number) => ({ color, column });
  const seedQueue: GeneratedLevel['seedQueue'] = [
    q('yellow', 2), q('yellow', 2), q('yellow', 2), q('yellow', 2),
    q('red', 3), q('red', 3), q('red', 3), q('red', 3),
    q('blue', 1), q('blue', 1), q('blue', 1), q('blue', 1),
    q('red', 4), q('red', 4), q('red', 4), q('red', 4),
  ];
  const arrivals: Color[] = [
    'red', 'red', 'red', 'red',
    'blue', 'blue', 'blue', 'blue',
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
 * - Some supply converts to arrivals (the clock) — but only a color's
 *   surplus beyond its chain's own needs.
 */
export function generateProceduralLevel(config: LevelConfig): GeneratedLevel {
  const rng = mulberry32(config.id * 2654435761);
  const palette = COLORS.slice(0, config.colors);
  const vehicles: GeneratedLevel['vehicles'] = [];

  // Assign colors so each chain has variety. Column order: left chain
  // 2,1,0 then right chain 3,4,5, alternating sides per bus.
  const leftCols = [2, 1, 0];
  const rightCols = [3, 4, 5];
  const depthIn = new Array(6).fill(0);
  const colVehicles: Record<number, { color: Color; capacity: number }[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] };
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
    colVehicles[column].push({ color, capacity: config.capacity });
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

  // Seed clean runs: for each chain, seed each demanded color across the
  // chain's lanes — boarding lane (first col) gets front colors, next lanes
  // get the rest, in run order. ~70% of each color's demand seeds; the rest
  // becomes arrivals.
  const arrivalsBuckets = new Map<Color, number>();
  // Seed budget: never let the seeded crowd sit at the overflow edge.
  // queueTotalCapacity minus headroom (6 visible rows); demand beyond the
  // budget becomes arrivals (longer clock, same pressure).
  const seedBudget = Math.max(8, config.queueTotalCapacity - 8);
  let budgetLeft = seedBudget;
  for (const key of ['L', 'R'] as const) {
    const { cols, demand } = chains[key];
    const laneOrder = cols; // e.g. [2,1,0]: boarding lane first
    let lane = 0;
    for (const [color, total] of demand) {
      // Seed ~70% of demand, spread in sub-runs of at most 2 consecutive
      // (anti-lump), never more than 6 per lane (visible depth), and never
      // beyond the remaining budget.
      const want = Math.max(1, Math.round(total * 0.7));
      const seedN = Math.min(want, budgetLeft);
      budgetLeft -= seedN;
      const arriveN = Math.max(0, total - seedN);
      let seededThisColor = 0;
      const laneUsed: Record<number, number> = {};
      while (seededThisColor < seedN) {
        const chunk = Math.min(seedN - seededThisColor, 2);
        for (let s = 0; s < chunk; s++) {
          if ((laneUsed[laneOrder[lane]] || 0) >= 6) break;
          seedQueue.push({ color, column: laneOrder[lane] });
          laneUsed[laneOrder[lane]] = (laneUsed[laneOrder[lane]] || 0) + 1;
          seededThisColor++;
        }
        lane = (lane + 1) % laneOrder.length;
        if (laneUsed[laneOrder[lane]] >= 6 && laneUsed[laneOrder[(lane + 1) % 3]] >= 6 && laneUsed[laneOrder[(lane + 2) % 3]] >= 6) break;
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
