#!/usr/bin/env node
import { NapDaemonClient } from './client';
import { SessionMessageDeltaEvent, SessionMessageDoneEvent } from './protocol';

async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2);
  const client = new NapDaemonClient({ workspaceRoot: process.cwd() });

  try {
    switch (command) {
      case 'chat':
        await chat(client, args.join(' '));
        break;
      case 'sessions':
        console.log(JSON.stringify(await client.listSessions(), null, 2));
        break;
      case 'jobs':
        console.log(JSON.stringify(await client.listJobs(), null, 2));
        break;
      case 'auth':
        console.log(JSON.stringify(args[0] === 'login' ? await client.login() : await client.authStatus(), null, 2));
        break;
      case 'models':
        console.log(JSON.stringify(await client.listModels('auto'), null, 2));
        break;
      case 'mcp':
        console.log(JSON.stringify(await client.mcpServers(), null, 2));
        break;
      case 'index':
        console.log(JSON.stringify(args[0] === 'reindex' ? await client.reindex() : await client.indexStatus(), null, 2));
        break;
      case 'health':
        console.log(JSON.stringify(await client.health(), null, 2));
        break;
      case 'shutdown':
        console.log(JSON.stringify(await client.shutdown(), null, 2));
        break;
      default:
        printHelp();
    }
  } finally {
    await client.dispose();
  }
}

async function chat(client: NapDaemonClient, prompt: string): Promise<void> {
  if (!prompt.trim()) {
    throw new Error('Usage: nap chat <prompt>');
  }

  const session = await client.createSession();
  const done = new Promise<void>((resolve, reject) => {
    client.on<SessionMessageDeltaEvent>('session.message.delta', event => {
      if (event.sessionId === session.id) {
        process.stdout.write(event.delta);
      }
    });
    client.on<SessionMessageDoneEvent>('session.message.done', event => {
      if (event.sessionId === session.id) {
        process.stdout.write('\n');
        event.status === 'error' ? reject(new Error('Chat job failed.')) : resolve();
      }
    });
  });
  await client.sendMessage({
    sessionId: session.id,
    prompt,
    mode: 'chat',
    modelId: session.modelId,
    debugMode: session.debugMode,
    securityMode: session.securityMode
  });
  await done;
}

function printHelp(): void {
  console.log([
    'Nap CLI',
    '',
    'Commands:',
    '  nap chat <prompt>',
    '  nap sessions',
    '  nap jobs',
    '  nap auth [login]',
    '  nap models',
    '  nap mcp',
    '  nap index [reindex]',
    '  nap health',
    '  nap shutdown'
  ].join('\n'));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
