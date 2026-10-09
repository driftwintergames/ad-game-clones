// Headless deterministic engine (spec §5-7) — part 1: state creation and
// spatial queries. Event loop, boarding, dispatch live in sibling modules.

import type { AttemptCore, Color, LevelConfig, Passenger, Vehicle } from './types';
import { BOARD_COL } from './constants';

export interface EngineCtx {
  core: AttemptCore;
  level: LevelConfig;
  arrivals: Color[];
  snapshot: AttemptCore | null;
}

export function createCtx(
  level: LevelConfig,
  gen: {
    vehicles: { kind: 'bus' | 'car'; color: Color; capacity: number; column: number; indexFromFront: number }[];
    seedQueue: { color: Color; column: number }[];
    arrivals: Color[];
  },
): EngineCtx {
  const queues: Passenger[][] = [[], [], [], [], [], []];
  for (const p of gen.seedQueue) queues[p.column].push({ id: 0, color: p.color });
  let pid = 1;
  for (const col of queues) for (const p of col) p.id = pid++;
  const vehicles: Vehicle[] = gen.vehicles.map((v, i) => ({
    id: i + 1,
    kind: v.kind,
    color: v.color,
    capacity: v.capacity,
    column: v.column,
    indexFromFront: v.indexFromFront,
    phase: 'parked' as const,
    boarded: 0,
    bay: null,
    driveStartedAt: null,
    driveDuration: null,
    boardedSince: null,
    goneAt: null,
  }));
  const core: AttemptCore = {
    simTime: 0,
    vehicles,
    queues,
    walkers: [],
    bays: [null, null],
    gateBusy: false,
    arrivalIndex: 0,
    nextArrival: gen.arrivals.length > 0 ? level.intervalMs : null,
    nextPassengerId: pid,
    pitchStep: 0,
    dispatchedOnce: false,
  };
  return { core, level, arrivals: gen.arrivals, snapshot: null };
}

export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A parked vehicle may drive iff nothing parked is in front of it in its column. */
export function pathClear(core: AttemptCore, v: Vehicle): boolean {
  for (const o of core.vehicles) {
    if (o !== v && o.phase === 'parked' && o.column === v.column && o.indexFromFront < v.indexFromFront) {
      return false;
    }
  }
  return true;
}

export function baysFull(core: AttemptCore): boolean {
  return core.bays[0] !== null && core.bays[1] !== null;
}

export function openBay(core: AttemptCore): number | null {
  if (core.bays[0] === null) return 0;
  if (core.bays[1] === null) return 1;
  return null;
}

export function findVehicle(core: AttemptCore, id: number): Vehicle | undefined {
  return core.vehicles.find(v => v.id === id);
}

/** Hit-test a design-space point against visible parked vehicle cells. */
export function hitTest(core: AttemptCore, x: number, y: number): Vehicle | null {
  for (const v of core.vehicles) {
    if (v.phase !== 'parked') continue;
    if (v.indexFromFront > 1) continue;
    const cx = 45 + v.column * 60;
    const cy = 245 - v.indexFromFront * 90;
    if (x >= cx - 23 && x <= cx + 23 && y >= cy - 38 && y <= cy + 38) return v;
  }
  return null;
}

/** Vehicles docked in bays with seats still open, in boarding order. */
export function boardingCandidates(core: AttemptCore): Vehicle[] {
  return core.vehicles
    .filter(v => v.phase === 'boarding')
    .filter(v => v.capacity - v.boarded - walkersBound(core, v.id) > 0)
    .sort((a, b) => (a.boardedSince ?? 0) - (b.boardedSince ?? 0) || (a.bay ?? 0) - (b.bay ?? 0));
}

export function walkersBound(core: AttemptCore, vehicleId: number): number {
  let n = 0;
  for (const w of core.walkers) if (w.vehicleId === vehicleId) n++;
  return n;
}

/** Column facing bay b (bay 0 faces column 2, bay 1 faces column 3). */
export const boardingColFor = (bay: number): number => BOARD_COL[bay];
