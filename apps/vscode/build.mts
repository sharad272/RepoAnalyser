// Bundles the extension + analyzer worker, copies the tree-sitter wasm it needs, and embeds the built workflow UI.
import { build } from 'esbuild';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { GRAMMARS } from '../../packages/analyzer/src/languages.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const production = process.argv.includes('--production');
const dist = path.join(here, 'dist');
const media = path.join(here, 'media');
const webApp = path.resolve(here, '../web');
const require = createRequire(path.resolve(here, '../../packages/analyzer/package.json'));

await fs.rm(dist, { recursive: true, force: true });
await fs.rm(media, { recursive: true, force: true });

await build({
  entryPoints: { extension: path.join(here, 'src/extension.ts'), worker: path.join(here, 'src/worker.ts') },
  outdir: dist,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node16',
  external: ['vscode'],
  minify: production,
  sourcemap: !production,
  // extract.ts only reads import.meta.url when no wasm location was configured, which the worker always does.
  logOverride: { 'empty-import-meta': 'silent' },
});

const wasmOut = path.join(dist, 'wasm');
await fs.mkdir(wasmOut, { recursive: true });
await fs.copyFile(path.join(path.dirname(require.resolve('web-tree-sitter')), 'tree-sitter.wasm'), path.join(wasmOut, 'tree-sitter.wasm'));
const grammarDir = path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
for (const g of GRAMMARS) await fs.copyFile(path.join(grammarDir, `tree-sitter-${g}.wasm`), path.join(wasmOut, `tree-sitter-${g}.wasm`));

execSync('npm run build', { cwd: webApp, stdio: 'inherit' });
// Sample graphs from the standalone site are not part of the extension.
await fs.cp(path.join(webApp, 'dist'), path.join(media, 'web'), { recursive: true, filter: (src) => !src.includes(`${path.sep}graphs`) });

const size = async (dir: string): Promise<number> => {
  let total = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) total += e.isDirectory() ? await size(path.join(dir, e.name)) : (await fs.stat(path.join(dir, e.name))).size;
  return total;
};
console.log(`built extension: dist ${((await size(dist)) / 1e6).toFixed(1)} MB, media ${((await size(media)) / 1e6).toFixed(1)} MB, ${GRAMMARS.length} grammars`);
