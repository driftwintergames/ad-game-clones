import Phaser from 'phaser';
import { DagRuntime } from '@adgc/dag-kernel/runtime';
import { Sfx, haptic, nearMissLine } from '@adgc/juice';
import dagDefs from './generated/dag.json';

interface Passenger { color: number; x: number; y: number; sprite: Phaser.GameObjects.Rectangle & { dcol?: number }; }
interface Bus { color: number; name: string; fill: number; cap: number; on: number; slot: number; leaving: boolean; refillAt: number; }

const COLORS = [
  { name: 'red', color: 0xe4574c, fill: 0xe4574c },
  { name: 'blue', color: 0x4c9be4, fill: 0x4c9be4 },
  { name: 'yellow', color: 0xf0c33c, fill: 0xf0c33c },
  { name: 'green', color: 0x58c07a, fill: 0x58c07a },
  { name: 'purple', color: 0xa06be0, fill: 0xa06be0 },
  { name: 'orange', color: 0xf08a3c, fill: 0xf08a3c }
];

const SAVE_KEY = 'agc:bus-fever';

export class BusFeverScene extends Phaser.Scene {
  private rt!: DagRuntime;
  private sfx = new Sfx();
  private grid: (Passenger | null)[][] = [];
  private gridW = 5; private gridH = 8;
  private cell = 56; private pad = 8;
  private gridX = 0; private gridY = 0;
  private buses: Bus[] = [];
  private busSlotsY = 0;
  private nextArrival = 0;
  private boarded = 0; private goal = 30;
  private level = 1; private streak = 0; private coins = 0;
  private combo = 0; private comboTimer = 0;
  private running = false;
  private hud!: Record<string, HTMLElement>;
  private overlay!: HTMLElement;

  constructor() { super('bus-fever'); }

  create(): void {
    const json = dagDefs as unknown as ConstructorParameters<typeof DagRuntime>[0];
    this.rt = new DagRuntime(json, this.loadSave());
    this.rt.subscribe(() => this.syncHud());

    this.grid = Array.from({ length: this.gridH }, () => Array(this.gridW).fill(null));
    this.buildStatic();
    this.startLevel(this.rt.get('bus_fever_level') || 1, true);
    this.scale.on('resize', () => this.layout());
    (window as unknown as { __bf?: BusFeverScene }).__bf = this; // test hook
  }

  // —— static shell: street, grid frame, buses, HUD wiring ——
  private buildStatic(): void {
    this.add.rectangle(0, 0, 4000, 4000, 0x10141c).setOrigin(0).setDepth(-10);
    this.add.rectangle(0, 0, 4000, 90, 0x0b0e14).setOrigin(0).setDepth(-5); // HUD band
    this.hud = {
      queued: document.getElementById('hud-queued')!,
      goal: document.getElementById('hud-goal')!,
      level: document.getElementById('hud-level')!,
      streak: document.getElementById('hud-streak')!
    };
    this.overlay = document.getElementById('overlay')!;
    document.getElementById('ov-btn')!.onclick = () => this.retry();
    this.layout();
  }

  private layout(): void {
    const w = this.scale.width, h = this.scale.height;
    const cellAvailW = (w - 32 - (this.gridW - 1) * this.pad) / this.gridW;
    const availH = h - 90 - 170 - 24; // hud band + bus zone + margin
    const cellAvailH = (availH - (this.gridH - 1) * this.pad) / this.gridH;
    this.cell = Math.max(28, Math.min(64, Math.min(cellAvailW, cellAvailH)));
    this.gridX = (w - (this.gridW * this.cell + (this.gridW - 1) * this.pad)) / 2;
    this.gridY = 104;
    this.busSlotsY = h - 150;
    if (this.buses.length && this.busGfx.length) this.repositionBuses();
    this.drawGridFrame();
  }

