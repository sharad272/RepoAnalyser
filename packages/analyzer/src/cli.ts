#!/usr/bin/env node
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { analyze } from './analyze.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const DEFAULT_OUT = path.join(REPO_ROOT, 'apps/web/public/graphs');
const CLONE_DIR = path.join(REPO_ROOT, '.cache/repos');

function usage(): never {
  console.log(`Usage:
  tesseract analyze <path | git-url | owner/repo> [name] [--out <dir>]

Examples:
  tesseract analyze .
  tesseract analyze https://github.com/expressjs/express
  tesseract analyze spring-projects/spring-petclinic petclinic`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const [cmd, target, ...rest] = argv;
  if (cmd !== 'analyze' || !target) usage();
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[++i];
    else positional.push(rest[i]);
  }
  // A positional name survives `npm run analyze` under shells (PowerShell) that swallow `--`.
  return { target, name: opts.name ?? positional[0], out: opts.out ?? DEFAULT_OUT };
}

function resolveSource(target: string): { dir: string; name: string; source: string } {
  if (existsSync(target)) {
    const dir = path.resolve(target);
    return { dir, name: path.basename(dir), source: dir };
  }
  let url = target;
  if (/^[\w.-]+\/[\w.-]+$/.test(target)) url = `https://github.com/${target}`;
  if (!/^(https?:\/\/|git@)/.test(url)) throw new Error(`Not a path or git URL: ${target}`);
  const m = url.replace(/\.git$/, '').match(/[/:]([\w.-]+)\/([\w.-]+)$/);
  const name = m ? m[2] : 'repo';
  const dir = path.join(CLONE_DIR, m ? `${m[1]}__${m[2]}` : name);
  if (!existsSync(dir)) {
    console.log(`cloning ${url} ...`);
    execFileSync('git', ['clone', '--depth', '1', '--quiet', url, dir], { stdio: 'inherit' });
  }
  return { dir, name, source: url };
}

async function main() {
  const { target, name: nameOpt, out } = parseArgs(process.argv.slice(2));
  const { dir, name: detected, source } = resolveSource(target);
  const name = (nameOpt ?? detected).replace(/[^\w.-]/g, '_');
  const t0 = Date.now();
  const { graph, sources } = await analyze(dir, name, source, (m) => console.log(`  ${m}`));

  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, `${name}.graph.json`), JSON.stringify(graph));
  await fs.writeFile(path.join(out, `${name}.src.json`), JSON.stringify(sources));

  const indexPath = path.join(out, 'index.json');
  let index: Array<{ name: string }> = [];
  try {
    index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  } catch {}
  index = index.filter((e) => e.name !== name);
  index.unshift({ name, source, generatedAt: graph.meta.generatedAt, stats: graph.meta.stats, languages: graph.meta.languages } as never);
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

  const s = graph.meta.stats;
  console.log(`\n${name}: ${s.files} files, ${s.symbols} symbols, ${s.calls} calls, ${s.imports} imports, ${s.flows} flows (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(`parsers: ${Object.entries(graph.meta.parser).map(([l, p]) => `${l}=${p}`).join(', ')}`);
  console.log(`wrote ${path.relative(process.cwd(), path.join(out, `${name}.graph.json`))}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
