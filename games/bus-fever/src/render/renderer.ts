// 2D Canvas renderer (spec §4). Pure projection of sim state + overlay FX.

import type { EngineCtx } from '../core/engine';
import {
  BAYS, DESIGN_H, DESIGN_W, GATE_MARKER, HUD_H, LANE_RECT, QUEUE_ROWS,
  SURFACES, PALETTE, QUEUE_SLOT_SIZE, QUEUE_TOKEN_D, VEHICLE_H, VEHICLE_R,
  VEHICLE_W, colCenterX, rowCenterY, slotCenter,
} from '../core/constants';
import type { Vehicle } from '../core/types';

export interface FxState {
  shake: { vehicleId: number; until: number } | null;
  bayFlashUntil: number;
}

export interface RenderInput {
  ctx: EngineCtx;
  fx: FxState;
  now: number;          // wall-clock ms for fx decay
  levelId: number;
  streak: number;
  hint: boolean;        // show "Tap a bus with a clear path" until first dispatch
}

export class Renderer {
  private g: CanvasRenderingContext2D;
  scale = 1;
  offsetX = 0;
  offsetY = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.g = canvas.getContext('2d')!;
    this.resize();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const scale = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
    this.scale = scale;
    this.offsetX = (window.innerWidth - DESIGN_W * scale) / 2;
    this.offsetY = (window.innerHeight - DESIGN_H * scale) / 2;
    this.canvas.width = Math.round(DESIGN_W * scale * dpr);
    this.canvas.height = Math.round(DESIGN_H * scale * dpr);
    this.canvas.style.width = `${DESIGN_W * scale}px`;
    this.canvas.style.height = `${DESIGN_H * scale}px`;
    this.canvas.style.left = `${this.offsetX}px`;
    this.canvas.style.top = `${this.offsetY}px`;
  }

  draw(input: RenderInput): void {
    const g = this.g;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    g.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, 0, 0);
    g.fillStyle = SURFACES.background;
    g.fillRect(0, 0, DESIGN_W, DESIGN_H);
    this.drawHud(input);
    this.drawLot(input);
    this.drawLane();
    this.drawBays(input);
    this.drawQueue(input);
  }

  private drawHud(input: RenderInput): void {
    const g = this.g;
    g.fillStyle = SURFACES.hudText;
    g.font = '600 18px "Avenir Next", "Segoe UI", sans-serif';
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillText(`Level ${input.levelId}`, 16, 40);
    const center = input.hint
      ? 'Tap a bus with a clear path'
      : input.streak >= 2
        ? `Streak ${input.streak}`
        : '';
    g.textAlign = 'center';
    if (center) g.fillText(center, 195, 40);
    g.textAlign = 'left';
  }

  private drawLot(input: RenderInput): void {
    const g = this.g;
    for (let c = 0; c < 6; c++) {
      const cx = colCenterX(c);
      g.fillStyle = SURFACES.lotLane;
      g.fillRect(cx - 26, 64, 52, 224);
    }
    for (const v of input.ctx.core.vehicles) {
      if (v.phase === 'gone') continue;
      if (v.phase === 'parked') this.drawParked(g, v, input);
      else this.drawMoving(g, v, input);
    }
  }

  private drawParked(g: CanvasRenderingContext2D, v: Vehicle, input: RenderInput): void {
    const cx = colCenterX(v.column);
    const cy = rowCenterY(v.indexFromFront);
    if (cy < -40) return; // deep rows stay offscreen
    let shakeX = 0;
    if (input.fx.shake && input.fx.shake.vehicleId === v.id && input.now < input.fx.shake.until) {
      const t = (input.fx.shake.until - input.now) / 120;
      shakeX = Math.sin(t * Math.PI * 6) * 4;
    }
    this.drawVehicleBody(g, cx + shakeX, cy, v.color, 1);
    if (v.indexFromFront >= 2) {
      // peek row partially clipped by HUD — dim overlay handled by HUD redraw
    }
  }

  private drawMoving(g: CanvasRenderingContext2D, v: Vehicle, input: RenderInput): void {
    const core = input.ctx.core;
    const t = v.phase === 'driving' && v.driveStartedAt !== null && v.driveDuration
      ? Math.min(1, (core.simTime - v.driveStartedAt) / v.driveDuration)
      : 1;
    let x: number;
    let y: number;
    if (v.phase === 'driving') {
      // polyline: cell -> (colX, 306) -> gate -> bay
      const p = drivePath(v);
      const total = p.length - 1;
      const ft = t * total;
      const seg = Math.min(total - 1, Math.floor(ft));
      const frac = ft - seg;
      const a = p[seg];
      const b = p[seg + 1];
      x = a.x + (b.x - a.x) * frac;
      y = a.y + (b.y - a.y) * frac;
    } else {
      const bay = BAYS[v.bay ?? 0];
      const gone = v.goneAt !== null ? Math.min(1, (core.simTime - v.goneAt) / 400) : 0;
      x = bay.center.x + gone * (420 - bay.center.x);
      y = bay.center.y;
      if (gone >= 1) return;
    }
    this.drawVehicleBody(g, x, y, v.color, 1);
    // seat dots when boarding
    if (v.phase === 'boarding') {
      g.fillStyle = SURFACES.hudText;
      g.font = '600 11px "Avenir Next", "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.fillText(`${v.boarded}/${v.capacity}`, x, y + 30);
    }
  }

  private drawVehicleBody(
    g: CanvasRenderingContext2D, x: number, y: number, color: string, alpha: number,
  ): void {
    g.save();
    g.globalAlpha = alpha;
    g.fillStyle = color;
    roundRect(g, x - VEHICLE_W / 2, y - VEHICLE_H / 2, VEHICLE_W, VEHICLE_H, VEHICLE_R);
    g.fill();
    // windshield on bottom edge (nose pointing down)
    g.fillStyle = 'rgba(14,16,19,0.55)';
    roundRect(g, x - VEHICLE_W / 2 + 6, y + VEHICLE_H / 2 - 22, VEHICLE_W - 12, 14, 5);
    g.fill();
    g.restore();
  }

  private drawLane(): void {
    const g = this.g;
    g.fillStyle = SURFACES.lotLane;
    g.fillRect(LANE_RECT.x, LANE_RECT.y, LANE_RECT.w, LANE_RECT.h);
    g.fillStyle = SURFACES.gateMarker;
    g.fillRect(GATE_MARKER.x, GATE_MARKER.y, GATE_MARKER.w, GATE_MARKER.h);
  }

  private drawBays(input: RenderInput): void {
    const g = this.g;
    for (let b = 0; b < BAYS.length; b++) {
      const bay = BAYS[b];
      g.fillStyle = SURFACES.bayFill;
      g.fillRect(bay.rect.x, bay.rect.y, bay.rect.w, bay.rect.h);
      g.lineWidth = 2;
      g.strokeStyle = SURFACES.bayOutline;
      g.strokeRect(bay.rect.x, bay.rect.y, bay.rect.w, bay.rect.h);
    }
    if (input.now < input.fx.bayFlashUntil) {
      g.save();
      g.globalAlpha = 0.6 * ((input.fx.bayFlashUntil - input.now) / 120);
      g.lineWidth = 3;
      g.strokeStyle = SURFACES.hudText;
      for (const bay of BAYS) g.strokeRect(bay.rect.x, bay.rect.y, bay.rect.w, bay.rect.h);
      g.restore();
    }
  }

  private drawQueue(input: RenderInput): void {
    const g = this.g;
    const core = input.ctx.core;
    for (let c = 0; c < 6; c++) {
      for (let r = 0; r < QUEUE_ROWS; r++) {
        const s = slotCenter(c, r);
        g.fillStyle = SURFACES.queueSlot;
        g.fillRect(s.x - QUEUE_SLOT_SIZE / 2, s.y - QUEUE_SLOT_SIZE / 2, QUEUE_SLOT_SIZE, QUEUE_SLOT_SIZE);
      }
      const col = core.queues[c];
      for (let r = 0; r < col.length && r < QUEUE_ROWS; r++) {
        const s = slotCenter(c, r);
        g.fillStyle = PALETTE[col[r].color];
        g.beginPath();
        g.arc(s.x, s.y, QUEUE_TOKEN_D / 2, 0, Math.PI * 2);
        g.fill();
      }
      if (col.length > QUEUE_ROWS) {
        g.fillStyle = SURFACES.hudText;
        g.font = '600 12px "Avenir Next", "Segoe UI", sans-serif';
        g.textAlign = 'center';
        g.fillText(`+${col.length - QUEUE_ROWS}`, colCenterX(c), slotCenter(c, QUEUE_ROWS - 1).y + 34);
      }
    }
    // walkers: lerp from their queue slot to their bay
    const sim = core.simTime;
    for (const w of core.walkers) {
      const bay = BAYS[core.vehicles.find(v => v.id === w.vehicleId)?.bay ?? 0];
      if (w.departAt > sim) continue;
      const t = Math.min(1, (sim - w.departAt) / Math.max(1, w.arriveAt - w.departAt));
      const x = w.from.x + (bay.center.x - w.from.x) * t;
      const y = w.from.y + (bay.center.y - w.from.y) * t;
      g.fillStyle = PALETTE[w.color];
      g.beginPath();
      g.arc(x, y, QUEUE_TOKEN_D / 2, 0, Math.PI * 2);
      g.fill();
    }
  }
}

function drivePath(v: Vehicle): { x: number; y: number }[] {
  const cx = colCenterX(v.column);
  const start = { x: cx, y: rowCenterY(v.indexFromFront) };
  const elbow = { x: cx, y: 306 };
  const gate = { x: 195, y: 320 };
  const bay = BAYS[v.bay ?? 0].center;
  return [start, elbow, gate, bay];
}

function roundRect(
  g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
