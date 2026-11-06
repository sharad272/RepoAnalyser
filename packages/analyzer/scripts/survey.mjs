// Summarizes what the workflow views will be able to show for each analyzed graph.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '../../../apps/web/public/graphs');
const names = process.argv.slice(2).length ? process.argv.slice(2) : JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).map((r) => r.name);

for (const name of names) {
  const g = JSON.parse(fs.readFileSync(path.join(dir, `${name}.graph.json`), 'utf8'));
  const n = g.nodes;
  const endpoints = n.filter((x) => x.layer === 'api' && x.entry && /^[A-Z]+ \//.test(x.entry)).length;
  const pages = n.filter((x) => x.entry?.startsWith('PAGE')).length;
  const entries = n.filter((x) => x.entry).length;
  const kinds = {};
  for (const f of g.flows) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
  const db = new Set(n.flatMap((x) => x.db ?? []));
  const ext = new Set(n.flatMap((x) => x.ext ?? []));
  const s = g.meta.stats;
  console.log(
    `${name.padEnd(22)} files=${s.files} langs=${Object.keys(g.meta.languages).join('/')}\n` +
      `  layers=${JSON.stringify(g.meta.layers)} entries=${entries} endpoints=${endpoints} pages=${pages} http=${s.http} calls=${s.calls}\n` +
      `  flows=${JSON.stringify(kinds)} db=[${[...db].slice(0, 6).join(', ')}] ext=${ext.size}`,
  );
}
