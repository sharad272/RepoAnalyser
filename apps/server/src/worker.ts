import { parentPort, workerData } from 'worker_threads';
import { analyze } from '../../../packages/analyzer/src/analyze.js';

export interface WorkerInput {
  dir: string;
  name: string;
  source: string;
}

export type WorkerOutput =
  | { type: 'progress'; message: string }
  | { type: 'done'; result: Awaited<ReturnType<typeof analyze>> }
  | { type: 'error'; message: string };

const input = workerData as WorkerInput;
const send = (m: WorkerOutput) => parentPort!.postMessage(m);

analyze(input.dir, input.name, input.source, (message) => send({ type: 'progress', message }))
  .then((result) => send({ type: 'done', result }))
  .catch((e: unknown) => send({ type: 'error', message: e instanceof Error ? e.message : String(e) }));
