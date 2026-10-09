// DOM HUD: level/streak labels are canvas-drawn; buttons live here.

import { platform } from '../platform/platform';

export interface HudCallbacks {
  onUndo(): void;
  onPause(): void;
}

export class Hud {
  readonly root: HTMLDivElement;
  private undoBtn: HTMLButtonElement;
  private pauseBtn: HTMLButtonElement;

  constructor(parent: HTMLElement, cb: HudCallbacks) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.style.cssText =
      'position:fixed;top:0;left:0;right:0;height:64px;display:flex;' +
      'align-items:center;justify-content:flex-end;gap:10px;padding:0 12px;' +
      'box-sizing:border-box;z-index:20;pointer-events:none;';
    this.undoBtn = mkBtn('Undo', () => cb.onUndo());
    this.pauseBtn = mkBtn('||', () => cb.onPause());
    this.undoBtn.style.pointerEvents = 'auto';
    this.pauseBtn.style.pointerEvents = 'auto';
    this.root.appendChild(this.undoBtn);
    this.root.appendChild(this.pauseBtn);
    parent.appendChild(this.root);
    void platform;
  }

  setUndoEnabled(hasSnapshot: boolean): void {
    this.undoBtn.style.opacity = hasSnapshot ? '1' : '0.4';
    this.undoBtn.disabled = !hasSnapshot;
  }

  hide(): void { this.root.style.display = 'none'; }
  show(): void { this.root.style.display = 'flex'; }
}

function mkBtn(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText =
    'width:44px;height:44px;border:none;border-radius:10px;background:#1E232A;' +
    'color:#F4F1EA;font:600 14px "Avenir Next","Segoe UI",sans-serif;cursor:pointer;';
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}
