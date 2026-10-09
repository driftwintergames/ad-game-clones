// Event loop, boarding scan, dynamic side-fill, dispatch (spec §5-7).

import type { AttemptCore, GameEvent, Vehicle } from './types';
import { BOARD_COL } from './constants';
import {
  boardingCandidates, baysFull, clone, findVehicle, openBay, pathClear, walkersBound,
} from './engine';
import type { EngineCtx } from './engine';

// ── dynamic side-fill (spec §7.2, amended — see vault spec change log) ──
//
// Amendment vs. spec §7.2.1: no cross-fallback between boarding columns 2
// and 3. The spec's "For Column 2: ... If empty, check Column 3" lets bay 0
// steal bay 1's aligned supply and structurally deadlock both bays once
// arrivals exhaust. Each boarding column pulls from its own flank chain
// (2 <- 1 <- 0, 3 <- 4 <- 5) FIRST; the opposite bay's near flank (lane 4
// for bay 0, lane 1 for bay 1) is a last-resort relief source so a color
// seeded entirely on the far chain can still reach its bus. Relief pulls
// move only matching passengers — the waiting-for-my-bus shuffle.

const SIDE_SOURCE: Record<number, number[]> = {
  // Depletion pulls: own chain inward (2 <- 1 <- 0; 3 <- 4 <- 5).
  2: [1, 0],
  3: [4, 5],
};
// Relief pulls (front mismatch): nearest matching passenger in ANY lane,
// ordered by walking distance — people cross the whole stop for their bus.
const RELIEF_SOURCE: Record<number, number[]> = {
  2: [1, 3, 0, 4, 5],
  3: [4, 2, 5, 1, 0],
};

/** Front columns of each boarding column's flank chain. */
export function sideFill(core: AttemptCore, c: number, matchColor?: string): { moved: boolean; from: number } {
  const sources = matchColor === undefined ? SIDE_SOURCE[c] : RELIEF_SOURCE[c];
  if (!sources) return { moved: false, from: -1 };
  for (const src of sources) {
    const q = core.queues[src];
    if (q.length === 0) continue;
    if (matchColor === undefined) {
      // Depleted boarding column: topmost passenger migrates in.
      const p = q.shift()!;
      core.queues[c].unshift(p);
      return { moved: true, from: src };
    }
    // Relief pull (mismatch case): the nearest matching passenger crosses
    // over; non-matching passengers ahead of it keep their order behind.
    const idx = q.findIndex(p => p.color === matchColor);
    if (idx === -1) continue;
    const p = q.splice(idx, 1)[0];
    core.queues[c].unshift(p);
    return { moved: true, from: src };
  }
  return { moved: false, from: -1 };
}

// ── boarding scan (spec §7.1) ──────────────────────────────────────────

/**
 * Board docked vehicles with open seats, oldest dock first, from the front
 * of their facing column. Side-fill fires ONLY when the boarding column is
 * depleted (spec §7.1.2) — a non-matching front passenger blocks the bay;
 * that block IS the puzzle.
 */
