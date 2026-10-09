// Shared constants (spec §3.2, §4) — palette, surfaces, geometry.

export type ColorName = 'red' | 'blue' | 'yellow' | 'green' | 'purple' | 'orange';

export const COLORS: readonly ColorName[] = ['red', 'blue', 'yellow', 'green', 'purple', 'orange'] as const;

export const PALETTE: Record<ColorName, string> = {
  red: '#E23D3D',
  blue: '#3D7BE2',
  yellow: '#F2C14E',
  green: '#3EBF6B',
  purple: '#8B5CF6',
  orange: '#F08A2C',
};

export const SURFACES = {
  background: '#16191E',
  lotLane: '#3A414C',
  gateMarker: 'rgba(244, 241, 234, 0.35)',
  bayFill: '#1E232A',
  bayOutline: '#3A414C',
  queueSlot: '#12151A',
  hudText: '#F4F1EA',
} as const;

// ── Board geometry (design px, 390×844 space) ──────────────────────────
export const DESIGN_W = 390;
export const DESIGN_H = 844;

export const COLS = 6;
export const LOT_CELL_W = 52;
export const LOT_CELL_H = 84;
export const LOT_GAP_X = 8;
export const LOT_GAP_Y = 6;
export const VEHICLE_W = 46;
export const VEHICLE_H = 76;
export const VEHICLE_R = 10;

export const HUD_H = 64;
export const LOT_TOP = 64;
export const LOT_BOTTOM = 288;
export const LANE_RECT = { x: 16, y: 288, w: 358, h: 36 };
export const GATE_MARKER = { x: 171, y: 312, w: 48, h: 16 };
export const GATE_WAYPOINT = { x: 195, y: 320 };
export const BAY_COUNT = 2;
export const BAYS = [
  { rect: { x: 105, y: 332, w: 85, h: 76 }, center: { x: 147.5, y: 370 } },
  { rect: { x: 200, y: 332, w: 85, h: 76 }, center: { x: 242.5, y: 370 } },
];
export const QUEUE_TOP = 424;
export const QUEUE_ROWS = 6;
export const QUEUE_PITCH = 42;
export const QUEUE_SLOT_SIZE = 36;
export const QUEUE_TOKEN_D = 28;
export const BOARD_COL = [2, 3] as const; // bay 0 ← col 2, bay 1 ← col 3

export const colCenterX = (c: number): number => 45 + c * 60;
export const rowCenterY = (i: number): number => 245 - i * 90;
export const slotCenter = (c: number, r: number): { x: number; y: number } => ({
  x: colCenterX(c),
  y: 450 + r * QUEUE_PITCH,
});
