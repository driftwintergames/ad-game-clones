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
  private lanes: number[][] = [];   // crowd array: column arrays of passengers (index 0 = front = boardable)
  private columnsN = 4;             // exposed columns (4-7 by level)
  private pattern: number[] = [];   // repeating color cycle that fills the hidden depth
  private patternPos = 0;
  private frontPerBus = 2;          // lane-fronts a bay bus may pull per boarding tick
  private queueCap = 520;           // crowd fail line
  private nextArrival = 0;
  private boardTimer = 0;
  private level = 1; private streak = 0; private coins = 0;
  private running = false;
  private hud!: Record<string, HTMLElement>;
  private overlay!: HTMLElement;
  private queueGfx?: Phaser.GameObjects.Container;
  private zoneGfx?: Phaser.GameObjects.Container;
  private nextId = 1;

  /** Visible fronts across lanes — what a bus can actually pull right now. */
  get queue(): number[] { return this.lanes.map(l => l[0]).filter(c => c !== undefined); }

  /** Total crowd (visible + hidden). */
  get crowdSize(): number { return this.lanes.reduce((n, l) => n + l.length, 0); }

  constructor() { super('bus-fever'); }

  private startAt = 0;

  init(data: { level?: number }): void {
    this.startAt = data?.level ?? 0;
  }

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
    document.getElementById('menu-btn')!.onclick = () => this.scene.start('menu');
    this.scale.on('resize', () => this.layout());
    this.startLevel(this.startAt || Math.max(1, Math.floor(this.rt.get('bus_fever_level') || 1)));
    (window as unknown as { __bf?: BusFeverScene }).__bf = this; // test hook
  }

  // —— level construction ——

  private startLevel(level: number): void {
    this.level = level;
    this.rt.setState({ bus_fever_level: level });
    this.vehicles = [];
    this.lanes = [];
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

    // —— crowd array: exposed lanes filled by a hidden repeating pattern ——
    this.columnsN = Math.max(4, Math.min(7, Math.floor(this.rt.get('bus_fever_columns') || 4)));
    const seedN = Math.floor(this.rt.get('bus_fever_seed_queue') || 200);
    // CRITICAL: pattern may only contain colors that exist as vehicles on this
    // lot — a dead color at a lane front can never be pulled (no bus matches),
    // blocking the lane forever and making the level unwinnable.
    const lotColors = [...new Set(this.vehicles.map(v => v.colorIdx))];
    Phaser.Utils.Array.Shuffle(lotColors);
    this.pattern = [...lotColors];
    this.patternPos = 0;
    const takePattern = (): number => {
      const c = this.pattern[this.patternPos % this.pattern.length];
      this.patternPos++;
      return c;
    };
    this.lanes = Array.from({ length: this.columnsN }, () => [] as number[]);
    let placed = 0;
    // visible fronts first (lot colors lead so the first bus always has riders)
    for (let lane = 0; placed < seedN; lane = (lane + 1) % this.columnsN) {
      const front = placed < lotColors.length ? lotColors[placed] : takePattern();
      this.lanes[lane].push(front);
      placed++;
    }
    this.queueCap = Math.floor(this.rt.get('bus_fever_queue_cap') || 520);
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
    this.lotBottomY = h * 0.46;
    this.spotW = Math.min(88, (w - 24 - (this.lotCols - 1) * 8) / this.lotCols);
    this.spotH = Math.min(52, (this.lotBottomY - 120) / 3.4);
    // bays along the right edge, below the lot
    const bayY0 = this.lotBottomY + 64;
    this.bays.forEach((b, i) => { b.x = w - 70; b.y = bayY0 + i * 80; });
    this.drawZones(w, h);
    this.redrawAll();
  }

  /** Tinted, labeled zones: BUS LOT / ACTIVE BUS ZONE / WAITING QUEUE. */
  private drawZones(w: number, h: number): void {
    this.zoneGfx?.destroy();
    const c = this.add.container(0, 0).setDepth(-1);
    this.zoneGfx = c;
    const queueTop = h - 118;
    const activeTop = this.lotBottomY + 26;
    const zone = (x: number, y: number, zw: number, zh: number, fill: number, label: string, alpha = 0.10) => {
      const r = this.add.rectangle(x + zw / 2, y + zh / 2, zw, zh, fill, alpha)
        .setStrokeStyle(2, fill, 0.55);
      const t = this.add.text(x + 10, y + 8, label, {
        fontFamily: 'monospace', fontSize: '11px', color: '#' + fill.toString(16).padStart(6, '0')
      }).setAlpha(0.9);
      c.add([r, t]);
    };
    // LOT: full width, from below HUD to lot bottom
    zone(8, 96, w - 16, this.lotBottomY - 88, 0x4c9be4, 'BUS LOT');
    // ACTIVE BUS ZONE: right strip from lot bottom to queue top
    zone(w - 156, activeTop, 148, queueTop - activeTop - 8, 0x58c07a, 'ACTIVE BUS ZONE');
    // WAITING QUEUE: bottom strip
    zone(8, queueTop, w - 16, 110, 0xf0c33c, 'WAITING QUEUE', 0.08);
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
    const zoneTop = this.scale.height - 118;
    const cw = Math.min(78, (w - 24 - (this.columnsN - 1) * 8) / this.columnsN);
    const x0 = (w - (this.columnsN * cw + (this.columnsN - 1) * 8)) / 2 + cw / 2;
    const frontY = this.scale.height - 52;
    for (let i = 0; i < this.columnsN; i++) {
      const lane = this.lanes[i] ?? [];
      const cx = x0 + i * (cw + 8);
      // faint column strip marks the boarding lane
      const strip = this.add.rectangle(cx, zoneTop + 64, cw, 92, 0xffffff, 0.03)
        .setStrokeStyle(1, 0x232c3d, 0.8);
      this.queueGfx!.add(strip);
      if (lane.length) {
        // front of lane: the only boardable passenger (ringed)
        const front = this.add.circle(cx, frontY, 15, COLORS[lane[0]].hex, 1)
          .setStrokeStyle(3, 0xffffff);
        this.queueGfx!.add(front);
        // preview: next in this lane
        if (lane.length > 1) {
          const nxt = this.add.circle(cx, frontY - 32, 9, COLORS[lane[1]].hex, 0.8);
          this.queueGfx!.add(nxt);
        }
        // hidden depth count (patterned mass)
        if (lane.length > 2) {
          const hid = this.add.text(cx, frontY - 52, `+${lane.length - 2}`, {
            fontFamily: 'monospace', fontSize: '11px', color: '#8a94a8'
          }).setOrigin(0.5);
          this.queueGfx!.add(hid);
        }
      } else {
        const empty = this.add.text(cx, frontY, '·', {
          fontFamily: 'monospace', fontSize: '16px', color: '#4a5568'
        }).setOrigin(0.5);
        this.queueGfx!.add(empty);
      }
    }
    const capTxt = this.add.text(w - 16, zoneTop + 6, `${this.crowdSize} in crowd · cap ${this.queueCap}`, {
      fontFamily: 'monospace', fontSize: '11px', color: '#8a94a8'
    }).setOrigin(1, 0);
    this.queueGfx.add(capTxt);
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

    // arrivals join the shortest lane; crowd cap = fail line
    this.nextArrival -= delta;
    if (this.nextArrival <= 0) {
      const shortest = this.lanes.reduce((a, b) => (b.length < a.length ? b : a), this.lanes[0]);
      if (!shortest || this.crowdSize >= this.queueCap) { this.failLevel(); return; }
      shortest.push(this.pickArrivalColor());
      this.drawQueue();
      this.syncHud();
      this.nextArrival = (this.rt.get('bus_fever_arrival_interval') || 3.5) * 1000;
    }

    // boarding: bus pulls matching passengers from lane FRONTS (the puzzle:
    // what's exposed), but if the crowd has ample supply (≥3 waiting of that
    // color anywhere), later rows also shuffle forward — a bus in a bay should
    // never deadlock while dozens of matching passengers stand in lane 3+
    this.boardTimer -= delta;
    if (this.boardTimer <= 0) {
      this.boardTimer = 450;
      for (const bay of this.bays) {
        const v = bay.occupant;
        if (!v || v.state !== 'bay' || v.on >= v.cap) continue;
        let pulled = 0;
        for (let li = 0; li < this.lanes.length && pulled < this.frontPerBus && v.on < v.cap; li++) {
          if (this.lanes[li][0] === v.colorIdx) {
            this.lanes[li].shift();
            v.on += 1;
            pulled++;
          }
        }
        if (!pulled) {
          // no matching front: pull from depth if supply is ample (shuffling queue)
          let depthSupply = 0;
          for (const lane of this.lanes) depthSupply += lane.filter(c => c === v.colorIdx).length;
          if (depthSupply >= 3) {
            for (const lane of this.lanes) {
              if (v.on >= v.cap) break;
              const di = lane.indexOf(v.colorIdx);
              if (di >= 0) { lane.splice(di, 1); v.on += 1; pulled++; if (pulled >= this.frontPerBus) break; }
            }
          }
        }
        if (pulled) {
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

  /** Arrival color: 60% bias to bay-boardable colors, else the repeating
   *  pattern advances (predictable hidden depth), else a needy color. */
  private pickArrivalColor(): number {
    const needy = this.vehicles.filter(v => v.state !== 'gone' && v.state !== 'departing' && v.on < v.cap);
    if (!needy.length) return this.patternAdvance();
    const boarding = needy.filter(v => v.state === 'bay');
    if (boarding.length && Math.random() < 0.6)
      return boarding[Math.floor(Math.random() * boarding.length)].colorIdx;
    if (Math.random() < 0.5) return this.patternAdvance();
    return needy[Math.floor(Math.random() * needy.length)].colorIdx;
  }

  private patternAdvance(): number {
    const c = this.pattern[this.patternPos % this.pattern.length];
    this.patternPos++;
    return c;
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
      bus_fever_level: this.level + 1, // unlock next level for the selector
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
    this.hud.queued.textContent = `${this.crowdSize}/${this.queueCap}`;
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
