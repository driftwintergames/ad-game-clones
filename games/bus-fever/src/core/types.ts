// Bus Fever — core data models (spec §3.1).
// The simulation kernel is pure: no DOM/Canvas/WebAudio imports here.

export type Color = 'red' | 'blue' | 'yellow' | 'green' | 'purple' | 'orange';
export type Kind = 'bus' | 'car';
export type Phase = 'parked' | 'driving' | 'boarding' | 'gone';

export interface Vehicle {
  id: number;
  kind: Kind;
  color: Color;
  capacity: number;        // Bus: 4..6, Car: 1
  column: number;          // 0..5
  indexFromFront: number;  // 0 = frontmost row, 1 = behind, 2+ = offscreen
  phase: Phase;
  boarded: number;
  bay: number | null;      // 0 or 1 when driving/boarding, else null
  driveStartedAt: number | null;
  driveDuration: number | null;
  boardedSince: number | null;
  /** sim-time the vehicle reached capacity and turned gone (render use). */
  goneAt: number | null;
}

export interface Passenger {
  id: number;
  color: Color;
}

export interface Walker {
  id: number;
  vehicleId: number;
  color: Color;
  from: { x: number; y: number };
  departAt: number;
  arriveAt: number;
  semitone: number;
}

export interface AttemptCore {
  simTime: number;
  vehicles: Vehicle[];
  queues: Passenger[][];      // 6 columns; index 0 is frontmost (top) slot
  walkers: Walker[];
  bays: (number | null)[];    // length 2: vehicle id or null
  gateBusy: boolean;
  arrivalIndex: number;
  nextArrival: number | null;
  nextPassengerId: number;
  pitchStep: number;
  dispatchedOnce: boolean;
}

export type FailKind = 'overflow' | 'stuck' | null;

export interface Attempt extends AttemptCore {
  status: 'playing' | 'won' | 'failed';
  paused: boolean;
  snapshot: AttemptCore | null;
  failKind: FailKind;
}

export interface LevelConfig {
  id: number;
  intervalMs: number;
  buses: number;
  colors: number;
  capacity: number;
  queueTotalCapacity: number;
}

export type GameEvent =
  | { type: 'dispatch'; vehicleId: number; bay: number }
  | { type: 'drive-arrival'; vehicleId: number; bay: number }
  | { type: 'board'; vehicleId: number; passengerColor: Color; bay: number; column: number }
  | { type: 'sidefill'; fromColumn: number; toColumn: number }
  | { type: 'depart'; vehicleId: number; color: Color }
  | { type: 'arrive'; passengerColor: Color; column: number }
  | { type: 'illegal'; reason: 'blocked' | 'gate' | 'bays' | 'notap' }
  | { type: 'win' }
  | { type: 'fail'; kind: 'overflow' | 'stuck' }
  | { type: 'undo' };
