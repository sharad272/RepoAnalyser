// Vercel function: downloads a public repo archive (no git on Vercel), analyzes it in-process,
// and keeps results in Vercel Blob when a store is connected, else in /tmp.
import { BlobNotFoundError, get, put } from '@vercel/blob';
import fs from 'fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import os from 'os';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import * as tar from 'tar';
import { gzipSync } from 'zlib';
import { analyze } from '../../../packages/analyzer/src/analyze.js';
import { configureParsers } from '../../../packages/analyzer/src/extract.js';
import { allowedHosts, allowRequest, clientIp, parseRepoUrl, toRecord, UserError, type RepoRecord, type RepoRef } from './repo.js';

const HOSTS = allowedHosts(process.env.ALLOWED_HOSTS ?? 'github.com,bitbucket.org,codeberg.org,gitlab.com');
const MAX_REPO_MB = Number(process.env.MAX_REPO_MB ?? 150);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_HOURS ?? 24) * 3_600_000;
const RATE_LIMIT_PER_HOUR = Number(process.env.RATE_LIMIT_PER_HOUR ?? 12);
// Stop before Vercel's hard function limit so the client gets a readable error instead of a dropped stream.
const DEADLINE_MS = Number(process.env.ANALYZE_DEADLINE_MS ?? 270_000);
const TMP_STORE = path.join(os.tmpdir(), 'tesseract-store');
const UA = { 'user-agent': 'tesseract-analyzer' };

const wasm = path.join(__dirname, 'wasm');
configureParsers({ grammarDir: wasm, runtimeWasm: path.join(wasm, 'tree-sitter.wasm') });

// ---------- Storage ----------

// A connected store provides BLOB_STORE_ID (OIDC auth) or, on older setups, BLOB_READ_WRITE_TOKEN.
const useBlob = () => !!(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
const BLOB_ACCESS = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';

/** Raw bytes of a stored file, or null when it does not exist. */
async function readRaw(pathname: string): Promise<Buffer | null> {
  const local = await fs.readFile(path.join(TMP_STORE, pathname)).catch(() => null);
  if (local || !useBlob()) return local;
  try {
    const hit = await get(pathname, { access: BLOB_ACCESS, useCache: false });
    return hit?.stream ? Buffer.from(await new Response(hit.stream).arrayBuffer()) : null;
  } catch (e) {
    if (!(e instanceof BlobNotFoundError)) console.error(`[blob] read ${pathname}`, e);
    return null;
  }
}

async function readJson<T>(pathname: string): Promise<T | null> {
  const raw = await readRaw(pathname);
  try {
    return raw ? (JSON.parse(raw.toString('utf8')) as T) : null;
  } catch {
    return null;
  }
}

async function writeJson(pathname: string, value: unknown) {
  const body = JSON.stringify(value);
  // /tmp serves follow-up requests on this instance; Blob makes the result durable and shared across instances.
  const file = path.join(TMP_STORE, pathname);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
  if (useBlob()) {
    await put(pathname, body, { access: BLOB_ACCESS, addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' }).catch((e) =>
      console.error(`[blob] write ${pathname}`, e),
    );
  }
}

async function cached(key: string): Promise<RepoRecord | null> {
  const rec = await readJson<RepoRecord>(`records/${key}.json`);
  return rec && Date.now() - Date.parse(rec.generatedAt) <= CACHE_TTL_MS ? rec : null;
}

// ---------- Download ----------

async function archiveUrl(repo: RepoRef): Promise<string> {
  const [owner, name] = repo.path;
  switch (repo.host) {
    case 'github.com':
      return `https://codeload.github.com/${owner}/${name}/tar.gz/HEAD`;
    case 'codeberg.org':
      return `https://codeberg.org/${owner}/${name}/archive/HEAD.tar.gz`;
    case 'bitbucket.org': {
      const res = await fetch(`https://api.bitbucket.org/2.0/repositories/${owner}/${name}`, { headers: UA });
      if (!res.ok) throw new UserError('Could not find that repository. It may be private or not exist.');
      const branch = ((await res.json()) as { mainbranch?: { name?: string } }).mainbranch?.name ?? 'main';
      return `https://bitbucket.org/${owner}/${name}/get/${encodeURIComponent(branch)}.tar.gz`;
    }
    case 'gitlab.com': {
      const res = await fetch(`https://gitlab.com/api/v4/projects/${encodeURIComponent(repo.path.join('/'))}`, { headers: UA });
      if (!res.ok) throw new UserError('Could not find that repository. It may be private or not exist.');
      const { id, default_branch } = (await res.json()) as { id: number; default_branch?: string };
      return `https://gitlab.com/api/v4/projects/${id}/repository/archive.tar.gz?sha=${encodeURIComponent(default_branch ?? 'main')}`;
    }
    default:
      throw new UserError(`Repositories on ${repo.host} are not supported here.`);
  }
}

async function download(repo: RepoRef, dir: string) {
  const res = await fetch(await archiveUrl(repo), { headers: UA, redirect: 'follow' });
  if (res.status === 404) throw new UserError('Could not find that repository. It may be private or not exist.');
  if (repo.host === 'gitlab.com' && res.status === 406) throw new UserError('GitLab does not allow anonymous archive downloads. Use the Tesseract VS Code extension on a local clone instead.');
  if (!res.ok || !res.body) throw new UserError(`Could not download that repository (${res.status}).`);
  const limit = MAX_REPO_MB * 1e6;
  let bytes = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      cb(bytes > limit ? new UserError(`Repository archive is larger than ${MAX_REPO_MB} MB.`) : null, chunk);
    },
  });
  // Archives wrap everything in one top-level folder; links are skipped so nothing points outside `dir`.
  const extract = tar.x({ cwd: dir, strip: 1, filter: (_p, entry) => !('type' in entry) || entry.type === 'File' || entry.type === 'Directory' || entry.type === 'OldFile' });
  await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), cap, extract);
}

