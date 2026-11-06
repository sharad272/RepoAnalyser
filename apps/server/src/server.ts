import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { createGzip } from 'zlib';
import { allowedHosts, allowRequest, clientIp, parseRepoUrl, toRecord, UserError, type RepoRecord, type RepoRef } from './repo.js';
import type { WorkerInput, WorkerOutput } from './worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const WEB_DIR = path.resolve(process.env.WEB_DIR ?? path.join(here, '../../web/dist'));
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(here, '../../../.cache/server'));
const ALLOWED_HOSTS = allowedHosts();
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 2);
const CLONE_TIMEOUT_MS = Number(process.env.CLONE_TIMEOUT_MS ?? 120_000);
const ANALYZE_TIMEOUT_MS = Number(process.env.ANALYZE_TIMEOUT_MS ?? 300_000);
const MAX_REPO_MB = Number(process.env.MAX_REPO_MB ?? 400);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_HOURS ?? 24) * 3_600_000;
const RATE_LIMIT_PER_HOUR = Number(process.env.RATE_LIMIT_PER_HOUR ?? 12);
const workerFile = path.join(here, 'worker.js');

// ---------- Jobs ----------

type Listener = (event: string, data: unknown) => void;

interface Job {
  key: string;
  listeners: Set<Listener>;
  history: Array<[string, unknown]>;
  done: boolean;
}

const jobs = new Map<string, Job>();
const queue: Array<() => void> = [];
let running = 0;

function emit(job: Job, event: string, data: unknown) {
  job.history.push([event, data]);
  for (const l of job.listeners) l(event, data);
}

function slot(): Promise<() => void> {
  return new Promise((resolve) => {
    const start = () => {
      running++;
      resolve(() => {
        running--;
        queue.shift()?.();
      });
    };
    if (running < MAX_CONCURRENT) start();
    else queue.push(start);
  });
}

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(signal ? 'timed out' : out.trim().split('\n').pop() || `exit ${code}`));
    });
  });
}

async function dirSize(dir: string, limit: number): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) total += (await fs.stat(p)).size;
      if (total > limit) return total;
    }
  }
  return total;
}

function analyzeInWorker(input: WorkerInput, onProgress: (m: string) => void): Promise<Extract<WorkerOutput, { type: 'done' }>['result']> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, { workerData: input });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new UserError('Analysis took too long for this repository.'));
    }, ANALYZE_TIMEOUT_MS);
    worker.on('message', (m: WorkerOutput) => {
      if (m.type === 'progress') onProgress(m.message);
      else {
        clearTimeout(timer);
        void worker.terminate();
        if (m.type === 'done') resolve(m.result);
        else reject(new Error(m.message));
      }
    });
    worker.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function readIndex(): Promise<RepoRecord[]> {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, 'index.json'), 'utf8'));
  } catch {
    return [];
  }
}

let indexWrite = Promise.resolve();
function recordRepo(rec: RepoRecord) {
  indexWrite = indexWrite.then(async () => {
    const index = (await readIndex()).filter((r) => r.key !== rec.key);
    index.unshift(rec);
    await fs.writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify(index.slice(0, 200)));
  });
  return indexWrite;
}

async function cached(key: string): Promise<RepoRecord | null> {
  const rec = (await readIndex()).find((r) => r.key === key);
  if (!rec || Date.now() - Date.parse(rec.generatedAt) > CACHE_TTL_MS) return null;
  return existsSync(path.join(DATA_DIR, 'graphs', `${key}.graph.json`)) ? rec : null;
}

