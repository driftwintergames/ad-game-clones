import Phaser from 'phaser';
import { DagRuntime } from '@adgc/dag-kernel/runtime';
import { Sfx, haptic } from '@adgc/juice';
import dagDefs from './generated/dag.json';

/**
 * Bus Fever v2 — parking-lot escape + ordered color queue.
 * Canonical gameplay: vault "Ad Game Clones/bus-fever-gameplay.md".
 * Lot: columns of nose-in spots; bottom vehicle of a column is dispatchable.
 * Tap dispatch → bus drives to a free bay → boards matching passengers from
 * the ordered queue → departs full. Queue overflow = fail. Empty lot = win.
 */

const COLORS = [
  { name: 'red', hex: 0xe4574c },
  { name: 'blue', hex: 0x4c9be4 },
  { name: 'yellow', hex: 0xf0c33c },
  { name: 'green', hex: 0x58c07a },
  { name: 'purple', hex: 0xa06be0 },
  { name: 'orange', hex: 0xf08a3c }
];

const SAVE_KEY = 'agc:bus-fever';

type VState = 'parked' | 'driving' | 'bay' | 'departing' | 'gone';

interface Vehicle {
  id: number;
  kind: 'bus' | 'car';
  colorIdx: number;
  cap: number;
  on: number;
  col: number;
  row: number; // 0 = bottom spot (nearest exit lane)
  state: VState;
  bayIdx: number;
  sprite?: Phaser.GameObjects.Container;
}

interface Bay { idx: number; x: number; y: number; occupant: Vehicle | null; }

export class BusFeverScene extends Phaser.Scene {
  private rt!: DagRuntime;
  private sfx = new Sfx();
  private vehicles: Vehicle[] = [];
  private lotCols = 4;
  private lotBottomY = 0;
  private spotW = 0; private spotH = 0;
  private bays: Bay[] = [];
  private queue: number[] = [];
  private queueCap = 12;
  private nextArrival = 0;
  private boardTimer = 0;
  private level = 1; private streak = 0; private coins = 0;
  private running = false;
  private hud!: Record<string, HTMLElement>;
  private overlay!: HTMLElement;
  private queueGfx?: Phaser.GameObjects.Container;
  private nextId = 1;

  constructor() { super('bus-fever'); }

  create(): void {
    const json = dagDefs as unknown as ConstructorParameters<typeof DagRuntime>[0];
    this.rt = new DagRuntime(json, this.loadSave());
    this.hud = {
      queued: document.getElementById('hud-queued')!,
      goal: document.getElementById('hud-goal')!,
      level: document.getElementById('hud-level')!,
      streak: document.getElementById('hud-streak')!
    };
    this.overlay = document.getElementById('overlay')!;
    document.getElementById('ov-btn')!.onclick = () => this.retry();
    this.scale.on('resize', () => this.layout());
    this.startLevel(Math.max(1, Math.floor(this.rt.get('bus_fever_level') || 1)));
    (window as unknown as { __bf?: BusFeverScene }).__bf = this; // test hook
  }

  // —— level construction ——