  /** Move existing bus gfx to match a new canvas size (never resets contents). */
  private repositionBuses(): void {
    const w = this.scale.width;
    const slots = Math.max(this.buses.length, 1);
    const bw = Math.min(150, (w - 40 - (slots - 1) * 12) / slots);
    for (const g of this.busGfx) {
      const x = 20 + g.bus.slot * (bw + 12) + bw / 2;
      g.rect.setPosition(x, this.busSlotsY);
      g.cap.setPosition(x, this.busSlotsY);
      g.count.setPosition(x, this.busSlotsY + 22);
      g.win.setPosition(x, this.busSlotsY + 48);
      g.dots.setPosition(x, this.busSlotsY + 48);
      g.ring.setPosition(x, this.busSlotsY);
      g.hit.setPosition(x, this.busSlotsY);
    }
  }

  private drawGridFrame(): void {
    // lane lines
    const gfx = this.add.graphics().setDepth(-1);
    gfx.fillStyle(0x161c27, 1).fillRect(this.gridX - 10, this.gridY - 10,
      this.gridW * this.cell + (this.gridW - 1) * this.pad + 20,
      this.gridH * this.cell + (this.gridH - 1) * this.pad + 20);
  }

  // —— buses ——
  private drawBuses(): void {
    this.buses.forEach(bus => bus && this.destroyBusGfx(bus));
    this.buses = [];
    const slots = this.rt.level('bus_fever_slot4') >= 1 ? 4 : Math.max(3, this.rt.get('bus_fever_slots') || 3);
    const colorsN = Math.max(1, Math.min(COLORS.length, Math.floor(this.rt.get('bus_fever_colors') || 3)));
    const w = this.scale.width;
    const bw = Math.min(150, (w - 40 - (slots - 1) * 12) / slots);
    const cap = Math.floor(this.rt.get('bus_fever_capacity') || 8);
    for (let s = 0; s < slots; s++) {
      const cIdx = this.pickBusColor(colorsN);
      const bus: Bus = {
        color: COLORS[cIdx].color, name: COLORS[cIdx].name, fill: COLORS[cIdx].fill,
        cap, on: 0, slot: s, leaving: false, refillAt: 0
      };
      this.buses.push(bus);
      this.drawBus(bus, bw);
    }
  }

  private pickBusColor(colorsN: number): number {
    // weighted: 60% pick a color present in the queue (helps solvability)
    const waiting: number[] = [];
    this.forEachCell((p) => { waiting.push(p.color); });
    if (waiting.length && Math.random() < 0.6) {
      const hex = waiting[Math.floor(Math.random() * waiting.length)];
      const idx = COLORS.findIndex(cc => cc.color === hex);
      if (idx >= 0 && idx < colorsN) return idx;
    }
    return Math.floor(Math.random() * colorsN);
  }

  private busGfx: BusGfx[] = [];
  private drawBus(bus: Bus, bw: number): void {
    const w = this.scale.width;
    const x = 20 + bus.slot * (bw + 12) + bw / 2;
    const rect = this.add.rectangle(x, this.busSlotsY, bw, 86, bus.fill, 0.22)
      .setStrokeStyle(3, bus.fill).setDepth(2);
    const cap = this.add.rectangle(x, this.busSlotsY, bw - 10, 18, bus.fill).setDepth(3);
    const count = this.add.text(x, this.busSlotsY + 22, '0/' + bus.cap, {
      fontFamily: 'monospace', fontSize: '15px', color: '#e8ecf4'
    }).setOrigin(0.5).setDepth(4);
    const win = this.add.rectangle(x, this.busSlotsY + 48, bw - 16, 26, 0x0b0e14).setDepth(3);
    const dots = this.add.text(x, this.busSlotsY + 48, '', {
      fontFamily: 'monospace', fontSize: '13px', color: '#fff'
    }).setOrigin(0.5).setDepth(4);
    const ring = this.add.circle(x, this.busSlotsY, 50, 0xffffff, 0).setStrokeStyle(2, 0xffffff, 0.5).setDepth(1);
    const hit = this.add.rectangle(x, this.busSlotsY, bw + 16, 110, 0xffffff, 0.001).setInteractive({ useHandCursor: true });
    hit.on('pointerdown', () => this.tapBus(bus));
    this.busGfx.push({ bus, rect, cap, count, win, dots, ring, hit });
  }

