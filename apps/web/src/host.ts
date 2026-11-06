import type { Graph } from './types';

/** Messages between the workflow UI and an editor extension hosting it in a webview. */
export type ToHost =
  | { type: 'ready' }
  | { type: 'sources' }
  | { type: 'open'; path: string; line?: number }
  | { type: 'reanalyze' };

export type FromHost =
  | { type: 'progress'; message: string }
  | { type: 'graph'; graph: Graph }
  | { type: 'sources'; sources: Record<number, string> }
  | { type: 'error'; message: string };

interface VsCodeApi {
  postMessage(message: ToHost): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

const api = typeof window !== 'undefined' && window.acquireVsCodeApi ? window.acquireVsCodeApi() : null;

/** True when running inside an editor webview rather than a browser tab. */
export const inEditor = api !== null;

export function postToHost(message: ToHost) {
  api?.postMessage(message);
}

export function onHostMessage(handler: (message: FromHost) => void) {
  const listener = (e: MessageEvent<FromHost>) => {
    if (e.data && typeof e.data === 'object' && 'type' in e.data) handler(e.data);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
