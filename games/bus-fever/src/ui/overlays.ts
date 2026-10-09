// Pause sheet, win card, fail card (spec §8, §10.2).

export interface OverlayTexts {
  pauseTitle: string;
  resume: string;
  restart: string;
  sound: string;
  haptics: string;
  bestLabel: string;
}

export class Overlays {
  private sheet: HTMLDivElement | null = null;
  private card: HTMLDivElement | null = null;

  showPause(onResume: () => void, onRestart: () => void, onSound: (on: boolean) => void,
            onHaptics: (on: boolean) => void, sound: boolean, haptics: boolean, bestStreak: number): void {
    this.hidePause();
    const sheet = document.createElement('div');
    sheet.id = 'pause-sheet';
    sheet.style.cssText =
      'position:fixed;inset:0;background:rgba(14,16,19,0.7);z-index:40;' +
      'display:flex;align-items:center;justify-content:center;';
    const panel = document.createElement('div');
    panel.style.cssText =
      'background:#16191E;border:1px solid #3A414C;border-radius:16px;padding:28px 32px;' +
      'display:flex;flex-direction:column;gap:14px;min-width:240px;color:#F4F1EA;' +
      'font:600 16px "Avenir Next","Segoe UI",sans-serif;text-align:center;';
    const mk = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'padding:12px 18px;border:none;border-radius:10px;background:#1E232A;color:#F4F1EA;' +
        'font:600 16px "Avenir Next","Segoe UI",sans-serif;cursor:pointer;';
      b.addEventListener('click', fn);
      return b;
    };
    panel.appendChild(mk('Resume', onResume));
    panel.appendChild(mk('Restart', onRestart));
    const soundBtn = mk(`Sound: ${sound ? 'On' : 'Off'}`, () => {
      onSound(!sound);
      soundBtn.textContent = `Sound: ${!sound ? 'On' : 'Off'}`;
    });
    panel.appendChild(soundBtn);
    const hapBtn = mk(`Haptics: ${haptics ? 'On' : 'Off'}`, () => {
      onHaptics(!haptics);
      hapBtn.textContent = `Haptics: ${!haptics ? 'On' : 'Off'}`;
    });
    panel.appendChild(hapBtn);
    const best = document.createElement('div');
    best.textContent = `Best ${bestStreak}`;
    best.style.cssText = 'color:#8a94a8;font-weight:400;';
    panel.appendChild(best);
    sheet.appendChild(panel);
    document.body.appendChild(sheet);
    this.sheet = sheet;
  }

  hidePause(): void {
    this.sheet?.remove();
    this.sheet = null;
  }

  showCard(title: string, body: string, sub: string, onTap: () => void): void {
    this.hideCard();
    const card = document.createElement('div');
    card.id = 'result-card';
    card.style.cssText =
      'position:fixed;inset:0;background:rgba(14,16,19,0.7);z-index:50;' +
      'display:flex;align-items:center;justify-content:center;';
    const panel = document.createElement('div');
    panel.style.cssText =
      'background:#16191E;border:1px solid #3A414C;border-radius:16px;padding:32px 36px;' +
      'display:flex;flex-direction:column;gap:10px;min-width:260px;color:#F4F1EA;text-align:center;';
    const t = document.createElement('div');
    t.textContent = title;
    t.style.cssText = 'font:700 30px "Avenir Next","Segoe UI",sans-serif;';
    const b = document.createElement('div');
    b.textContent = body;
    b.style.cssText = 'font:400 15px "Avenir Next","Segoe UI",sans-serif;color:#c8cdd6;';
    const s = document.createElement('div');
    s.textContent = sub;
    s.style.cssText = 'font:600 14px "Avenir Next","Segoe UI",sans-serif;color:#F2C14E;margin-top:8px;';
    panel.appendChild(t); panel.appendChild(b); panel.appendChild(s);
    card.appendChild(panel);
    card.addEventListener('pointerdown', (e) => { e.stopPropagation(); onTap(); });
    document.body.appendChild(card);
    this.card = card;
  }

  hideCard(): void {
    this.card?.remove();
    this.card = null;
  }
}
