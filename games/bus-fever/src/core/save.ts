// Save system (spec §11): key agc:bus-fever, schema 1, atomic on win/fail.

import { platform } from '../platform/platform';

export interface Save {
  schema: 1;
  frontier: number;      // >= 1, next unplayed level
  streak: number;
  bestStreak: number;
  sound: boolean;
  haptics: boolean;
  attempts: number;
  wins: number;
  fails: number;
  restarts: number;
  undos: number;
}

export const SAVE_KEY = 'agc:bus-fever';

export function defaultSave(): Save {
  return {
    schema: 1,
    frontier: 1,
    streak:  0,
    bestStreak: 0,
    sound: true,
    haptics: true,
    attempts: 0,
    wins: 0,
    fails: 0,
    restarts: 0,
    undos: 0,
  };
}

export function loadSave(): Save {
  const raw = platform.storage.get<Save>(SAVE_KEY);
  if (!raw || raw.schema !== 1) return defaultSave();
  return { ...defaultSave(), ...raw };
}

export function writeSave(s: Save): void {
  platform.storage.set(SAVE_KEY, s);
}
