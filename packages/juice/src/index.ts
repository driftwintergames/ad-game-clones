/**
 * @adgc/juice — shared feel library (engine-agnostic core).
 * Pitch-ladder audio, haptics, combo helpers. No Phaser/three imports here;
 * games pass values in (e.g. from the DAG: combo_pitch_factor).
 */

export class Sfx {
  private ctx: AudioContext | null = null;
  enabled = true;

  private ac(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const AC = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Short square-wave blip. freq in Hz, dur seconds. */
  blip(freq = 440, dur = 0.07, gain = 0.12): void {
    const ctx = this.ac();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Combo blip: base pitch × factor (feed DAG combo_pitch_factor). */
  comboBlip(factor = 1): void {
    this.blip(330 * Math.max(0.5, Math.min(factor, 3)));
  }

  horn(): void {
    const ctx = this.ac();
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const f of [220, 277]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.08, t);
      g.gain.setValueAtTime(0.08, t + 0.18);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.32);
    }
  }

  thud(lowHz = 90): void {
    this.blip(lowHz, 0.16, 0.2);
  }
}

export const haptic = (pattern: number | number[]): void => {
  const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
  nav.vibrate?.(pattern);
};

/** Format a near-miss line: how close the closest-to-full bus was. */
export const nearMissLine = (busColorName: string, needed: number): string =>
  needed <= 0
    ? 'The street jammed with a bus ready to leave!'
    : `${needed} passenger${needed === 1 ? '' : 's'} from clearing the ${busColorName} bus`;