  private startLevel(level: number): void {
    this.level = level;
    this.rt.setState({ bus_fever_level: level });
    this.vehicles = [];
    this.queue = [];
    this.bays = [];
    this.nextId = 1;

    const nVeh = Math.floor(this.rt.get('bus_fever_buses') || 4);
    const colorsN = Math.max(1, Math.min(COLORS.length, Math.floor(this.rt.get('bus_fever_colors') || 3)));
    const capBase = Math.floor(this.rt.get('bus_fever_capacity') || 4);
    const nCars = Math.floor(this.rt.get('bus_fever_cars') || 0);
    const baysN = Math.max(1, Math.floor(this.rt.get('bus_fever_bays') || 2));
    this.queueCap = Math.floor(this.rt.get('bus_fever_queue_cap') || 12);

    // build vehicles: buses (+cars as cap-1 vehicles)
    for (let i = 0; i < nVeh; i++) {
      this.vehicles.push({
        id: this.nextId++, kind: 'bus', colorIdx: Math.floor(Math.random() * colorsN),
        cap: capBase, on: 0, col: 0, row: 0, state: 'parked', bayIdx: -1
      });
    }
    for (let i = 0; i < nCars; i++) {
      this.vehicles.push({
        id: this.nextId++, kind: 'car', colorIdx: Math.floor(Math.random() * colorsN),
        cap: 1, on: 0, col: 0, row: 0, state: 'parked', bayIdx: -1
      });
    }
    Phaser.Utils.Array.Shuffle(this.vehicles);

    // columns: distribute round-robin so columns stay balanced
    this.lotCols = Math.max(2, Math.min(5, Math.ceil(this.vehicles.length / 3)));
    const perCol = Math.ceil(this.vehicles.length / this.lotCols);
    this.vehicles.forEach((v, i) => {
      v.col = Math.floor(i / perCol);
      v.row = i % perCol; // 0 = bottom = exit-side
    });

    // bays
    for (let b = 0; b < baysN; b++) this.bays.push({ idx: b, x: 0, y: 0, occupant: null });

    // seed queue: one of each color present on the lot first (solvability head start), then uniform filler
    const lotColors = [...new Set(this.vehicles.map(v => v.colorIdx))];
    Phaser.Utils.Array.Shuffle(lotColors);
    this.queue.push(...lotColors);
    const seedN = Math.floor(this.rt.get('bus_fever_seed_queue') || 6);
    while (this.queue.length < Math.min(seedN, this.queueCap - 1))
      this.queue.push(Math.floor(Math.random() * colorsN));

    this.nextArrival = 2500;
    this.boardTimer = 0;
    this.running = true;
    this.overlay.classList.remove('show');
    this.layout();
    this.syncHud();
  }

  // —— layout / drawing ——

  private layout(): void {
    const w = this.scale.width, h = this.scale.height;
    this.lotBottomY = h * 0.42;
    this.spotW = Math.min(88, (w - 24 - (this.lotCols - 1) * 8) / this.lotCols);
    this.spotH = Math.min(52, (this.lotBottomY - 110) / 3.4);
    // bays along the right edge below the lot
    const bayY0 = this.lotBottomY + 70;
    this.bays.forEach((b, i) => { b.x = w - 70; b.y = bayY0 + i * 80; });
    this.redrawAll();
  }

  private redrawAll(): void {
    this.vehicles.forEach(v => { v.sprite?.destroy(); v.sprite = undefined; });
    this.vehicles.forEach(v => {
      if (v.state === 'gone') return;
      if (v.state === 'bay' || v.state === 'driving' || v.state === 'departing') {
        if (!v.sprite) v.sprite = this.makeVehicleSprite(v);
        const bay = this.bays[v.bayIdx];
        if (bay && v.state === 'bay') v.sprite.setPosition(bay.x, bay.y);
      } else {
        v.sprite = this.makeVehicleSprite(v);
        const p = this.spotPos(v.col, v.row);
        v.sprite.setPosition(p.x, p.y);
      }
    });
    this.drawQueue();
  }

  private spotPos(col: number, row: number): { x: number; y: number } {
    const w = this.scale.width;
    const colW = this.spotW + 8;
    const x0 = (w - (this.lotCols * colW - 8)) / 2 + this.spotW / 2;
    return { x: x0 + col * colW, y: this.lotBottomY - 26 - row * (this.spotH + 6) };
  }