  private destroyBusGfx(bus: Bus): void {
    this.busGfx.filter(g => g.bus === bus).forEach(g => {
      g.rect.destroy(); g.cap.destroy(); g.count.destroy(); g.win.destroy(); g.dots.destroy(); g.ring.destroy(); g.hit.destroy();
    });
    this.busGfx = this.busGfx.filter(g => g.bus !== bus);
  }

  // —— core actions ——
  private tapBus(bus: Bus): void {
    if (!this.running || bus.leaving) return;
    const matches = this.collectMatching(bus.color);
    if (matches.length === 0) {
      this.cameras.main.shake(90, 0.004);
      this.sfx.thud(70);
      return;
    }
    // board with stagger: front-of-grid first (nearest to street = bottom rows)
    const per = 70;
    matches.forEach((p, i) => {
      this.time.delayedCall(i * per, () => this.boardOne(bus, p));
    });
    this.combo += matches.length;
    this.comboTimer = 1.6;
  }

  private collectMatching(color: number): Passenger[] {
    const out: Passenger[] = [];
    // bottom row = street edge; board from the bottom up (walk-around feel)
    for (let r = this.gridH - 1; r >= 0; r--) {
      for (let c = 0; c < this.gridW; c++) {
        const p = this.grid[r][c];
        if (p && p.color === color) out.push(p);
      }
    }
    return out;
  }

  private boardOne(bus: Bus, p: Passenger): void {
    this.removeFromGrid(p);
    bus.on = Math.min(bus.cap, bus.on + 1);
    const g = this.busGfx.find(g => g.bus === bus)!;
    g.count.setText(`${bus.on}/${bus.cap}`);
    g.dots.setText('●'.repeat(bus.on));
    const pitch = this.rt.get('combo_pitch_factor') || 1;
    this.sfx.comboBlip(pitch);
    haptic(8);
    this.boarded++;
    if (bus.on >= bus.cap && !bus.leaving) this.depart(bus);
  }

  private depart(bus: Bus): void {
    bus.leaving = true;
    this.sfx.horn();
    haptic([20, 40, 20]);
    const g = this.busGfx.find(g => g.bus === bus)!;
    this.tweens.add({
      targets: [g.rect, g.cap, g.count, g.win, g.dots],
      x: this.scale.width + 200,
      duration: 520,
      ease: 'Cubic.easeIn',
      onComplete: () => {
        this.destroyBusGfx(bus);
        const idx = this.buses.indexOf(bus);
        if (idx >= 0) this.buses[idx] = { ...bus, on: 0, leaving: false, refillAt: this.time.now + (this.rt.get('bus_fever_refill_s') || 3) * 1000 };
      }
    });
    // coin fountain popup
    const popup = this.add.text(g.rect.x, g.rect.y - 60, `+${bus.cap} boarded`, {
      fontFamily: 'monospace', fontSize: '16px', color: '#ffd23f'
    }).setOrigin(0.5).setDepth(9);
    this.tweens.add({ targets: popup, y: popup.y - 40, alpha: 0, duration: 800, onComplete: () => popup.destroy() });
  }

  // —— arrivals / fail detection ——
  update(time: number, delta: number): void {
    if (!this.running) return;
    // combo decay
    if (this.comboTimer > 0) {
      this.comboTimer -= delta / 1000;
      if (this.comboTimer <= 0) this.combo = 0;
    }
    this.rt.setState({ combo: this.combo });
    // slot refills
    for (let i = 0; i < this.buses.length; i++) {
      const b = this.buses[i];
      if (b && b.refillAt && time >= b.refillAt && !this.busGfx.some(g => g.bus === b)) {
        const colorsN = Math.max(1, Math.min(COLORS.length, Math.floor(this.rt.get('bus_fever_colors') || 3)));
        const cIdx = this.pickBusColor(colorsN);
        const nb: Bus = { color: COLORS[cIdx].color, name: COLORS[cIdx].name, fill: COLORS[cIdx].fill, cap: Math.floor(this.rt.get('bus_fever_capacity') || 8), on: 0, slot: b.slot, leaving: false, refillAt: 0 };
        this.buses[i] = nb;
        this.drawBus(nb, Math.min(150, (this.scale.width - 40 - 11 * 12) / 4));
      }
    }
    // arrivals
    this.nextArrival -= delta;
    if (this.nextArrival <= 0) {
      this.spawnArrival();
      const interval = this.rt.get('bus_fever_arrival_interval') || 1.8;
      this.nextArrival = interval * 1000;
    }
    // deadlock / win check
    if (this.boarded >= this.goal) this.winLevel();
  }

