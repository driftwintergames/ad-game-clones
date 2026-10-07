import { parseDagFiles, type DagDefinitions } from './dag_parser.js';

/**
 * Stitcher — build-time DAG merge.
 *
 * Per game: parse 00_shared.dag + dag/<game>/*.dag into one DagDefinitions
 * graph and emit games/<game>/src/generated/dag.json. Overlap is a
 * compile-time property; separation is a runtime fact — no game ever loads
 * another game's graph.
 *
 * Usage: node dist/stitcher.js [--root <repoRoot>] [--games a,b | all]
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface StitchOptions {
  root: string;
  games: string[];
}

export const listGames = (root: string): string[] => {
  const dagRoot = join(root, 'dag');
  return readdirSync(dagRoot, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== '00_shared.dag')
    .map(e => e.name);
};

export const stitchGame = (root: string, game: string): { nodes: number; out: string } => {
  const files: Record<string, string> = {};
  const shared = join(root, 'dag', '00_shared.dag');
  files['00_shared.dag'] = readFileSync(shared, 'utf-8');
  const gameDir = join(root, 'dag', game);
  for (const f of readdirSync(gameDir).filter(f => f.endsWith('.dag'))) {
    files[`${game}/${f}`] = readFileSync(join(gameDir, f), 'utf-8');
  }
  const defs: DagDefinitions = parseDagFiles(files);

  // Namespacing audit: game files may read shared tokens; shared may not read
  // game tokens. game-prefix is the convention; we warn on obvious violations.
  const gamePrefix = `${game.replace(/-/g, '_')}_`;
  const warnings: string[] = [];
  const ids = new Set([
    ...Object.keys(defs.vars),
    ...Object.keys(defs.calcs),
    ...Object.keys(defs.defs),
  ]);
  for (const id of ids) {
    if (id.startsWith(gamePrefix)) continue;
    // A non-prefixed DEF/VAR in a game file is allowed (entity ids like
    // colors/buses are game-local) but CALCs that reference other games'
    // prefixes would leak. Cheap heuristic: flag any token containing another
    // game's prefix.
    for (const other of listGames(root)) {
      if (other === game) continue;
      const otherPrefix = `${other.replace(/-/g, '_')}_`;
      if (id.startsWith(otherPrefix)) warnings.push(`${game} references ${id} (belongs to ${other})`);
    }
  }

  const outDir = join(root, 'games', game, 'src', 'generated');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'dag.json');
  writeFileSync(out, JSON.stringify(defs));
  const nodes =
    Object.keys(defs.vars).length +
    Object.keys(defs.calcs).length +
    Object.keys(defs.defs).length +
    Object.keys(defs.costs).length;
  if (warnings.length) console.warn(`[stitcher] ${game}: ${warnings.join('; ')}`);
  return { nodes, out };
};

export const stitchAll = (opts: StitchOptions): void => {
  const games = opts.games.includes('all') ? listGames(opts.root) : opts.games;
  for (const g of games) {
    const { nodes, out } = stitchGame(opts.root, g);
    console.log(`[stitcher] ${g}: ${nodes} nodes -> ${out}`);
  }
};

// CLI entry (when run directly)
if (process.argv[1] && process.argv[1].endsWith('stitcher.js')) {
  const args = process.argv.slice(2);
  let root = process.cwd();
  const rootIdx = args.indexOf('--root');
  if (rootIdx >= 0 && args[rootIdx + 1]) root = resolve(args[rootIdx + 1]);
  let games = ['all'];
  const gamesIdx = args.indexOf('--games');
  if (gamesIdx >= 0 && args[gamesIdx + 1]) games = args[gamesIdx + 1].split(',');
  stitchAll({ root, games });
}
