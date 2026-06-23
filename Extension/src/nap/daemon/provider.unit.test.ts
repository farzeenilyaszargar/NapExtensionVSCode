import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NapCliProviderAdapter, buildChatArgs, parseAppServerAccountAuthState, parseAppServerActivity, parseAppServerActivityEvent, parseAppServerDelta, parseAppServerFailure, parseAppServerThreadTitle, parseAppServerTurnDiff, parseAuthState, parseCliStreamLine, readPersistedAuthState } from './provider';

describe('Nap CLI auth parsing', () => {
  it('treats profile JSON as authenticated even without a status field', () => {
    expect(parseAuthState(JSON.stringify({
      user: {
        name: 'Farzeen',
        email: 'farzeen@example.com',
        avatarUrl: 'https://example.com/avatar.png'
      }
    }), false)).toEqual({
      status: 'authenticated',
      label: 'Farzeen',
      accountName: 'Farzeen',
      accountEmail: 'farzeen@example.com',
      avatarUrl: 'https://example.com/avatar.png'
    });
  });

  it('extracts logged-in account text', () => {
    expect(parseAuthState('Logged in as Farzeen <farzeen@example.com>', false)).toMatchObject({
      status: 'authenticated',
      accountName: 'Farzeen',
      accountEmail: 'farzeen@example.com'
    });
  });

  it('recognizes top-level login status output', () => {
    expect(parseAuthState('Logged in to Nap', false)).toEqual({
      status: 'authenticated',
      label: 'Nap account'
    });
  });

  it('recognizes doctor auth credentials output', () => {
    expect(parseAuthState(JSON.stringify({
      checks: {
        'auth.credentials': {
          status: 'ok',
          summary: 'auth is configured'
        }
      }
    }), false)).toEqual({
      status: 'authenticated',
      label: 'auth is configured'
    });
  });

  it('recognizes explicit signed-out text before generic sign-in wording', () => {
    expect(parseAuthState('Not logged in. Sign in required.', false)).toMatchObject({
      status: 'signedOut'
    });
  });

  it('reads persistent auth.json credentials', () => {
    const napHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nap-auth-'));
    try {
      fs.writeFileSync(path.join(napHome, 'auth.json'), JSON.stringify({
        auth_mode: 'nap',
        tokens: {
          access_token: createJwt({
            exp: Math.floor(Date.now() / 1000) + 3600,
            name: 'Farzeen',
            email: 'farzeen@example.com'
          })
        },
        last_refresh: new Date().toISOString()
      }));

      expect(readPersistedAuthState(napHome)).toMatchObject({
        status: 'authenticated',
        label: 'Farzeen',
        accountName: 'Farzeen',
        accountEmail: 'farzeen@example.com'
      });
    } finally {
      fs.rmSync(napHome, { recursive: true, force: true });
    }
  });

  it('ignores expired persistent auth credentials', () => {
    const napHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nap-auth-'));
    try {
      fs.writeFileSync(path.join(napHome, 'service-auth.json'), JSON.stringify({
        accessToken: createJwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
        expiresAt: Date.now() - 60_000
      }));

      expect(readPersistedAuthState(napHome)).toBeUndefined();
    } finally {
      fs.rmSync(napHome, { recursive: true, force: true });
    }
  });

  it('trusts refresh-token-backed auth.json even when the access token is expired', () => {
    const napHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nap-auth-'));
    try {
      fs.writeFileSync(path.join(napHome, 'auth.json'), JSON.stringify({
        auth_mode: 'agentIdentity',
        tokens: {
          access_token: createJwt({
            exp: Math.floor(Date.now() / 1000) - 60,
            name: 'Farzeen',
            email: 'farzeen@example.com'
          }),
          refresh_token: 'refresh-token',
          account_id: 'acct_123'
        },
        last_refresh: new Date().toISOString()
      }));

      expect(readPersistedAuthState(napHome)).toMatchObject({
        status: 'authenticated',
        label: 'Farzeen',
        accountName: 'Farzeen',
        accountEmail: 'farzeen@example.com'
      });
    } finally {
      fs.rmSync(napHome, { recursive: true, force: true });
    }
  });

  it('maps app-server account/read responses to authenticated state', () => {
    expect(parseAppServerAccountAuthState({
      account: {
        type: 'chatgpt',
        email: 'farzeen@example.com',
        planType: 'pro'
      },
      requiresOpenaiAuth: true
    })).toMatchObject({
      status: 'authenticated',
      label: 'farzeen@example.com',
      accountEmail: 'farzeen@example.com',
      planType: 'pro'
    });
  });

  it('maps missing app-server account/read account to signed out', () => {
    expect(parseAppServerAccountAuthState({
      account: null,
      requiresOpenaiAuth: true
    })).toEqual({
      status: 'signedOut',
      label: 'Sign in with Nap'
    });
  });
});

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