  private spawnArrival(): void {
    const colorsN = Math.max(1, Math.min(COLORS.length, Math.floor(this.rt.get('bus_fever_colors') || 3)));
    // never spawn a color with no bus and no matching passengers for >10s — weighted spawn
    const busColors = new Set(this.buses.filter(b => b && !b.leaving).map(b => b!.color));
    let cIdx = Math.floor(Math.random() * colorsN);
    if (!busColors.has(COLORS[cIdx].color)) {
      const waiting = new Set(this.grid.flat().filter(Boolean).map((p: Passenger) => p!.color));
      if (!waiting.has(COLORS[cIdx].color)) {
        const pool = [...busColors];
        if (pool.length) {
          const found = COLORS.findIndex(cc => cc.color === pool[Math.floor(Math.random() * pool.length)]);
          if (found >= 0 && found < colorsN) cIdx = found;
        }
      }
    }
    const free = this.freeCells();
    if (free.length === 0) { this.failLevel(); return; }
    const [r, c] = free[Math.floor(Math.random() * free.length)];
    const x = this.gridX + c * (this.cell + this.pad) + this.cell / 2;
    const y = this.gridY + r * (this.cell + this.pad) + this.cell / 2;
    const p: Passenger = {
      color: COLORS[cIdx].color, x, y,
      sprite: this.add.rectangle(x, -30, this.cell - 10, this.cell - 10, COLORS[cIdx].color, 0.9)
        .setDepth(1) as Phaser.GameObjects.Rectangle & { dcol?: number }
    };
    p.sprite.dcol = c;
    this.grid[r][c] = p;
    this.tweens.add({
      targets: p.sprite,
      y,
      duration: 260,
      ease: 'Back.easeOut',
      onComplete: () => {
        this.tweens.add({ targets: p.sprite, scaleX: 1.06, scaleY: 0.94, yoyo: true, duration: 90 });
      }
    });
  }

  private freeCells(): [number, number][] {
    const out: [number, number][] = [];
    if (!this.grid.length) return out;
    for (let r = 0; r < this.gridH; r++) for (let c = 0; c < this.gridW; c++)
      if (!this.grid[r][c]) out.push([r, c]);
    return out;
  }

  private forEachCell(fn: (p: Passenger) => void): void {
    if (!this.grid.length) return;
    for (let r = 0; r < this.gridH; r++) for (let c = 0; c < this.gridW; c++) {
      const p = this.grid[r][c];
      if (p) fn(p);
    }
  }

  private removeFromGrid(p: Passenger): void {
    for (let r = 0; r < this.gridH; r++) for (let c = 0; c < this.gridW; c++)
      if (this.grid[r][c] === p) this.grid[r][c] = null;
    if (p.sprite) p.sprite.destroy();
  }

  // —— level flow ——
  private startLevel(level: number, fresh = false): void {
    this.level = level;
    this.rt.setState({ bus_fever_level: level });
    this.boarded = 0;
    this.goal = Math.floor(this.rt.get('bus_fever_goal') || 30);
    this.grid = Array.from({ length: this.gridH }, () => Array(this.gridW).fill(null));
    this.busGfx.forEach(g => { g.rect.destroy(); g.cap.destroy(); g.count.destroy(); g.win.destroy(); g.dots.destroy(); g.ring.destroy(); g.hit.destroy(); });
    this.busGfx = [];
    this.buses = [];
    this.gridW = 5; this.gridH = 8;
    this.layout();
    this.drawBuses();
    this.nextArrival = 800;
    this.combo = 0;
    this.running = true;
    this.overlay.classList.remove('show');
    if (fresh) {
      // pre-seed a few passengers so first tap is instant
      const colorsN = Math.floor(this.rt.get('bus_fever_colors') || 3);
      for (let i = 0; i < 8; i++) this.spawnArrival();
    }
    this.syncHud();
  }

