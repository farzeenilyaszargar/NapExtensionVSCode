import { describe, expect, it } from 'vitest';
import { isWebviewToExtensionMessage } from './protocol';

describe('Nap bridge protocol', () => {
  it('accepts valid webview messages', () => {
    expect(isWebviewToExtensionMessage({ type: 'ready' })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'authLogin' })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'refreshSessions' })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'sendPrompt', prompt: 'hello' })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'openSession', sessionId: 'session-1' })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'openFile', filePath: 'src/extension.ts:12' })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'setMode', mode: 'plan' })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'setModel', modelId: 'nap-default' })).toBe(true);
  });

  it('rejects malformed or unsupported messages', () => {
    expect(isWebviewToExtensionMessage(null)).toBe(false);
    expect(isWebviewToExtensionMessage({})).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'sendPrompt' })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'openSession', sessionId: '' })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'openFile', filePath: '   ' })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'setMode', mode: 'edit' })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'setModel', modelId: '' })).toBe(false);
  });
});