describe('Nap CLI stream parsing', () => {
  it('extracts completed agent message text from JSONL events', () => {
    expect(parseCliStreamLine(JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'agent_message',
        text: 'pong'
      }
    }))).toBe('pong');
  });

  it('ignores lifecycle and warning lines that are not user-visible output', () => {
    expect(parseCliStreamLine(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }))).toBe('');
    expect(parseCliStreamLine('Reading additional input from stdin...')).toBe('');
    expect(parseCliStreamLine('2026-06-17T08:47:00Z  WARN nap_core: noisy warning')).toBe('');
  });
});

describe('Nap app-server stream parsing', () => {
  it('extracts agent message delta text', () => {
    expect(parseAppServerDelta({
      method: 'item/agentMessage/delta',
      params: {
        delta: 'hello from app-server'
      }
    })).toBe('hello from app-server');
  });

  it('does not duplicate completed agent text after streaming deltas', () => {
    expect(parseAppServerDelta({
      method: 'item/completed',
      params: {
        item: {
          type: 'agentMessage',
          text: 'full response'
        }
      }
    })).toBe('');
  });

  it('maps structured lifecycle events to activity text', () => {
    expect(parseAppServerActivity({
      method: 'item/started',
      params: { item: { type: 'reasoning' } }
    })).toBe('Thinking');
    expect(parseAppServerActivity({
      method: 'mcpServer/startupStatus/updated',
      params: { name: 'nap_apps', status: 'starting' }
    })).toBe('Starting nap_apps');
  });

  it('uses JSON activity fields for shimmer text instead of fixed fallback text', () => {
    expect(parseAppServerActivity({
      method: 'item/started',
      params: {
        item: {
          type: 'reasoning',
          text: 'Reading workspace files'
        }
      }
    })).toBe('Reading workspace files');

    expect(parseAppServerActivity({
      method: 'item/started',
      params: {
        item: {
          type: 'toolCall',
          name: 'rg'
        }
      }
    })).toBe('Running rg');
  });

  it('does not treat normal assistant text deltas as shimmer activity', () => {
    expect(parseAppServerActivity({
      method: 'item/agentMessage/delta',
      params: {
        delta: 'This should render as paragraph text.'
      }
    })).toBeUndefined();
  });

  it('extracts app-server turn diffs for review', () => {
    expect(parseAppServerTurnDiff({
      method: 'turn/diff/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        diff: 'diff --git a/a.txt b/a.txt\n+new line\n'
      }
    })).toBe('diff --git a/a.txt b/a.txt\n+new line');

    expect(parseAppServerTurnDiff({
      method: 'item/agentMessage/delta',
      params: { delta: 'hello' }
    })).toBeUndefined();
  });

  it('extracts app-server thread titles when available', () => {
    expect(parseAppServerThreadTitle({
      method: 'thread/title/updated',
      params: {
        threadId: 'thread-1',
        title: 'Fix Session Naming System'
      }
    })).toBe('Fix Session Naming System');

    expect(parseAppServerThreadTitle({
      method: 'item/started',
      params: { title: 'Not a thread title' }
    })).toBeUndefined();
  });

  it('extracts app-server failure reasons for inline errors', () => {
    expect(parseAppServerFailure({
      method: 'turn/completed',
      params: {
        status: 'failed',
        error: {
          message: 'You do not have enough credits to continue.'
        }
      }
    })).toBe('You do not have enough credits to continue.');

    expect(parseAppServerFailure({
      method: 'turn/completed',
      params: {
        turn: {
          status: 'failed'
        }
      }
    })).toBe('Nap stopped: failed.');

    expect(parseAppServerFailure({
      method: 'error',
      params: {
        message: 'Nap Apps authentication failed. Run `nap login` again, then `/mcp refresh`.'
      }
    })).toBeUndefined();
  });

  it('maps status and progress notifications to activity text', () => {
    expect(parseAppServerActivity({
      method: 'workspace/index/progress',
      params: {
        statusText: 'Indexing source files'
      }
    })).toBe('Indexing source files');

    expect(parseAppServerActivity({
      method: 'thread/status/changed',
      params: {
        status: { type: 'idle' }
      }
    })).toBeUndefined();
  });

  it('classifies reasoning, plan, command, and warning notifications for the UI', () => {
    expect(parseAppServerActivityEvent({
      method: 'item/reasoning/textDelta',
      params: {
        itemId: 'reasoning-1',
        delta: 'I am checking files.'
      }
    })).toMatchObject({
      text: 'I am checking files.',
      kind: 'reasoning',
      append: true,
      itemId: 'reasoning-1'
    });

    expect(parseAppServerActivityEvent({
      method: 'item/plan/delta',
      params: {
        itemId: 'plan-1',
        delta: 'Update the parser.'
      }
    })).toMatchObject({
      text: 'Update the parser.',
      kind: 'plan',
      append: true
    });

    expect(parseAppServerActivityEvent({
      method: 'item/started',
      params: {
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'npm test'
        }
      }
    })).toMatchObject({
      text: 'Running npm test',
      kind: 'command',
      itemId: 'cmd-1'
    });

    expect(parseAppServerActivityEvent({
      method: 'guardianWarning',
      params: {
        message: 'Approval required'
      }
    })).toMatchObject({
      text: 'Approval required',
      kind: 'warning'
    });
  });
});