  private failLevel(): void {
    if (!this.running) return;
    this.running = false;
    this.streak = 0;
    this.rt.setState({ bus_fever_streak: 0, combo: 0 });
    this.save();
    const closest = this.buses.filter(b => b && !b.leaving)
      .sort((a, b) => (b!.cap - b!.on) - (a!.cap - a!.on))[0];
    const needed = closest ? closest.cap - closest.on : 0;
    const frac = this.boarded / this.goal;
    const line = frac >= (this.rt.get('near_miss_window') || 0.85)
      ? nearMissLine(closest?.name ?? 'red', needed)
      : `${this.goal - this.boarded} passengers from the goal`;
    this.showOverlay('Street Jammed!', line, 'Retry');
    this.sfx.thud(60);
    haptic([60, 40, 60]);
  }

  private winLevel(): void {
    this.running = false;
    this.streak += 1;
    const coinsWon = 20 + this.level * 10;
    this.coins += coinsWon;
    this.rt.setState({
      bus_fever_streak: this.streak,
      coin: this.coins,
      meta_xp: (this.rt.get('meta_xp') || 0) + this.goal,
      meta_level: this.autoMetaLevel()
    });
    this.save();
    this.showOverlay('Level Clear!', `+${coinsWon} coins · streak ×${this.streak}`, 'Next Level');
    this.sfx.horn();
  }

  private autoMetaLevel(): number {
    let lvl = this.rt.get('meta_level') || 1;
    const req = () => this.rt.get('meta_level_xp_req');
    let xp = this.rt.get('meta_xp') || 0;
    while (xp >= req()) { xp -= req(); lvl += 1; }
    return lvl;
  }

  private retry(): void {
    if (this.boarded >= this.goal) this.startLevel(this.level + 1);
    else this.startLevel(this.level);
  }

  private showOverlay(title: string, sub: string, btn: string): void {
    document.getElementById('ov-title')!.textContent = title;
    document.getElementById('ov-sub')!.textContent = sub;
    document.getElementById('ov-btn')!.textContent = btn;
    this.overlay.classList.add('show');
  }

  private syncHud(): void {
    if (!this.hud) return;
    this.hud.queued.textContent = String(this.grid.flat().filter(Boolean).length);
    this.hud.goal.textContent = `${Math.min(this.boarded, this.goal)}/${this.goal}`;
    this.hud.level.textContent = `L${this.level}`;
    this.hud.streak.textContent = this.streak > 0 ? `🔥×${this.streak}` : '';
  }

  // —— persistence ——
  private loadSave(): Record<string, number> {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* fresh */ }
    return {};
  }

  private save(): void {
    const s = this.rt.getState();
    const keep: Record<string, number> = {};
    for (const k of ['bus_fever_level', 'bus_fever_streak', 'coin', 'meta_xp', 'meta_level',
      'bus_fever_rush_hour_level', 'bus_fever_slot4_level', 'bus_fever_slow_walker_level'])
      if (s[k] !== undefined) keep[k] = s[k];
    localStorage.setItem(SAVE_KEY, JSON.stringify({ ...keep, __v: 1 }));
  }
}

interface BusGfx {
  bus: Bus; rect: Phaser.GameObjects.Rectangle; cap: Phaser.GameObjects.Rectangle;
  count: Phaser.GameObjects.Text; win: Phaser.GameObjects.Rectangle; dots: Phaser.GameObjects.Text;
  ring: Phaser.GameObjects.Circle; hit: Phaser.GameObjects.Rectangle;
}
