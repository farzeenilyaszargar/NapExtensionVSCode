import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NapAppServerClient, NapAppServerNotification, resolveNapCliCommand } from '../appServerClient';
import { appendDaemonLog } from '../runtimePaths';
import {
  NapAuthState,
  NapMode,
  NapModelOption,
  NapSecurityMode
} from '../../shared/protocol';

const AUTO_MODEL_ID = 'gpt-5.4-mini';

export interface ProviderPromptRequest {
  prompt: string;
  mode: NapMode;
  modelId: string;
  debugMode: boolean;
  securityMode: NapSecurityMode;
  sessionId?: string;
  workspaceRoot?: string;
}

export interface ProviderPromptStream {
  onDelta(delta: string): void;
  onActivity(text: string | undefined): void;
  onLog(message: string): void;
}

export interface ProviderAdapter {
  listModels(defaultModelId: string): Promise<NapModelOption[]>;
  authStatus(): Promise<NapAuthState>;
  login(): Promise<NapAuthState>;
  logout(): Promise<NapAuthState>;
  streamPrompt(request: ProviderPromptRequest, stream: ProviderPromptStream, signal: AbortSignal): Promise<void>;
  dispose?(): void;
}

export class NapCliProviderAdapter implements ProviderAdapter {
  private authStatusInFlight: Promise<NapAuthState> | undefined;
  private readonly appServer: NapAppServerClient;
  private readonly appThreads = new Map<string, string>();

  constructor(
    private readonly cliPath = 'nap',
    extensionVersion = '0.1.1',
    appServer?: NapAppServerClient
  ) {
    this.appServer = appServer ?? new NapAppServerClient(extensionVersion);
  }

