// Produces Vercel's Build Output API layout (.vercel/output) at the repo root:
// the static web app plus one bundled Node function serving /api/*.
import { build } from 'esbuild';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { GRAMMARS } from '../../packages/analyzer/src/languages.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.join(root, '.vercel/output');
const func = path.join(out, 'functions/api.func');
const require = createRequire(path.join(root, 'packages/analyzer/package.json'));

await fs.rm(out, { recursive: true, force: true });

execSync('npm run build -w @tesseract/web', { cwd: root, stdio: 'inherit' });
await fs.cp(path.join(root, 'apps/web/dist'), path.join(out, 'static'), { recursive: true, filter: (src) => !src.endsWith('.src.json') });

await build({
  entryPoints: [path.join(here, 'src/vercel.ts')],
  outfile: path.join(func, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  minify: true,
  // extract.ts only reads import.meta.url when no wasm location was configured, which vercel.ts always does.
  logOverride: { 'empty-import-meta': 'silent' },
});

const wasm = path.join(func, 'wasm');
await fs.mkdir(wasm, { recursive: true });
await fs.copyFile(path.join(path.dirname(require.resolve('web-tree-sitter')), 'tree-sitter.wasm'), path.join(wasm, 'tree-sitter.wasm'));
const grammarDir = path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
for (const g of GRAMMARS) await fs.copyFile(path.join(grammarDir, `tree-sitter-${g}.wasm`), path.join(wasm, `tree-sitter-${g}.wasm`));

await fs.writeFile(
  path.join(func, '.vc-config.json'),
  JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.js', launcherType: 'Nodejs', shouldAddHelpers: false, supportsResponseStreaming: true, maxDuration: 300 }, null, 2),
);

await fs.writeFile(
  path.join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/assets/(.*)$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
        { handle: 'filesystem' },
        { src: '^/api/(.*)$', dest: '/api?__path=$1' },
        { src: '^/(?!api/).*$', dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
);
console.log(`built .vercel/output (${GRAMMARS.length} grammars)`);
