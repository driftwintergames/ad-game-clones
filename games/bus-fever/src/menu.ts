import Phaser from 'phaser';
import { DagRuntime } from '@adgc/dag-kernel/runtime';
import dagDefs from './generated/dag.json';

const SAVE_KEY = 'agc:bus-fever';
const TOTAL_LEVELS = 20;

/** Level selector: grid of levels, locked/unlocked, coins + streak display. */
export class MenuScene extends Phaser.Scene {
  private rt!: DagRuntime;
  private buttons: Phaser.GameObjects.Container[] = [];

  constructor() { super('menu'); }

  create(): void {
    const json = dagDefs as unknown as ConstructorParameters<typeof DagRuntime>[0];
    this.rt = new DagRuntime(json, this.loadSave());
    const unlocked = Math.max(1, Math.floor(this.rt.get('bus_fever_level') || 1));
    const coins = Math.floor(this.rt.get('coin') || 0);
    const streak = Math.floor(this.rt.get('bus_fever_streak') || 0);

    const w = this.scale.width;
    this.add.text(w / 2, 64, 'BUS FEVER', {
      fontFamily: 'monospace', fontSize: '30px', color: '#f0c33c'
    }).setOrigin(0.5);
    this.add.text(w / 2, 92, `${coins} 🪙 · streak ×${streak}`, {
      fontFamily: 'monospace', fontSize: '13px', color: '#8a94a8'
    }).setOrigin(0.5);
    this.add.text(w / 2, 118, unlocked > 1 ? `level ${unlocked - 1} cleared` : 'start driving', {
      fontFamily: 'monospace', fontSize: '11px', color: '#4a5568'
    }).setOrigin(0.5);

    const cols = 4;
    const bw = Math.min(72, (w - 40 - (cols - 1) * 12) / cols);
    const bh = 60;
    const x0 = (w - (cols * bw + (cols - 1) * 12)) / 2 + bw / 2;
    const y0 = 168;

    for (let i = 0; i < TOTAL_LEVELS; i++) {
      const lvl = i + 1;
      const open = lvl <= unlocked;
      const cx = x0 + (i % cols) * (bw + 12);
      const cy = y0 + Math.floor(i / cols) * (bh + 12);

      const c = this.add.container(cx, cy);
      const tight = lvl % 5 === 0;
      const body = this.add.rectangle(0, 0, bw, bh, open ? 0x161c27 : 0x11151d, open ? 1 : 0.6)
        .setStrokeStyle(2, open ? (tight ? 0xf08a3c : 0x58c07a) : 0x232c3d);
      const num = this.add.text(0, tight ? -8 : -6, open ? String(lvl) : '🔒', {
        fontFamily: 'monospace', fontSize: '22px', color: open ? '#e8ecf4' : '#4a5568'
      }).setOrigin(0.5);
      c.add([body, num]);
      if (open && tight) {
        c.add(this.add.text(0, 14, '1 bay', {
          fontFamily: 'monospace', fontSize: '10px', color: '#f08a3c'
        }).setOrigin(0.5));
      }
      if (open) {
        body.setInteractive({ useHandCursor: true });
        body.on('pointerdown', () => {
          this.cameras.main.fade(160, 16, 20, 28);
          this.cameras.main.once('camerafadeoutcomplete', () =>
            this.scene.start('bus-fever', { level: lvl }));
        });
        c.add(this.add.rectangle(0, 0, bw, bh, 0xffffff, 0.001));
      }
      this.buttons.push(c);
    }
    (window as unknown as { __menu?: MenuScene }).__menu = this;
  }

  private loadSave(): Record<string, number> {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* fresh */ }
    return {};
  }
}