  async listModels(defaultModelId: string): Promise<NapModelOption[]> {
    for (const args of [['models', '--json'], ['models'], ['model', 'list', '--json']]) {
      try {
        const models = parseModelOptions(await this.runText(args, 5000));
        if (models.length > 0) {
          return models;
        }
      } catch {
        // Try the next common CLI shape.
      }
    }

    return [
      { id: 'auto', label: 'Auto', description: AUTO_MODEL_ID, supportsTools: true },
      { id: 'gpt-5.5', label: 'GPT-5.5', supportsTools: true },
      { id: 'gpt-5.4', label: 'GPT-5.4', supportsTools: true },
      { id: AUTO_MODEL_ID, label: 'GPT-5.4 Mini', description: 'Default auto model', supportsTools: true },
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', supportsTools: true },
      { id: 'claude-opus-4.8', label: 'Claude Opus 4.8', supportsTools: true },
      { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6', supportsTools: true },
      { id: 'minimax-m3', label: 'MiniMax M3', supportsTools: true },
      { id: 'minimax-m2.7', label: 'MiniMax M2.7', supportsTools: true }
    ];
  }

  async authStatus(): Promise<NapAuthState> {
    if (this.authStatusInFlight) {
      return this.authStatusInFlight;
    }

    this.authStatusInFlight = this.readAuthStatus().finally(() => {
      this.authStatusInFlight = undefined;
    });
    return this.authStatusInFlight;
  }

  private async readAuthStatus(): Promise<NapAuthState> {
    for (const args of [['login', 'status'], ['doctor', '--json'], ['status', '--json']]) {
      try {
        appendDaemonLog(`[provider] auth probe: ${this.cliPath} ${args.join(' ')}`);
        return parseAuthState(await this.runText(args, 4500));
      } catch (error) {
        appendDaemonLog(`[provider] auth probe failed: ${args.join(' ')}: ${error instanceof Error ? error.message : String(error)}`);
        // Try the next common CLI shape.
      }
    }

    return { status: 'signedOut', label: `Sign in with Nap CLI (${this.cliPath})` };
  }

  async login(): Promise<NapAuthState> {
    try {
      await this.runText(['login'], 120000);
      return this.waitForAuthenticatedStatus();
    } catch {
      return { status: 'signedOut', label: `Run ${this.cliPath} login in a terminal` };
    }
  }

  async logout(): Promise<NapAuthState> {
    try {
      await this.runText(['logout'], 8000);
    } catch {
      // Status check can correct this later.
    }
    return { status: 'signedOut', label: 'Nap CLI signed out' };
  }

  async streamPrompt(request: ProviderPromptRequest, stream: ProviderPromptStream, signal: AbortSignal): Promise<void> {
    const auth = await this.authStatus();
    if (auth.status !== 'authenticated') {
      throw new Error('Sign in with Nap CLI before using chat.');
    }

    await this.appServer.start();
    const threadKey = request.sessionId ?? request.workspaceRoot ?? 'default';
    const threadId = await this.getOrStartThread(threadKey, request);
    stream.onLog(`Starting Nap app-server turn in thread ${threadId}.`);

    let turnId: string | undefined;
    let cleanupCompleted: (() => void) | undefined;
    const completed = new Promise<void>((resolve, reject) => {
      const cleanup = this.appServer.onNotification(notification => {
        if (!notificationMatchesTurn(notification, threadId, turnId)) {
          return;
        }

        const delta = parseAppServerDelta(notification);
        if (delta) {
          stream.onDelta(delta);
        }
        const activityText = parseAppServerActivity(notification);
        if (activityText !== undefined) {
          stream.onActivity(activityText);
        }

        if (notification.method === 'turn/completed') {
          stream.onActivity(undefined);
          cleanup();
          signal.removeEventListener('abort', abort);
          resolve();
        }
      });
      const abort = () => {
        cleanup();
        this.appServer.stop();
        reject(new Error('Provider request cancelled.'));
      };
      signal.addEventListener('abort', abort, { once: true });
      cleanupCompleted = () => {
        cleanup();
        signal.removeEventListener('abort', abort);
      };
    });

    try {
      const turnResult = await this.appServer.startTurn({
        threadId,
        input: [{ type: 'text', text: buildTurnText(request) }]
      });
      turnId = readTurnId(turnResult);
      appendDaemonLog(`[provider] app-server turn started thread=${threadId} turn=${turnId ?? 'unknown'}`);
      await completed;
    } catch (error) {
      cleanupCompleted?.();
      throw error;
    }
  }

  dispose(): void {
    this.appServer.dispose();
  }

  private async getOrStartThread(threadKey: string, request: ProviderPromptRequest): Promise<string> {
    const existing = this.appThreads.get(threadKey);
    if (existing) {
      return existing;
    }

    const threadId = await getInitializedThread(this.appServer, request);
    this.appThreads.set(threadKey, threadId);
    return threadId;
  }

  private async runText(args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const command = resolveNapCliCommand(args, this.cliPath);
      const child = spawn(command.command, command.args, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      appendDaemonLog(`[provider] probe pid=${child.pid ?? 'unknown'} args=${command.command} ${command.args.join(' ')}`);
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        appendDaemonLog(`[provider] probe timeout args=${command.command} ${command.args.join(' ')}`);
        reject(new Error('Nap CLI probe timed out.'));
      }, timeoutMs);

      child.stdout.on('data', data => {
        stdout += data.toString('utf8');
      });
      child.stderr.on('data', data => {
        stderr += data.toString('utf8');
      });
      child.on('error', error => {
        clearTimeout(timeout);
        appendDaemonLog(`[provider] probe error args=${command.command} ${command.args.join(' ')}: ${error.message}`);
        reject(error);
      });
      child.on('close', code => {
        clearTimeout(timeout);
        appendDaemonLog(`[provider] probe close code=${code} args=${command.command} ${command.args.join(' ')} stdout=${stripAnsi(stdout).trim().slice(0, 300)} stderr=${stripAnsi(stderr).trim().slice(0, 300)}`);
        if (code === 0) {
          resolve(stdout || stderr);
          return;
        }
        reject(new Error(stripAnsi(stderr).trim() || `Nap CLI exited with code ${code}.`));
      });
    });
  }

  private async waitForAuthenticatedStatus(): Promise<NapAuthState> {
    const started = Date.now();
    while (Date.now() - started < 30000) {
      const auth = await this.authStatus();
      if (auth.status === 'authenticated') {
        return auth;
      }
      await delay(1000);
    }
    return { status: 'signedOut', label: 'Nap login did not persist credentials. Run nap login in a terminal and retry.' };
  }
}

async function getInitializedThread(client: NapAppServerClient, request: ProviderPromptRequest): Promise<string> {
  const result = await client.startThread({
    cwd: request.workspaceRoot ?? process.cwd(),
    model: request.modelId === 'auto' ? AUTO_MODEL_ID : request.modelId,
    approvalPolicy: 'on-request',
    sandbox: request.securityMode === 'strict' ? 'read-only' : 'workspace-write'
  });
  const threadId = readThreadId(result);
  if (!threadId) {
    throw new Error('Nap app-server did not return a thread id.');
  }
  return threadId;
}