function startJob(repo: RepoRef): Job {
  const job: Job = { key: repo.key, listeners: new Set(), history: [], done: false };
  jobs.set(repo.key, job);
  void (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tesseract-'));
    const release = await (running >= MAX_CONCURRENT ? (emit(job, 'progress', { message: 'Waiting for a free analyzer…' }), slot()) : slot());
    try {
      emit(job, 'progress', { message: `Cloning ${repo.url}…` });
      try {
        await run('git', ['clone', '--depth', '1', '--single-branch', '--no-tags', '-c', 'core.symlinks=false', '-c', 'protocol.file.allow=never', '--', repo.url, dir], {
          timeoutMs: CLONE_TIMEOUT_MS,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        throw new UserError(/timed out/.test(msg) ? 'Cloning took too long; the repository may be too large.' : 'Could not clone that repository. It may be private or not exist.');
      }
      await fs.rm(path.join(dir, '.git'), { recursive: true, force: true });
      if ((await dirSize(dir, MAX_REPO_MB * 1e6)) > MAX_REPO_MB * 1e6) throw new UserError(`Repository is larger than ${MAX_REPO_MB} MB.`);
      const { graph, sources } = await analyzeInWorker({ dir, name: repo.name, source: repo.url }, (message) => emit(job, 'progress', { message }));
      await fs.mkdir(path.join(DATA_DIR, 'graphs'), { recursive: true });
      await fs.writeFile(path.join(DATA_DIR, 'graphs', `${repo.key}.graph.json`), JSON.stringify(graph));
      await fs.writeFile(path.join(DATA_DIR, 'graphs', `${repo.key}.src.json`), JSON.stringify(sources));
      const rec = toRecord(repo, graph.meta);
      await recordRepo(rec);
      emit(job, 'done', rec);
    } catch (e) {
      if (!(e instanceof UserError)) console.error(`[${repo.key}]`, e);
      emit(job, 'failed', { message: e instanceof UserError ? e.message : 'Analysis failed for this repository.' });
    } finally {
      release();
      job.done = true;
      jobs.delete(repo.key);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return job;
}

// ---------- HTTP ----------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, cache: string) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return false;
  const type = MIME[path.extname(file)] ?? 'application/octet-stream';
  const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) && /json|javascript|css|html|svg/.test(type);
  res.writeHead(200, { 'content-type': type, 'cache-control': cache, ...(gzip ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : { 'content-length': stat.size }) });
  const stream = createReadStream(file);
  (gzip ? stream.pipe(createGzip()) : stream).pipe(res);
  return true;
}

/** Resolves a URL path under `root`, refusing anything that escapes it. */
function safeJoin(root: string, urlPath: string) {
  const p = path.resolve(root, `.${path.posix.normalize(decodeURIComponent(urlPath))}`);
  return p === root || p.startsWith(root + path.sep) ? p : null;
}

async function handleAnalyze(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  let repo;
  try {
    repo = parseRepoUrl(url.searchParams.get('url') ?? '', ALLOWED_HOSTS);
  } catch (e) {
    return sendJson(res, 400, { error: (e as Error).message });
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const send: Listener = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  const close = () => {
    clearInterval(ping);
    res.end();
  };

  const hit = url.searchParams.get('refresh') === '1' ? null : await cached(repo.key);
  if (hit) {
    send('done', hit);
    return close();
  }
  let job = jobs.get(repo.key);
  if (!job) {
    if (!allowRequest(clientIp(req.headers, req.socket.remoteAddress), RATE_LIMIT_PER_HOUR)) {
      send('failed', { message: 'Too many new analyses from your network in the last hour. Try again later.' });
      return close();
    }
    job = startJob(repo);
  }
  for (const [event, data] of job.history) send(event, data);
  const listener: Listener = (event, data) => {
    send(event, data);
    if (event === 'done' || event === 'failed') {
      job!.listeners.delete(listener);
      close();
    }
  };
  job.listeners.add(listener);
  req.on('close', () => {
    job!.listeners.delete(listener);
    clearInterval(ping);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, running, queued: queue.length });
    if (url.pathname === '/api/analyze') return await handleAnalyze(req, res, url);
    const graph = url.pathname.match(/^\/api\/graphs\/([\w.-]+\.(?:graph|src)\.json)$/);
    if (graph) {
      if (await sendFile(req, res, path.join(DATA_DIR, 'graphs', graph[1]), 'public, max-age=300')) return;
      return sendJson(res, 404, { error: 'not found' });
    }
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

    const file = safeJoin(WEB_DIR, url.pathname === '/' ? '/index.html' : url.pathname);
    const immutable = url.pathname.startsWith('/assets/');
    if (file && (await sendFile(req, res, file, immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=60'))) return;
    // Client-side routes fall back to the app shell.
    if (!path.extname(url.pathname) && (await sendFile(req, res, path.join(WEB_DIR, 'index.html'), 'no-cache'))) return;
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    else res.end();
  }
});

await fs.mkdir(DATA_DIR, { recursive: true });
server.listen(PORT, () => console.log(`tesseract server on http://localhost:${PORT} (web: ${WEB_DIR}, data: ${DATA_DIR})`));
