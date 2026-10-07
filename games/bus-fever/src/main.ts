import { BusFeverScene } from './scene';

window.addEventListener('error', (e) => {
  console.error('BOOT-ERR', e.message, '@', e.filename, ':', e.lineno, '\n', e.error?.stack ?? '');
});

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#10141c',
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: '100%',
    height: '100%'
  },
  scene: [BusFeverScene]
};

new Phaser.Game(config);