function buildTurnText(request: ProviderPromptRequest): string {
  return buildExecPrompt(request);
}

function readThreadId(result: unknown): string | undefined {
  const record = readObject(result);
  const thread = readObject(record?.thread);
  return readString(record?.threadId)
    ?? readString(record?.thread_id)
    ?? readString(record?.id)
    ?? readString(thread?.id)
    ?? readString(thread?.threadId)
    ?? readString(thread?.thread_id);
}

function readTurnId(result: unknown): string | undefined {
  const record = readObject(result);
  const turn = readObject(record?.turn);
  return readString(record?.turnId)
    ?? readString(record?.turn_id)
    ?? readString(record?.id)
    ?? readString(turn?.id)
    ?? readString(turn?.turnId)
    ?? readString(turn?.turn_id);
}

function notificationMatchesTurn(notification: NapAppServerNotification, threadId: string, turnId: string | undefined): boolean {
  const params = readObject(notification.params) ?? {};
  const item = readObject(params.item);
  const eventThreadId = readString(params.threadId)
    ?? readString(params.thread_id)
    ?? readString(item?.threadId)
    ?? readString(item?.thread_id);
  const eventTurnId = readString(params.turnId)
    ?? readString(params.turn_id)
    ?? readString(item?.turnId)
    ?? readString(item?.turn_id);

  if (eventThreadId && eventThreadId !== threadId) {
    return false;
  }
  if (turnId && eventTurnId && eventTurnId !== turnId) {
    return false;
  }
  return true;
}

export function parseAppServerDelta(notification: NapAppServerNotification): string {
  if (notification.method !== 'item/agentMessage/delta') {
    return '';
  }

  const params = readObject(notification.params);
  const item = readObject(params?.item);
  const delta = readObject(params?.delta);
  const message = readObject(params?.message);
  const value = params?.delta
    ?? params?.text
    ?? params?.content
    ?? params?.message
    ?? item?.delta
    ?? item?.text
    ?? item?.content
    ?? item?.message
    ?? delta?.text
    ?? delta?.content
    ?? message?.text
    ?? message?.content;
  return typeof value === 'string' ? value : '';
}

export function parseAppServerActivity(notification: NapAppServerNotification): string | undefined {
  const params = readObject(notification.params);
  const item = readObject(params?.item);
  const status = readObject(params?.status);
  const itemType = readString(item?.type);

  switch (notification.method) {
    case 'turn/started':
      return 'Thinking';
    case 'thread/status/changed': {
      const statusType = readString(status?.type);
      return statusType === 'active' ? 'Working' : statusType === 'idle' ? undefined : titleCase(statusType);
    }
    case 'mcpServer/startupStatus/updated': {
      const name = readString(params?.name) ?? 'MCP server';
      const serverStatus = readString(params?.status);
      if (serverStatus === 'starting') {
        return `Starting ${name}`;
      }
      if (serverStatus === 'failed') {
        return undefined;
      }
      return serverStatus ? `${titleCase(serverStatus)} ${name}` : undefined;
    }
    case 'item/started':
      if (itemType === 'reasoning') {
        return 'Reasoning';
      }
      if (itemType === 'toolCall' || itemType === 'functionCall') {
        return `Running ${readString(item?.name) ?? 'tool'}`;
      }
      if (itemType === 'agentMessage') {
        return 'Writing';
      }
      return undefined;
    case 'item/completed':
      if (itemType === 'reasoning') {
        return 'Writing';
      }
      if (itemType === 'toolCall' || itemType === 'functionCall') {
        return 'Reading results';
      }
      return undefined;
    case 'turn/completed':
      return undefined;
    default:
      return undefined;
  }
}

export function buildChatArgs(request: ProviderPromptRequest): string[] {
  const args = ['exec', '--json'];
  const modelId = request.modelId === 'auto' ? AUTO_MODEL_ID : request.modelId;
  if (modelId) {
    args.push('--model', modelId);
  }
  if (request.securityMode === 'strict') {
    args.push('--sandbox', 'read-only');
  }
  args.push('--skip-git-repo-check');
  args.push(buildExecPrompt(request));
  return args;
}

