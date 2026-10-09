// Bootstrap & loop coordinator (architecture §1): owns the EngineCtx, rAF
// loop, input routing, undo/pause/restart, save writes, audio cues.

import { createCtx, clone, hitTest } from './core/engine';
import { advance, dispatch, isStuck as _isStuck, legalTaps } from './core/sim';
import { generateLevel } from './core/generator';
import { getLevelConfig } from './dag/dagService';
import { loadSave, writeSave, SAVE_KEY } from './core/save';
import { Synth } from './audio/synth';
import { Renderer } from './render/renderer';
import { Hud } from './ui/hud';
import { Overlays } from './ui/overlays';
import { platform } from './platform/platform';
import type { EngineCtx } from './core/engine';
import type { GameEvent } from './core/types';
import type { FxState } from './render/renderer';

class Game {
  ctx!: EngineCtx;
  renderer!: Renderer;
  hud!: Hud;
  overlays!: Overlays;
  synth = new Synth();
  save = loadSave();
  paused = false;
  ended = false;
  fx: FxState = { shake: null, bayFlashUntil: 0 };
  private downAt: { x: number; y: number; t: number } | null = null;
  private lastFrame = 0;

  start(levelId?: number): void {
    const level = getLevelConfig(levelId ?? this.save.frontier);
    const gen = generateLevel(level);
    this.ctx = createCtx(level, gen);
    this.paused = false;
    this.ended = false;
    this.fx = { shake: null, bayFlashUntil: 0 };
    this.overlays.hideCard();
    this.overlays.hidePause();
    this.hud.setUndoEnabled(false);
    this.save.attempts++;
    writeSave(this.save);
  }

  restart(): void {
    this.save.restarts++;
    this.start();
  }

  undo(): void {
    if (!this.ctx.snapshot || this.ended) return;
    Object.assign(this.ctx.core, clone(this.ctx.snapshot));
    this.ctx.snapshot = null;
    this.save.undos++;
    writeSave(this.save);
    this.hud.setUndoEnabled(false);
  }

  pause(): void {
    if (this.paused || this.ended) return;
    this.paused = true;
    this.overlays.showPause(
      () => { this.paused = false; this.overlays.hidePause(); },
      () => { this.save.restarts++; this.start(); },
      (on) => { this.save.sound = on; this.synth.enabled = on; writeSave(this.save); },
      (on) => { this.save.haptics = on; writeSave(this.save); },
      this.save.sound, this.save.haptics, this.save.bestStreak,
    );
  }

  /** Convert a viewport pointer to design-space coords. */
  toDesign(clientX: number, clientY: number): { x: number; y: number } {
    return {
      x: (clientX - this.renderer.offsetX) / this.renderer.scale,
      y: (clientY - this.renderer.offsetY) / this.renderer.scale,
    };
  }

  pointerDown(clientX: number, clientY: number, t: number): void {
    this.synth.unlock();
    this.downAt = { x: clientX, y: clientY, t };
  }

  pointerUp(clientX: number, clientY: number, t: number): void {
    if (!this.downAt || this.paused || this.ended) { this.downAt = null; return; }
    const dx = clientX - this.downAt.x;
    const dy = clientY - this.downAt.y;
    const dt = t - this.downAt.t;
    this.downAt = null;
    if (Math.hypot(dx, dy) > 12 || dt >= 500) return;
    const p = this.toDesign(clientX, clientY);
    const v = hitTest(this.ctx.core, p.x, p.y);
    if (!v) return;
    const res = dispatch(this.ctx, v.id);
    if (!res.ok) {
      this.fx.shake = { vehicleId: v.id, until: performance.now() + 120 };
      if (res.reason === 'bays') this.fx.bayFlashUntil = performance.now() + 120;
      this.synth.play('illegal');
      if (this.save.haptics) platform.haptics.impact();
      return;
    }
    this.hud.setUndoEnabled(true);
    const r = advance(this.ctx, this.ctx.core.simTime);
    if (r.end) this.finish(r.end);
  }

  private onEvent(e: GameEvent, replay: boolean): void {
    if (e.type === 'board') this.synth.play('hop', this.ctx.core.pitchStep);
    else if (e.type === 'depart') this.synth.play('horn');
    else if (e.type === 'arrive' && !replay) this.synth.play('arrive');
    else if (e.type === 'sidefill' && !replay) this.synth.play('arrive');
    // win/fail handled at frame level
  }

  frame(timestamp: number): void {
    if (!this.lastFrame) this.lastFrame = timestamp;
    const dt = Math.min(100, timestamp - this.lastFrame);
    this.lastFrame = timestamp;
    if (!this.paused && !this.ended) {
      const target = this.ctx.core.simTime + dt;
      const { end } = advance(this.ctx, target);
      if (end) this.finish(end);
    }
    this.renderer.draw({
      ctx: this.ctx,
      fx: this.fx,
      now: performance.now(),
      levelId: this.ctx.level.id,
      streak: this.save.streak,
      hint: !this.ctx.core.dispatchedOnce,
    });
    this.hud.setUndoEnabled(this.ctx.snapshot !== null);
    requestAnimationFrame(this.frame.bind(this));
  }

  private finish(end: { status: 'won' } | { status: 'failed'; failKind: 'overflow' | 'stuck' }): void {
    this.ended = true;
    if (end.status === 'won') {
      this.save.wins++;
      this.save.streak++;
      this.save.bestStreak = Math.max(this.save.bestStreak, this.save.streak);
      if (this.ctx.level.id === this.save.frontier) this.save.frontier++;
      this.synth.play('win');
      const next = this.ctx.level.id + 1;
      this.overlays.showCard(
        'Clear',
        this.save.streak >= 2 ? `Streak ${this.save.streak}` : `Level ${this.ctx.level.id} clear`,
        `Tap for level ${next}`,
        () => this.start(next),
      );
    } else {
      this.save.streak = 0;
      this.save.fails++;
      this.synth.play('fail');
      const body = end.failKind === 'overflow' ? 'The line is full' : 'No move left';
      this.overlays.showCard('Jammed', body, 'Tap to retry', () => this.start());
    }
    writeSave(this.save);
    void SAVE_KEY;
  }
}

// ── boot ────────────────────────────────────────────────────────────────
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;left:0;top:0;touch-action:none;';
document.body.appendChild(canvas);
const game = new Game();
game.renderer = new Renderer(canvas);
game.hud = new Hud(document.body, { onUndo: () => game.undo(), onPause: () => game.pause() });
game.overlays = new Overlays();
game.synth.enabled = game.save.sound;
game.start();
window.addEventListener('resize', () => game.renderer.resize());
platform.lifecycle.onPause(() => game.pause());
window.addEventListener('pointerdown', (e) => game.pointerDown(e.clientX, e.clientY, performance.now()));
window.addEventListener('pointerup', (e) => game.pointerUp(e.clientX, e.clientY, performance.now()));
(window as unknown as { __bf: Game }).__bf = game; // test hook
requestAnimationFrame(game.frame.bind(game));
