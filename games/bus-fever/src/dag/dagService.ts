// DAG runtime binding (architecture §3.3). Loads ONLY this game's stitched
// graph; generator parameters come from here — zero magic numbers in game code.

import dagData from '../generated/dag.json';
import { DagRuntime } from '@adgc/dag-kernel/runtime';
import type { LevelConfig } from '../core/types';

export const dag = new DagRuntime(dagData as never);

/**
 * Level params per spec §9.2 (floor applied at consumption — the DAG grammar
 * has no floor(); curves stay real-valued in .dag).
 */
export function getLevelConfig(levelId: number): LevelConfig {
  dag.setState({ level: levelId });
  return {
    id: levelId,
    intervalMs: dag.get('bus_fever_level_interval'),
    buses: Math.floor(dag.get('bus_fever_level_buses')),
    colors: Math.floor(dag.get('bus_fever_colors')),
    capacity: Math.floor(dag.get('bus_fever_level_capacity')),
    queueTotalCapacity: Math.floor(dag.get('bus_fever_queue_capacity')),
  };
}

export function streakBonus(streak: number): number {
  dag.setState({ streak });
  return Math.floor(dag.get('bus_fever_streak_bonus'));
}