function buildExecPrompt(request: ProviderPromptRequest): string {
  const prefixes = [
    request.mode !== 'chat' ? `Mode: ${request.mode}.` : undefined,
    request.debugMode ? 'Debug mode is enabled; include concise diagnostic context when useful.' : undefined
  ].filter(Boolean);

  return prefixes.length > 0 ? `${prefixes.join('\n')}\n\n${request.prompt}` : request.prompt;
}

export function parseAuthState(output: string, enrichFromLocal = true): NapAuthState {
  const text = stripAnsi(output);
  const json = tryParseJson(text);
  if (json && typeof json === 'object') {
    const record = json as Record<string, unknown>;
    const checks = readObject(record.checks);
    const authCredentials = readObject(checks?.['auth.credentials']);
    if (authCredentials) {
      const status = String(authCredentials.status ?? '').toLowerCase();
      if (status === 'ok') {
        return enrichAuthState({ status: 'authenticated', label: readString(authCredentials.summary) ?? 'Nap account' }, enrichFromLocal);
      }
      if (status === 'fail' || status === 'error') {
        return { status: 'signedOut', label: readString(authCredentials.summary) ?? 'Sign in with Nap CLI' };
      }
    }

    const userRecord = readObject(record.user) ?? readObject(record.account) ?? readObject(record.profile);
    const status = String(record.status ?? record.authenticated ?? record.isAuthenticated ?? '').toLowerCase();
    const accountName = readString(record.name)
      ?? readString(record.accountName)
      ?? readString(record.username)
      ?? readString(userRecord?.name)
      ?? readString(userRecord?.username);
    const accountEmail = readString(record.email)
      ?? readString(record.accountEmail)
      ?? readString(userRecord?.email);
    const avatarUrl = readString(record.avatarUrl)
      ?? readString(record.avatar)
      ?? readString(record.image)
      ?? readString(userRecord?.avatarUrl)
      ?? readString(userRecord?.avatar)
      ?? readString(userRecord?.image);
    if (!status && (accountName || accountEmail)) {
      return enrichAuthState({ status: 'authenticated', label: accountName ?? accountEmail ?? 'Nap account', accountName, accountEmail, avatarUrl }, enrichFromLocal);
    }
    if (status === 'true' || status === 'authenticated' || status === 'signedin' || status === 'signed-in') {
      return enrichAuthState({ status: 'authenticated', label: accountName ?? accountEmail ?? 'Nap account', accountName, accountEmail, avatarUrl }, enrichFromLocal);
    }
    if (status === 'false' || /signedout|signed-out|logout/i.test(status)) {
      return { status: 'signedOut', label: 'Nap CLI signed out' };
    }
  }

  const loggedInMatch = text.match(/(?:logged|signed)\s*in\s+as\s+([^\n<]+)(?:<([^>\n]+)>)?/i);
  if (loggedInMatch) {
    const accountName = loggedInMatch[1]?.trim();
    const accountEmail = loggedInMatch[2]?.trim();
    return enrichAuthState({ status: 'authenticated', label: accountName || accountEmail || 'Nap account', accountName, accountEmail }, enrichFromLocal);
  }
  if (/not\s+authenticated|not\s+logged\s+in|not\s+signed\s+in|signed\s*out|logged\s*out|login\s+required|sign\s+in\s+required/i.test(text)) {
    return { status: 'signedOut', label: 'Sign in with Nap CLI' };
  }
  if (/authenticated|signed\s*in|logged\s*in|logged\s+in\s+to\s+nap|successfully\s+logged|successfully\s+signed/i.test(text)) {
    return enrichAuthState({ status: 'authenticated', label: 'Nap account' }, enrichFromLocal);
  }
  return { status: 'unknown', label: 'Nap CLI auth unknown' };
}

function enrichAuthState(auth: NapAuthState, enrichFromLocal: boolean): NapAuthState {
  if (auth.status !== 'authenticated' || !enrichFromLocal) {
    return auth;
  }

  const profile = readLocalAuthProfile();
  const accountName = auth.accountName ?? profile.accountName;
  const accountEmail = auth.accountEmail ?? profile.accountEmail;
  const avatarUrl = auth.avatarUrl ?? profile.avatarUrl;
  return {
    ...auth,
    label: accountName ?? accountEmail ?? auth.label ?? 'Nap account',
    accountName,
    accountEmail,
    avatarUrl
  };
}