export function scan(core: AttemptCore, now: number): GameEvent[] {
  const events: GameEvent[] = [];
  let guard = 0;
  let progressed = true;
  while (progressed && guard++ < 60) {
    progressed = false;
    for (const v of boardingCandidates(core)) {
      const bc = BOARD_COL[v.bay!];
      let openSeats = v.capacity - v.boarded - walkersBound(core, v.id);
      while (openSeats > 0 && core.queues[bc].length > 0 && core.queues[bc][0].color === v.color) {
        const p = core.queues[bc].shift()!;
        const i = walkersBound(core, v.id);
        core.walkers.push({
          id: core.nextPassengerId++,
          vehicleId: v.id,
          color: p.color,
          from: { x: 45 + bc * 60, y: 450 },
          departAt: now + 180 * i,
          arriveAt: now + 350 + 220 * i,
          semitone: core.pitchStep,
        });
        core.pitchStep = Math.min(core.pitchStep + 1, 12);
        openSeats--;
        events.push({ type: 'board', vehicleId: v.id, passengerColor: p.color, bay: v.bay!, column: bc });
        progressed = true;
      }
      if (openSeats > 0 && core.queues[bc].length === 0) {
        // Depleted boarding column: own-chain topmost migrates in (spec
        // §7.2); if the whole chain is empty, relief-pull the nearest
        // matching passenger from anywhere (canBoardNow parity).
        let fill = sideFill(core, bc);
        if (!fill.moved) fill = sideFill(core, bc, v.color);
        if (fill.moved) {
          events.push({ type: 'sidefill', fromColumn: fill.from, toColumn: bc });
          progressed = true;
        }
      } else if (openSeats > 0 && core.queues[bc][0] && core.queues[bc][0].color !== v.color) {
        // relief: the nearest matching passenger crosses over — including one
        // buried in THIS lane behind the mismatched front (they shuffle past)
        let fill = sideFill(core, bc, v.color);
        if (!fill.moved && core.queues[bc].some((p, idx) => idx > 0 && p.color === v.color)) {
          const idx = core.queues[bc].findIndex((p, i) => i > 0 && p.color === v.color);
          const p = core.queues[bc].splice(idx, 1)[0];
          core.queues[bc].unshift(p);
          fill = { moved: true, from: bc };
        }
        if (fill.moved) {
          events.push({ type: 'sidefill', fromColumn: fill.from, toColumn: bc });
          progressed = true;
        }
      }
    }
  }
  return events;
}

// ── stuck detection (spec §1.6) ────────────────────────────────────────

export function canBoardNow(core: AttemptCore, v: Vehicle): boolean {
  if (v.phase !== 'boarding') return false;
  if (v.capacity - v.boarded - walkersBound(core, v.id) <= 0) return false;
  const bc = BOARD_COL[v.bay!];
  const front = core.queues[bc][0];
  if (front && front.color === v.color) return true;
  // relief: a matching passenger anywhere in the stop counts
  return core.queues.some(q => q.some(p => p.color === v.color));
}

export function isStuck(ctx: EngineCtx): boolean {
  const core = ctx.core;
  if (core.walkers.length > 0) return false;
  if (core.vehicles.some(v => v.phase === 'driving')) return false;
  if (core.nextArrival !== null) return false;
  for (const v of core.vehicles) {
    if (v.phase === 'boarding' && canBoardNow(core, v)) return false;
    if (v.phase === 'parked' && pathClear(core, v) && !baysFull(core) && !core.gateBusy) return false;
  }
  return true;
}

// ── advance (spec §5) ──────────────────────────────────────────────────

export type EndState =
  | { status: 'won' }
  | { status: 'failed'; failKind: 'overflow' | 'stuck' };

