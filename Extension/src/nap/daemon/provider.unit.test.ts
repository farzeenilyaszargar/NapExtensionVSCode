import { describe, expect, it } from 'vitest';
import { buildChatArgs, parseAppServerActivity, parseAppServerDelta, parseAuthState, parseCliStreamLine } from './provider';

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
});

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
    })).toBe('Reasoning');
    expect(parseAppServerActivity({
      method: 'mcpServer/startupStatus/updated',
      params: { name: 'nap_apps', status: 'starting' }
    })).toBe('Starting nap_apps');
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
