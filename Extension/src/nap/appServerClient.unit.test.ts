import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { NapAppServerClient, resolveNapCliCommand } from './appServerClient';

describe('NapAppServerClient', () => {
  it('initializes, routes responses by id, and emits notifications', async () => {
    const fake = createFakeChild();
    const client = new NapAppServerClient('1.2.3', (() => fake.child) as never);
    const notifications: string[] = [];
    client.onNotification(notification => notifications.push(notification.method));

    const started = client.start();
    await waitForWrites(fake.writes, 1);

    expect(JSON.parse(fake.writes[0])).toEqual({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'nap_extension',
          title: 'Nap Extension',
          version: '1.2.3'
        },
        capabilities: {
          experimentalApi: true
        }
      }
    });

    fake.stdout.emit('data', Buffer.from('{"id":1,"result":{"ok":true}}\n'));
    await started;
    expect(JSON.parse(fake.writes[1])).toEqual({ method: 'initialized' });

    const thread = client.startThread({ cwd: '/repo', model: 'gpt-5.4-mini' });
    await waitForWrites(fake.writes, 3);
    fake.stdout.emit('data', Buffer.from('{"method":"turn/started","params":{"threadId":"thread-1"}}\n'));
    fake.stdout.emit('data', Buffer.from('{"id":2,"result":{"threadId":"thread-1"}}\n'));

    await expect(thread).resolves.toEqual({ threadId: 'thread-1' });
    expect(notifications).toEqual(['turn/started']);

    client.dispose();
    expect(fake.killed()).toBe(true);
  });

  it('sends account login and account read requests', async () => {
    const fake = createFakeChild();
    const client = new NapAppServerClient('1.2.3', (() => fake.child) as never);
    const started = client.start();
    await waitForWrites(fake.writes, 1);
    fake.stdout.emit('data', Buffer.from('{"id":1,"result":{"ok":true}}\n'));
    await started;

    const login = client.loginAccount({ type: 'chatgpt', napStreamlinedLogin: true });
    await waitForWrites(fake.writes, 3);
    expect(JSON.parse(fake.writes[2])).toEqual({
      id: 2,
      method: 'account/login/start',
      params: {
        type: 'chatgpt',
        napStreamlinedLogin: true
      }
    });
    fake.stdout.emit('data', Buffer.from('{"id":2,"result":{"type":"chatgpt","loginId":"login-1","authUrl":"https://www.nap-code.com/login"}}\n'));
    await expect(login).resolves.toMatchObject({ loginId: 'login-1' });

    const account = client.readAccount({ refreshToken: true });
    await waitForWrites(fake.writes, 4);
    expect(JSON.parse(fake.writes[3])).toEqual({
      id: 3,
      method: 'account/read',
      params: {
        refreshToken: true
      }
    });
    fake.stdout.emit('data', Buffer.from('{"id":3,"result":{"account":{"type":"chatgpt","email":"farzeen@example.com"},"requiresOpenaiAuth":true}}\n'));
    await expect(account).resolves.toMatchObject({ account: { email: 'farzeen@example.com' } });

    client.dispose();
  });

  it('sends thread resume requests', async () => {
    const fake = createFakeChild();
    const client = new NapAppServerClient('1.2.3', (() => fake.child) as never);
    const started = client.start();
    await waitForWrites(fake.writes, 1);
    fake.stdout.emit('data', Buffer.from('{"id":1,"result":{"ok":true}}\n'));
    await started;

    const resumed = client.resumeThread({
      threadId: 'thread-existing',
      cwd: '/repo',
      model: 'gpt-5.4-mini',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    });
    await waitForWrites(fake.writes, 3);
    expect(JSON.parse(fake.writes[2])).toEqual({
      id: 2,
      method: 'thread/resume',
      params: {
        threadId: 'thread-existing',
        cwd: '/repo',
        model: 'gpt-5.4-mini',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write'
      }
    });
    fake.stdout.emit('data', Buffer.from('{"id":2,"result":{"thread":{"threadId":"thread-existing"}}}\n'));
    await expect(resumed).resolves.toMatchObject({ thread: { threadId: 'thread-existing' } });

    client.dispose();
  });

  it('responds to app-server auth refresh requests', async () => {
    const fake = createFakeChild();
    const client = new NapAppServerClient('1.2.3', (() => fake.child) as never);
    client.onRequest(request => {
      if (request.method !== 'account/chatgptAuthTokens/refresh') {
        return undefined;
      }
      return {
        accessToken: 'access-2',
        chatgptAccountId: 'acct-1',
        chatgptPlanType: 'pro'
      };
    });

    const started = client.start();
    await waitForWrites(fake.writes, 1);
    fake.stdout.emit('data', Buffer.from('{"id":1,"result":{"ok":true}}\n'));
    await started;

    fake.stdout.emit('data', Buffer.from('{"id":99,"method":"account/chatgptAuthTokens/refresh","params":{"reason":"unauthorized","previousAccountId":"acct-1"}}\n'));
    await waitForWrites(fake.writes, 3);
    expect(JSON.parse(fake.writes[2])).toEqual({
      id: 99,
      result: {
        accessToken: 'access-2',
        chatgptAccountId: 'acct-1',
        chatgptPlanType: 'pro'
      }
    });

    client.dispose();
  });

  it('does not recursively wait on start while sending initialize', async () => {
    const fake = createFakeChild();
    const client = new NapAppServerClient('1.2.3', (() => fake.child) as never);

    const started = client.start();
    await waitForWrites(fake.writes, 1);
    expect(JSON.parse(fake.writes[0]).method).toBe('initialize');

    fake.stdout.emit('data', Buffer.from('{"id":1,"result":{"ok":true}}\n'));
    await expect(started).resolves.toBeUndefined();
    client.dispose();
  });

  it('does not send initialize twice when initialize is called after start', async () => {
    const fake = createFakeChild();
    const client = new NapAppServerClient('1.2.3', (() => fake.child) as never);

    const started = client.start();
    await waitForWrites(fake.writes, 1);
    fake.stdout.emit('data', Buffer.from('{"id":1,"result":{"ok":true}}\n'));
    await started;

    await client.initialize();
    expect(fake.writes.map(write => JSON.parse(write).method)).toEqual(['initialize', 'initialized']);
    client.dispose();
  });

  it('prefers a custom CLI path when configured', () => {
    expect(resolveNapCliCommand(['login'], '/custom/nap')).toEqual({
      command: '/custom/nap',
      args: ['login']
    });
  });
});

function createFakeChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const events = new EventEmitter();
  const writes: string[] = [];
  let killed = false;

  const child = {
    stdout,
    stderr,
    stdin: {
      write(value: string) {
        writes.push(value.trim());
        return true;
      }
    },
    get killed() {
      return killed;
    },
    kill() {
      killed = true;
      events.emit('close', 0);
      return true;
    },
    on: events.on.bind(events)
  };

  return {
    child,
    stdout,
    writes,
    killed: () => killed
  };
}

async function waitForWrites(writes: string[], count: number): Promise<void> {
  const started = Date.now();
  while (writes.length < count && Date.now() - started < 1000) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
