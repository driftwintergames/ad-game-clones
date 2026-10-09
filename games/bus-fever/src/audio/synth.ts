// WebAudio synthesizer (spec §10.1).

export type Cue = 'illegal' | 'hop' | 'horn' | 'arrive' | 'win' | 'fail';

export class Synth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  enabled = true;

  unlock(): void {
    if (this.ctx) return;
    const AC = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);
  }

  private osc(type: OscillatorType, freq: number, dur: number, when = 0, gain = 0.15, endFreq?: number): void {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (endFreq !== undefined) o.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  play(cue: Cue, semitone = 0): void {
    if (!this.enabled || !this.ctx) return;
    if (cue === 'illegal') this.osc('square', 140, 0.08);
    else if (cue === 'hop') this.osc('sine', 440 * Math.pow(2, semitone / 12), 0.09);
    else if (cue === 'horn') {
      this.osc('square', 220, 0.1);
      this.osc('square', 165, 0.1, 0.1);
    } else if (cue === 'arrive') this.osc('triangle', 180, 0.04);
    else if (cue === 'win') {
      this.osc('sine', 523, 0.12, 0);
      this.osc('sine', 659, 0.12, 0.12);
      this.osc('sine', 2 * 392, 0.12, 0.24);
      this.osc('sine', 1047, 0.12, 0.36);
    } else if (cue === 'fail') {
      this.osc('sawtooth', 200, 0.28, 0, 0.15, 80);
    }
  }
}
