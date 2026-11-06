// Bundles the server and its analyzer worker into plain ESM so production runs on bare Node.
import { build } from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: { server: path.join(here, 'src/server.ts'), worker: path.join(here, 'src/worker.ts') },
  outdir: path.join(here, 'dist'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // web-tree-sitter and tree-sitter-wasms locate their .wasm files relative to node_modules.
  packages: 'external',
  sourcemap: true,
});
console.log('built apps/server/dist');
