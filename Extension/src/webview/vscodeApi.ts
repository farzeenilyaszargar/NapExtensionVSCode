import { WebviewToExtensionMessage } from '../shared/protocol';

interface VsCodeApi {
  postMessage(message: WebviewToExtensionMessage): void;
  getState<T = unknown>(): T | undefined;
  setState<T = unknown>(state: T): void;
}

declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;

let api: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (!api) {
    if (typeof acquireVsCodeApi !== 'function') {
      throw new Error('VS Code API is unavailable.');
    }
    api = acquireVsCodeApi();
  }
  return api;
}