describe('Nap app-server provider streaming', () => {
  it('starts a fresh thread and retries when a persisted app-server thread is stale', async () => {
    const fakeAppServer = new FakeAppServer();
    const provider = new NapCliProviderAdapter('nap', 'test', fakeAppServer as never);
    const deltas: string[] = [];
    const threads: string[] = [];

    await provider.streamPrompt(
      {
        prompt: 'hello',
        mode: 'chat',
        modelId: 'gpt-5.4-mini',
        debugMode: false,
        securityMode: 'standard',
        sessionId: 'session-1',
        appThreadId: 'stale-thread',
        workspaceRoot: '/repo'
      },
      {
        onDelta: delta => deltas.push(delta),
        onActivity: () => undefined,
        onThread: threadId => threads.push(threadId),
        onLog: () => undefined
      },
      new AbortController().signal
    );

    expect(fakeAppServer.resumeCalls).toEqual(['stale-thread']);
    expect(fakeAppServer.startedThreads).toEqual(['/repo']);
    expect(fakeAppServer.turnThreadIds).toEqual(['stale-thread', 'fresh-thread']);
    expect(fakeAppServer.turnInputs).toEqual([
      [{ type: 'text', text: 'hello', text_elements: [] }],
      [{ type: 'text', text: 'hello', text_elements: [] }]
    ]);
    expect(threads).toEqual(['stale-thread', 'fresh-thread']);
    expect(deltas).toEqual(['hello from fresh thread']);
  });
});

class FakeAppServer {
  readonly resumeCalls: string[] = [];
  readonly startedThreads: string[] = [];
  readonly turnThreadIds: string[] = [];
  readonly turnInputs: Array<Array<{ type: 'text'; text: string; text_elements: [] }>> = [];
  private notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined;

  onRequest(): () => void {
    return () => undefined;
  }

  onNotification(handler: (notification: { method: string; params?: unknown }) => void): () => void {
    this.notificationHandler = handler;
    return () => {
      this.notificationHandler = undefined;
    };
  }

  async start(): Promise<void> {
    return undefined;
  }

  async readAccount(): Promise<unknown> {
    return {
      account: {
        type: 'chatgpt',
        email: 'farzeen@example.com'
      }
    };
  }

  async resumeThread(params: { threadId: string }): Promise<unknown> {
    this.resumeCalls.push(params.threadId);
    return { thread: { id: params.threadId } };
  }

  async startThread(params: { cwd: string }): Promise<unknown> {
    this.startedThreads.push(params.cwd);
    return { thread: { id: 'fresh-thread' } };
  }

  async startTurn(params: { threadId: string; input: Array<{ type: 'text'; text: string; text_elements: [] }> }): Promise<unknown> {
    this.turnThreadIds.push(params.threadId);
    this.turnInputs.push(params.input);
    if (params.threadId === 'stale-thread') {
      throw new Error('thread not found: stale-thread');
    }

    queueMicrotask(() => {
      this.notificationHandler?.({
        method: 'item/agentMessage/delta',
        params: {
          threadId: params.threadId,
          turnId: 'turn-1',
          delta: 'hello from fresh thread'
        }
      });
      this.notificationHandler?.({
        method: 'turn/completed',
        params: {
          threadId: params.threadId,
          turn: { id: 'turn-1' }
        }
      });
    });

    return { turn: { id: 'turn-1' } };
  }
}

describe('Nap CLI command construction', () => {
  it('uses supported nap exec flags only', () => {
    const args = buildChatArgs({
      prompt: 'hello',
      mode: 'debug',
      modelId: 'auto',
      debugMode: true,
      securityMode: 'standard'
    });

    expect(args).toContain('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5.4-mini');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).not.toContain('--security');
    expect(args).not.toContain('--debug');
    expect(args).not.toContain('--mode');
  });

  it('maps strict security to read-only sandbox', () => {
    expect(buildChatArgs({
      prompt: 'hello',
      mode: 'chat',
      modelId: 'auto',
      debugMode: false,
      securityMode: 'strict'
    })).toEqual(['exec', '--json', '--model', 'gpt-5.4-mini', '--sandbox', 'read-only', '--skip-git-repo-check', 'hello']);
  });
});