// ---------- Analysis ----------

async function runAnalysis(repo: RepoRef, emit: (event: string, data: unknown) => void): Promise<RepoRecord> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tesseract-'));
  try {
    emit('progress', { message: `Downloading ${repo.url}…` });
    await download(repo, dir);
    const { graph, sources } = await analyze(dir, repo.name, repo.url, (message) => emit('progress', { message }));
    emit('progress', { message: 'Saving results…' });
    const rec = toRecord(repo, graph.meta);
    await Promise.all([writeJson(`graphs/${repo.key}.graph.json`, graph), writeJson(`graphs/${repo.key}.src.json`, sources)]);
    await writeJson(`records/${repo.key}.json`, rec);
    return rec;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- HTTP ----------

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function handleAnalyze(req: IncomingMessage, res: ServerResponse, url: URL) {
  let repo: RepoRef;
  try {
    repo = parseRepoUrl(url.searchParams.get('url') ?? '', HOSTS);
  } catch (e) {
    return sendJson(res, 400, { error: (e as Error).message });
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 10_000);
  try {
    const hit = url.searchParams.get('refresh') === '1' ? null : await cached(repo.key);
    if (hit) return send('done', hit);
    if (!allowRequest(clientIp(req.headers, req.socket.remoteAddress), RATE_LIMIT_PER_HOUR)) {
      return send('failed', { message: 'Too many new analyses from your network in the last hour. Try again later.' });
    }
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new UserError('This repository is too large to analyze online. Use the Tesseract VS Code extension on a local clone instead.')), DEADLINE_MS);
    });
    try {
      send('done', await Promise.race([runAnalysis(repo, send), deadline]));
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    if (!(e instanceof UserError)) console.error(`[${repo.key}]`, e);
    send('failed', { message: e instanceof UserError ? e.message : 'Analysis failed for this repository.' });
  } finally {
    clearInterval(ping);
    res.end();
  }
}

async function handleGraph(req: IncomingMessage, res: ServerResponse, file: string) {
  const body = await readRaw(`graphs/${file}`);
  if (!body) return sendJson(res, 404, { error: 'not found' });
  // Graphs of large repos run to several MB; gzip keeps them well inside the function response limit.
  const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60', vary: 'accept-encoding', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
  res.end(gzip ? gzipSync(body) : body);
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // The route rewrite passes the original sub-path as `__path`.
    const route = url.searchParams.get('__path') ?? url.pathname.replace(/^\/api\/?/, '');
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    if (route === 'health') return sendJson(res, 200, { ok: true, storage: useBlob() ? 'blob' : 'tmp' });
    if (route === 'analyze') return await handleAnalyze(req, res, url);
    const graph = route.match(/^graphs\/([\w.-]+\.(?:graph|src)\.json)$/);
    if (graph) return await handleGraph(req, res, graph[1]);
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    else res.end();
  }
}