export function advance(
  ctx: EngineCtx,
  targetTime: number,
): { events: GameEvent[]; end: EndState | null } {
  const core = ctx.core;
  const level = ctx.level;
  const events: GameEvent[] = [];
  if (targetTime < core.simTime) return { events, end: null };

  for (let guard = 0; guard < 100000; guard++) {
    const times: number[] = [];
    if (core.nextArrival !== null) times.push(core.nextArrival);
    for (const v of core.vehicles) {
      if (v.phase === 'driving' && v.driveStartedAt !== null && v.driveDuration !== null) {
        times.push(v.driveStartedAt + v.driveDuration);
      }
    }
    for (const w of core.walkers) times.push(w.arriveAt);
    if (times.length === 0) {
      // No pending events: settle any boardable state (relief boarding can
      // leave progress that no future event would trigger), then stop.
      let settled = false;
      while (!settled) {
        const evs = scan(core, core.simTime);
        events.push(...evs);
        settled = evs.length === 0;
      }
      if (core.vehicles.every(v => v.phase === 'gone')) {
        return { events, end: { status: 'won' } };
      }
      if (isStuck(ctx)) return { events, end: { status: 'failed', failKind: 'stuck' } };
      break;
    }
    const next = Math.min(...times);
    if (next > targetTime) break;
    core.simTime = next;

    // 1. drive arrivals
    for (const v of core.vehicles) {
      if (v.phase === 'driving' && v.driveStartedAt !== null && v.driveDuration !== null &&
          v.driveStartedAt + v.driveDuration === next) {
        v.phase = 'boarding';
        v.boardedSince = next;
        core.gateBusy = false;
        events.push({ type: 'drive-arrival', vehicleId: v.id, bay: v.bay! });
      }
    }

    // 2. walker arrivals
    const staying: typeof core.walkers = [];
    for (const w of core.walkers) {
      if (w.arriveAt === next) {
        const v = findVehicle(core, w.vehicleId);
        if (v) {
          v.boarded++;
          if (v.boarded === v.capacity) {
            v.phase = 'gone';
            v.goneAt = next;
            if (v.bay !== null) core.bays[v.bay] = null;
            events.push({ type: 'depart', vehicleId: v.id, color: v.color });
          }
        }
      } else {
        staying.push(w);
      }
    }
    core.walkers = staying;

    // 3. passenger inflow (fewest column, tie -> lowest index)
    if (core.nextArrival !== null && core.nextArrival === next) {
      const color = ctx.arrivals[core.arrivalIndex];
      if (color) {
        let col = 0;
        for (let c = 1; c < 6; c++) if (core.queues[c].length < core.queues[col].length) col = c;
        core.queues[col].push({ id: core.nextPassengerId++, color });
        core.arrivalIndex++;
        events.push({ type: 'arrive', passengerColor: color, column: col });
        const total = core.queues.reduce((n, q) => n + q.length, 0);
        if (total > level.queueTotalCapacity) {
          return { events, end: { status: 'failed', failKind: 'overflow' } };
        }
      }
      core.nextArrival = core.arrivalIndex < ctx.arrivals.length ? next + level.intervalMs : null;
    }

    // 4. boarding scan
    events.push(...scan(core, next));

    // win check (spec §5.2.2: immediately when the last vehicle departs —
    // MUST precede the stuck check, or a win after arrivals exhaust reads as stuck)
    if (core.vehicles.every(v => v.phase === 'gone')) {
      return { events, end: { status: 'won' } };
    }

    // 5. stuck verification
    if (isStuck(ctx)) return { events, end: { status: 'failed', failKind: 'stuck' } };
  }

  // Between events, sim time still flows to target (spec §5.1) so drives and
  // walkers interpolate smoothly.
  if (core.simTime < targetTime) core.simTime = targetTime;
  return { events, end: null };
}

// ── dispatch (spec §6) ─────────────────────────────────────────────────

export type DispatchResult =
  | { ok: true; events: GameEvent[] }
  | { ok: false; reason: 'blocked' | 'gate' | 'bays' };

export function dispatch(ctx: EngineCtx, vehicleId: number): DispatchResult {
  const core = ctx.core;
  const v = findVehicle(core, vehicleId);
  if (!v || v.phase !== 'parked') return { ok: false, reason: 'blocked' };
  if (!pathClear(core, v)) return { ok: false, reason: 'blocked' };
  if (core.gateBusy) return { ok: false, reason: 'gate' };
  const bay = openBay(core);
  if (bay === null) return { ok: false, reason: 'bays' };

  ctx.snapshot = clone(core);
  core.bays[bay] = v.id;
  v.bay = bay;
  v.phase = 'driving';
  v.driveStartedAt = core.simTime;
  v.driveDuration = 550 + 120 * v.indexFromFront;
  core.gateBusy = true;
  core.dispatchedOnce = true;
  for (const o of core.vehicles) {
    if (o !== v && o.phase === 'parked' && o.column === v.column && o.indexFromFront > v.indexFromFront) {
      o.indexFromFront--;
    }
  }
  return { ok: true, events: [{ type: 'dispatch', vehicleId: v.id, bay }] };
}

export function legalTaps(ctx: EngineCtx): Vehicle[] {
  const core = ctx.core;
  return core.vehicles.filter(
    v => v.phase === 'parked' && pathClear(core, v) && !baysFull(core) && !core.gateBusy,
  );
}
