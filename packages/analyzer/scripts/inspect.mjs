// Prints a readable summary of a generated graph: entry flows and their call trees.
import fs from 'fs';
const [file, maxFlows = '8'] = process.argv.slice(2);
const g = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = g.nodes;
console.log(g.meta.name, g.meta.stats);
for (const f of g.flows.slice(0, Number(maxFlows))) {
  console.log(`\n[${f.kind}] ${f.name}  (${f.steps.length} steps)`);
  for (const s of f.steps.slice(0, 12)) {
    const n = byId[s.n];
    const http = s.h ? `[HTTP ${s.h}] ` : '';
    const db = n.db ? `  {db: ${n.db.join(',')}}` : '';
    console.log(`${'  '.repeat(s.d + 1)}${http}${n.name}  <${n.layer}>  — ${n.path.split('#')[0]}:${n.start ?? ''}${db}`);
  }
}
