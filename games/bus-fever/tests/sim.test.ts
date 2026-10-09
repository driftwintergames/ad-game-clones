// Headless spec tests (architecture §6): determinism, Level 1 scripted win,
// side-fill invariants, undo, DAG levels 1..100.

import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/prng';
import { generateLevel, generateLevel1 } from '../src/core/generator';
import { createCtx, clone, hitTest } from '../src/core/engine';
import { advance, dispatch, legalTaps, sideFill } from '../src/core/sim';
import { getLevelConfig } from '../src/dag/dagService';
import type { EngineCtx } from '../src/core/engine';

function ctxFor(levelId: number): EngineCtx {
  const config = getLevelConfig(levelId);
  const gen = generateLevel(config);
  return createCtx(config, gen);
}

describe('mulberry32', () => {
  it('first uint of seed 1 is 2693262067', () => {
    const first = mulberry32(1)();
    expect(Math.floor(first * 4294967296)).toBe(2693262067);
  });
});

describe('Level 1', () => {
  it('is hand-authored per spec 9.3', () => {
    const g = generateLevel1(getLevelConfig(1));
    expect(g.vehicles).toHaveLength(4);
    expect(g.seedQueue).toHaveLength(16);
    expect(g.arrivals).toHaveLength(8);
  });

  it('greedy autoplay wins (full loop)', () => {
    const ctx = ctxFor(1);
    let end: ReturnType<typeof advance>['end'] = null;
    for (let step = 0; step < 400 && !end; step++) {
      ({ end } = advance(ctx, ctx.core.simTime + 500));
      if (end) break;
      const taps = legalTaps(ctx);
      if (taps.length === 0) continue;
      const front2 = ctx.core.queues[2][0]?.color;
      const front3 = ctx.core.queues[3][0]?.color;
      const pick =
        taps.find(v => v.color === front2 || v.color === front3) ?? taps[0];
      expect(dispatch(ctx, pick.id).ok).toBe(true);
    }
    expect(end?.status).toBe('won');
  });

  it('undo restores pre-dispatch state exactly', () => {
    const ctx = ctxFor(1);
    const before = clone(ctx.core);
    const r = dispatch(ctx, 1);
    expect(r.ok).toBe(true);
    expect(ctx.snapshot).not.toBeNull();
    Object.assign(ctx.core, clone(ctx.snapshot!));
    expect(ctx.core).toEqual(before);
    expect(hitTest(ctx.core, 165, 245)?.id).toBe(1);
  });

  it('hitTest finds vehicles at cell centers', () => {
    const ctx = ctxFor(1);
    expect(hitTest(ctx.core, 165, 245)?.id).toBe(1); // col2 front = yellow
    expect(hitTest(ctx.core, 225, 245)?.id).toBe(3); // col3 front = red
  });
});

describe('side-fill invariants', () => {
  it('col 2 pulls from col 1 first, then col 3', () => {
    const ctx = ctxFor(1);
    const core = ctx.core;
    for (let c = 0; c < 6; c++) core.queues[c] = [];
    core.queues[1] = [
      { id: 101, color: 'blue' },
      { id: 102, color: 'red' },
    ];
    const r1 = sideFill(core, 2);
    expect(r1.moved).toBe(true);
    expect(r1.from).toBe(1);
    expect(core.queues[2][0].color).toBe('blue');
    expect(core.queues[1].length).toBe(1);
  });

  it('col 2 pull from col 1: chain depletes inward over turns', () => {
    const ctx = ctxFor(1);
    const core = ctx.core;
    for (let c = 0; c < 6; c++) core.queues[c] = [];
    core.queues[1] = [{ id: 221, color: 'blue' }];
    core.queues[0] = [{ id: 201, color: 'yellow' }];
    const r = sideFill(core, 2); // boarding col 2 depleted
    expect(r.moved).toBe(true);
    expect(r.from).toBe(1);
    expect(core.queues[2][0].color).toBe('blue');
    expect(core.queues[1].length).toBe(0); // next turn pulls from col 0
    const r2 = sideFill(core, 2);
    expect(r2.moved).toBe(true);
    expect(r2.from).toBe(0);
    expect(core.queues[2][0].color).toBe('yellow');
  });
});

describe('DAG service', () => {
  it('returns valid params for levels 1..100', () => {
    for (let id = 1; id <= 100; id++) {
      const c = getLevelConfig(id);
      expect(c.intervalMs).toBeGreaterThanOrEqual(2000);
      expect(c.buses).toBeGreaterThanOrEqual(4);
      expect(c.buses).toBeLessThanOrEqual(12);
      expect(c.colors).toBeGreaterThanOrEqual(3);
      expect(c.colors).toBeLessThanOrEqual(6);
      expect(c.capacity).toBeGreaterThanOrEqual(4);
      expect(c.capacity).toBeLessThanOrEqual(6);
      expect(c.queueTotalCapacity).toBeGreaterThanOrEqual(36);
      expect(c.queueTotalCapacity).toBeLessThanOrEqual(48);
    }
  });

  it('applies spec 9.2 floors correctly', () => {
    expect(getLevelConfig(1).buses).toBe(4);
    expect(getLevelConfig(3).buses).toBe(5);
    expect(getLevelConfig(9).buses).toBe(8);
    expect(getLevelConfig(1).colors).toBe(3);
    expect(getLevelConfig(5).colors).toBe(4);
  });
});
