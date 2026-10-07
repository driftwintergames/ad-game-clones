import { DagResolver } from './dag_resolver.js';
import type { DagDefinitions } from './dag_parser.js';

/**
 * Per-game DAG runtime. Loads ONLY this game's stitched graph
 * (src/generated/dag.json), evaluates gates/rates per tick, exposes
 * getState/setState/subscribe. One runtime instance per game — isolation.
 */
export class DagRuntime extends DagResolver {
  private listeners = new Set<(state: Record<string, number>) => void>();

  constructor(defs: DagDefinitions, initialState: Record<string, number> = {}) {
    super(defs);
    this.state = initialState;
  }

  // expose protected fields
  declare defs: DagDefinitions;
  declare state: Record<string, number>;
  declare cache: Record<string, number>;

  public setState = (patch: Record<string, number>): void => {
    this.state = { ...this.state, ...patch };
    this.cache = {};
    for (const fn of this.listeners) fn(this.snapshot());
  };

  public getState = (): Record<string, number> => this.snapshot();

  public subscribe = (fn: (state: Record<string, number>) => void): (() => void) => {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  };

  /** Evaluate a gate condition for an entity id (REVEAL/UNLOCK/REVEALUNLOCK). */
  public gate = (id: string, kind: 'REVEAL' | 'UNLOCK'): boolean => {
    const list = this.defs.progressions[id];
    if (!list) return kind === 'REVEAL'; // no gate = always visible
    const hit = list.find(p => p.type === kind || p.type === 'REVEALUNLOCK');
    if (!hit) return kind === 'REVEAL';
    return this.evaluateCondition(hit.rpn);
  };

  /** Level of a progression entity (0 = locked, 1+ = purchased levels). */
  public level = (id: string): number => this.get(`${id}_level`);

  /** Interpolate {{token}} in a metadata string against current values. */
  public render = (text: string): string =>
    text.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, tok) =>
      String(Math.round(this.get(tok) * 100) / 100)
    );

  private snapshot(): Record<string, number> {
    return { ...this.state };
  }
}

import type { DagDefinitions as Defs } from './dag_parser.js';
export type { Defs };