function readLocalAuthProfile(): Partial<Pick<NapAuthState, 'accountName' | 'accountEmail' | 'avatarUrl'>> {
  const napHome = process.env.NAP_HOME ?? path.join(os.homedir(), '.nap');
  for (const fileName of ['auth.json', 'service-auth.json']) {
    const record = readJsonObject(path.join(napHome, fileName));
    if (!record) {
      continue;
    }

    const profile = profileFromRecord(record);
    if (profile.accountName || profile.accountEmail || profile.avatarUrl) {
      return profile;
    }
  }
  return {};
}

function profileFromRecord(record: Record<string, unknown>): Partial<Pick<NapAuthState, 'accountName' | 'accountEmail' | 'avatarUrl'>> {
  const user = readObject(record.user) ?? readObject(record.account) ?? readObject(record.profile);
  const tokenProfile = profileFromJwt(readString(record.accessToken) ?? readString(record.idToken) ?? readString(record.token));
  return {
    accountName: readString(record.name) ?? readString(record.accountName) ?? readString(record.username) ?? readString(user?.name) ?? readString(user?.username) ?? tokenProfile.accountName,
    accountEmail: readString(record.email) ?? readString(record.accountEmail) ?? readString(user?.email) ?? tokenProfile.accountEmail,
    avatarUrl: readString(record.avatarUrl) ?? readString(record.avatar) ?? readString(record.picture) ?? readString(user?.avatarUrl) ?? readString(user?.avatar) ?? readString(user?.picture) ?? tokenProfile.avatarUrl
  };
}

function profileFromJwt(token: string | undefined): Partial<Pick<NapAuthState, 'accountName' | 'accountEmail' | 'avatarUrl'>> {
  if (!token) {
    return {};
  }
  const [, payload] = token.split('.');
  if (!payload) {
    return {};
  }
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
    return {
      accountName: readString(claims.name) ?? readString(claims.preferred_username),
      accountEmail: readString(claims.email),
      avatarUrl: readString(claims.picture) ?? readString(claims.avatarUrl)
    };
  } catch {
    return {};
  }
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  try {
    return readObject(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return undefined;
  }
}

function parseModelOptions(output: string): NapModelOption[] {
  const json = tryParseJson(output);
  const models = Array.isArray(json)
    ? json
    : json && typeof json === 'object' && Array.isArray((json as Record<string, unknown>).models)
      ? (json as { models: unknown[] }).models
      : undefined;

  if (models) {
    return models
      .map(item => typeof item === 'string'
        ? { id: item, label: item }
        : item && typeof item === 'object'
          ? {
            id: String((item as Record<string, unknown>).id ?? (item as Record<string, unknown>).name ?? ''),
            label: String((item as Record<string, unknown>).label ?? (item as Record<string, unknown>).name ?? (item as Record<string, unknown>).id ?? '')
          }
          : undefined)
      .filter((item): item is NapModelOption => Boolean(item?.id));
  }

  const ids = new Set<string>();
  for (const match of stripAnsi(output).matchAll(/\b(?:gpt|codex|sonnet|opus|claude|models\/)[-\w.]+/gi)) {
    ids.add(match[0].replace(/^models\//, ''));
  }
  return [...ids].map(id => ({ id, label: id.replace(/-/g, ' '), supportsTools: true }));
}

export function parseCliStreamLine(line: string): string {
  const trimmed = stripAnsi(line).trim();
  if (!trimmed) {
    return '';
  }
  const json = tryParseJson(trimmed);
  if (json && typeof json === 'object') {
    const record = json as Record<string, unknown>;
    const item = readObject(record.item);
    const delta = readObject(record.delta);
    const message = readObject(record.message);
    const value = record.delta
      ?? record.text
      ?? record.content
      ?? record.message
      ?? item?.text
      ?? item?.content
      ?? delta?.text
      ?? delta?.content
      ?? message?.text
      ?? message?.content;
    return typeof value === 'string' ? value : '';
  }
  if (/^(reading additional input from stdin|20\d\d-\d\d-\d\dt.*\bwarn\b)/i.test(trimmed)) {
    return '';
  }
  return `${trimmed}\n`;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function titleCase(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
