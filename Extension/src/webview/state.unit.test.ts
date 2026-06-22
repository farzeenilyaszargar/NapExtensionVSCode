import { describe, expect, it } from 'vitest';
import { applyExtensionMessage, initialViewState } from './state';
import { NapSessionState } from '../shared/protocol';

describe('Nap webview state reducer', () => {
  it('replaces state from the extension host', () => {
    const nextState: NapSessionState = {
      ...initialViewState,
      sessionId: 'session-1',
      modelId: 'nap-fast'
    };

    expect(applyExtensionMessage(initialViewState, { type: 'sessionState', state: nextState })).toStrictEqual(nextState);
  });

  it('streams assistant deltas into the matching message', () => {
    const state = {
      ...initialViewState,
      activityText: 'Reading files',
      activityKind: 'reasoning' as const,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant' as const,
          content: 'Hel',
          status: 'streaming' as const,
          createdAt: 1
        }
      ]
    };

    const nextState = applyExtensionMessage(state, {
      type: 'messageDelta',
      messageId: 'assistant-1',
      delta: 'lo'
    });

    expect(nextState.messages[0].content).toBe('Hello');
    expect(nextState.activityText).toBeUndefined();
    expect(nextState.activityKind).toBeUndefined();
  });

  it('replaces transient activity text from semantic app-server events', () => {
    const thinkingState = applyExtensionMessage(initialViewState, {
      type: 'activityTextChanged',
      text: 'Reading workspace files',
      kind: 'reasoning'
    });

    const commandState = applyExtensionMessage(thinkingState, {
      type: 'activityTextChanged',
      text: 'Running tests',
      kind: 'command'
    });

    expect(commandState.activityText).toBe('Running tests');
    expect(commandState.activityKind).toBe('command');
  });

  it('keeps persistent file activity as separate activity rows', () => {
    const nextState = applyExtensionMessage(initialViewState, {
      type: 'activityTextChanged',
      text: 'Editing file src/app.ts (+4 -1)',
      kind: 'file',
      persistent: true
    });

    expect(nextState.activityItems).toHaveLength(1);
    expect(nextState.activityItems?.[0]).toMatchObject({
      text: 'Editing file src/app.ts (+4 -1)',
      kind: 'file'
    });
  });

  it('updates status when a stream completes or stops', () => {
    const state = {
      ...initialViewState,
      status: 'streaming' as const,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant' as const,
          content: 'done',
          status: 'streaming' as const,
          createdAt: 1
        }
      ]
    };

    const nextState = applyExtensionMessage(state, {
      type: 'messageDone',
      messageId: 'assistant-1',
      status: 'complete'
    });

    expect(nextState.status).toBe('idle');
    expect(nextState.messages[0].status).toBe('complete');
  });

  it('updates session summaries from the extension host', () => {
    const sessions = [{
      id: 'session-1',
      title: 'Build a sidebar',
      preview: 'Build a sidebar',
      messageCount: 2,
      updatedAt: 100
    }];

    const nextState = applyExtensionMessage(initialViewState, {
      type: 'sessionsChanged',
      sessions
    });

    expect(nextState.sessions).toBe(sessions);
  });

  it('attaches workspace change summaries to assistant messages', () => {
    const state = {
      ...initialViewState,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant' as const,
          content: 'Updated the files.',
          status: 'complete' as const,
          createdAt: 1
        }
      ]
    };

    const workspaceChanges = {
      filesChanged: 1,
      additions: 4,
      deletions: 1,
      files: [{ filePath: 'src/app.ts', additions: 4, deletions: 1, status: 'tracked' as const }]
    };

    const nextState = applyExtensionMessage(state, {
      type: 'workspaceChangesChanged',
      messageId: 'assistant-1',
      workspaceChanges
    });

    expect(nextState.workspaceChanges).toBe(workspaceChanges);
    expect(nextState.messages[0].workspaceChanges).toBe(workspaceChanges);
  });

  it('keeps recent log events bounded', () => {
    const state = {
      ...initialViewState,
      logs: Array.from({ length: 80 }, (_, index) => ({
        id: `log-${index}`,
        level: 'info' as const,
        message: `event ${index}`,
        source: 'extension' as const,
        createdAt: index
      }))
    };

    const nextState = applyExtensionMessage(state, {
      type: 'logEvent',
      event: {
        id: 'log-new',
        level: 'info',
        message: 'new',
        source: 'nap-cli',
        createdAt: 100
      }
    });

    expect(nextState.logs).toHaveLength(80);
    expect(nextState.logs[0].id).toBe('log-1');
    expect(nextState.logs[79].id).toBe('log-new');
  });
});
