import { MenuScene } from './menu';
import { BusFeverScene } from './scene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#10141c',
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: '100%',
    height: '100%'
  },
  scene: [MenuScene, BusFeverScene]
};

new Phaser.Game(config);
