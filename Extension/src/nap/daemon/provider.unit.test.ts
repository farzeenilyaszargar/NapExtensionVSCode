import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildChatArgs, parseAppServerActivity, parseAppServerDelta, parseAuthState, parseCliStreamLine, readPersistedAuthState } from './provider';

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
});

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