  private makeVehicleSprite(v: Vehicle): Phaser.GameObjects.Container {
    const bw = this.spotW - 8;
    const bh = v.kind === 'bus' ? this.spotH : this.spotH * 0.66;
    const c = this.add.container(0, 0);
    const body = this.add.rectangle(0, 0, bw, bh, COLORS[v.colorIdx].hex, 0.28)
      .setStrokeStyle(3, COLORS[v.colorIdx].hex);
    const top = this.add.rectangle(0, -bh / 2 + 5, bw - 10, 8, COLORS[v.colorIdx].hex);
    const label = this.add.text(0, 2, v.kind === 'car' ? '🚗' : `${v.on}/${v.cap}`, {
      fontFamily: 'monospace', fontSize: '13px', color: '#e8ecf4'
    }).setOrigin(0.5);
    c.add([body, top, label]);
    c.setSize(bw, bh);
    const hit = this.add.rectangle(0, 0, bw + 6, bh + 6, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: true });
    hit.on('pointerdown', () => this.tapVehicle(v));
    c.add(hit);
    (c as unknown as { __label: Phaser.GameObjects.Text }).__label = label;
    return c;
  }

  private updateVehicleLabel(v: Vehicle): void {
    const lbl = (v.sprite as unknown as { __label?: Phaser.GameObjects.Text })?.__label;
    if (lbl && v.kind === 'bus') lbl.setText(`${v.on}/${v.cap}`);
  }

  // —— queue rendering ——

  private drawQueue(): void {
    this.queueGfx?.destroy();
    this.queueGfx = this.add.container(0, 0).setDepth(1);
    const w = this.scale.width;
    const y = this.scale.height - 64;
    const r = 8, gap = 19;
    const maxShow = Math.min(this.queue.length, Math.floor((w - 40) / gap));
    for (let i = 0; i < maxShow; i++) {
      const dot = this.add.circle(24 + i * gap, y, r, COLORS[this.queue[i]].hex, 0.95);
      if (i === 0) dot.setStrokeStyle(2, 0xffffff);
      this.queueGfx.add(dot);
    }
    if (this.queue.length > maxShow) {
      const more = this.add.text(24 + maxShow * gap, y, `+${this.queue.length - maxShow}`, {
        fontFamily: 'monospace', fontSize: '11px', color: '#8a94a8'
      }).setOrigin(0, 0.5);
      this.queueGfx.add(more);
    }
    // capacity floor line
    const line = this.add.rectangle(w / 2, y + 20, w - 48, 2, 0x232c3d);
    this.queueGfx.add(line);
  }

  // —— interactions ——

  private tapVehicle(v: Vehicle): void {
    if (!this.running || v.state !== 'parked') return;
    const blocker = this.blockerOf(v);
    if (blocker) {
      this.cameras.main.shake(80, 0.004);
      this.sfx.thud(70);
      // hint: flash the blocker
      if (blocker.sprite) {
        this.tweens.add({ targets: blocker.sprite, scaleX: 1.12, scaleY: 1.12, yoyo: true, duration: 90 });
      }
      return;
    }
    const bay = this.bays.find(b => !b.occupant);
    if (!bay) { this.cameras.main.shake(80, 0.004); this.sfx.thud(70); return; }
    this.dispatch(v, bay);
  }

  private blockerOf(v: Vehicle): Vehicle | null {
    return this.vehicles.find(o =>
      o !== v && o.col === v.col && o.state === 'parked' && o.row < v.row) ?? null;
  }

  private dispatch(v: Vehicle, bay: Bay): void {
    v.state = 'driving';
    v.bayIdx = bay.idx;
    bay.occupant = v;
    if (!v.sprite) v.sprite = this.makeVehicleSprite(v);
    v.sprite.setPosition(v.sprite.x, v.sprite.y).setDepth(5);
    this.tweens.add({
      targets: v.sprite,
      x: bay.x, y: bay.y,
      duration: 550,
      ease: 'Cubic.easeOut',
      onComplete: () => { v.state = 'bay'; this.updateVehicleLabel(v); }
    });
    this.sfx.blip(280, 0.08, 0.08);
    haptic(10);
  }

  // —— simulation ——

  update(time: number, delta: number): void {
    if (!this.running) return;

    // arrivals — only colors still needed can arrive (dead colors never flood
    // the queue), biased toward vehicles currently boarding in bays
    this.nextArrival -= delta;
    if (this.nextArrival <= 0) {
      if (this.queue.length >= this.queueCap) { this.failLevel(); return; }
      this.queue.push(this.pickArrivalColor());
      this.drawQueue();
      this.syncHud();
      this.nextArrival = (this.rt.get('bus_fever_arrival_interval') || 3.5) * 1000;
    }

    // boarding: each bay pulls front-most matching passenger every 450ms
    this.boardTimer -= delta;
    if (this.boardTimer <= 0) {
      this.boardTimer = 450;
      for (const bay of this.bays) {
        const v = bay.occupant;
        if (!v || v.state !== 'bay' || v.on >= v.cap) continue;
        const qi = this.queue.indexOf(v.colorIdx);
        if (qi >= 0) {
          this.queue.splice(qi, 1);
          v.on += 1;
          this.updateVehicleLabel(v);
          this.sfx.comboBlip(1 + v.on * 0.06);
          haptic(6);
          this.drawQueue();
          this.syncHud();
          if (v.on >= v.cap) this.depart(v);
        }
      }
    }

    // win: every vehicle gone
    if (this.vehicles.every(v => v.state === 'gone')) { this.winLevel(); return; }
  }

  /** Fair arrival pool: colors of vehicles that still need passengers
   *  (parked/driving/bay with room). 60% bias toward bay vehicles' colors. */
  private pickArrivalColor(): number {
    const needy = this.vehicles.filter(v => v.state !== 'gone' && v.state !== 'departing' && v.on < v.cap);
    if (!needy.length) return Math.floor(Math.random() * COLORS.length);
    const boarding = needy.filter(v => v.state === 'bay');
    const pool = boarding.length && Math.random() < 0.6 ? boarding : needy;
    return pool[Math.floor(Math.random() * pool.length)].colorIdx;
  }

  private depart(v: Vehicle): void {
    v.state = 'departing';
    this.sfx.horn();
    haptic([15, 30, 15]);
    const bay = this.bays[v.bayIdx];
    if (v.sprite) {
      this.tweens.add({
        targets: v.sprite,
        x: this.scale.width + 240,
        duration: 620,
        ease: 'Cubic.easeIn',
        onComplete: () => { v.sprite?.destroy(); v.sprite = undefined; v.state = 'gone'; }
      });
    }
    // popup
    const pop = this.add.text(bay.x, bay.y - 46, `${v.on} aboard ✓`, {
      fontFamily: 'monospace', fontSize: '13px', color: '#ffd23f'
    }).setOrigin(0.5).setDepth(9);
    this.tweens.add({ targets: pop, y: pop.y - 26, alpha: 0, duration: 750, onComplete: () => pop.destroy() });
    if (bay) bay.occupant = null;
  }

  // —— level flow ——

  private failLevel(): void {
    this.running = false;
    this.streak = 0;
    this.rt.setState({ bus_fever_streak: 0 });
    this.save();
    const parked = this.vehicles.filter(v => v.state !== 'gone').length;
    this.showOverlay('Queue Overflow!', `${parked} vehicle${parked === 1 ? '' : 's'} still parked — one more passenger and the line burst`, 'Retry');
    this.sfx.thud(60);
    haptic([60, 40, 60]);
  }

  private winLevel(): void {
    this.running = false;
    this.streak += 1;
    const coinsWon = Math.floor(this.rt.get('bus_fever_coins_win') || 30);
    this.coins += coinsWon;
    this.rt.setState({
      bus_fever_streak: this.streak,
      coin: this.coins,
      meta_xp: (this.rt.get('meta_xp') || 0) + this.level * 10,
      meta_level: this.autoMetaLevel()
    });
    this.save();
    this.showOverlay('Lot Cleared!', `+${coinsWon} coins · streak ×${this.streak}`, 'Next Level');
    this.sfx.horn();
  }

  private autoMetaLevel(): number {
    let lvl = this.rt.get('meta_level') || 1;
    let xp = this.rt.get('meta_xp') || 0;
    let guard = 0;
    while (xp >= this.rt.get('meta_level_xp_req') && guard++ < 99) {
      xp -= this.rt.get('meta_level_xp_req');
      lvl += 1;
      this.rt.setState({ meta_xp: xp, meta_level: lvl });
    }
    return lvl;
  }

  private retry(): void {
    this.startLevel(this.level + (this.lastWon ? 1 : 0));
  }

  private lastWon = false;

  private showOverlay(title: string, sub: string, btn: string): void {
    this.lastWon = btn === 'Next Level';
    document.getElementById('ov-title')!.textContent = title;
    document.getElementById('ov-sub')!.textContent = sub;
    document.getElementById('ov-btn')!.textContent = btn;
    this.overlay.classList.add('show');
  }

  private syncHud(): void {
    if (!this.hud) return;
    this.hud.queued.textContent = `${this.queue.length}/${this.queueCap}`;
    const left = this.vehicles.filter(v => v.state !== 'gone').length;
    this.hud.goal.textContent = `${left} left`;
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
    for (const k of ['bus_fever_level', 'bus_fever_streak', 'coin', 'meta_xp', 'meta_level'])
      if (s[k] !== undefined) keep[k] = s[k];
    localStorage.setItem(SAVE_KEY, JSON.stringify({ ...keep, __v: 2 }));
  }
}
