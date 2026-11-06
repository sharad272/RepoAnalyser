import { parentPort, workerData } from 'worker_threads';
import { analyze } from '../../../packages/analyzer/src/analyze.ts';
import { configureParsers } from '../../../packages/analyzer/src/extract.ts';

export interface WorkerInput {
  dir: string;
  name: string;
  grammarDir: string;
  runtimeWasm: string;
}

export type WorkerOutput =
  | { type: 'progress'; message: string }
  | { type: 'done'; result: Awaited<ReturnType<typeof analyze>> }
  | { type: 'error'; message: string };

const input = workerData as WorkerInput;
const send = (m: WorkerOutput) => parentPort!.postMessage(m);

configureParsers({ grammarDir: input.grammarDir, runtimeWasm: input.runtimeWasm });
analyze(input.dir, input.name, input.dir, (message) => send({ type: 'progress', message }))
  .then((result) => send({ type: 'done', result }))
  .catch((e: unknown) => send({ type: 'error', message: e instanceof Error ? e.message : String(e) }));
