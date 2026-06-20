import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NapAppServerClient, NapAppServerNotification, NapAppServerRequest, resolveNapCliCommand } from '../appServerClient';
import { appendDaemonLog } from '../runtimePaths';
import {
  NapActivityKind,
  NapActivityVerb,
  NapAuthState,
  NapMode,
  NapModelOption,
  NapPluginSummary,
  NapSecurityMode
} from '../../shared/protocol';

const AUTO_MODEL_ID = 'gpt-5.4-mini';
const DEFAULT_MODEL_OPTION: NapModelOption = { id: AUTO_MODEL_ID, label: 'GPT-5.4 Mini', description: 'Default model', supportsTools: true };

export interface ProviderPromptRequest {
  prompt: string;
  mode: NapMode;
  modelId: string;
  debugMode: boolean;
  securityMode: NapSecurityMode;
  sessionId?: string;
  appThreadId?: string;
  workspaceRoot?: string;
}

export interface ProviderPromptStream {
  onDelta(delta: string): void;
  onActivity(activity: ProviderActivity | undefined): void;
  onThread?(threadId: string): void;
  onLog(message: string): void;
}

export interface ProviderActivity {
  text: string;
  kind: NapActivityKind;
  verb?: NapActivityVerb;
  filePath?: string;
  title?: string;
  detail?: string;
  additions?: number;
  deletions?: number;
  append?: boolean;
  itemId?: string;
}

export interface ProviderAdapter {
  listModels(defaultModelId: string): Promise<NapModelOption[]>;
  listPlugins(workspaceRoot?: string): Promise<NapPluginSummary[]>;
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
    this.appServer.onRequest(request => this.handleAppServerRequest(request));
  }

  async listModels(defaultModelId: string): Promise<NapModelOption[]> {
    for (const args of [['models', '--json'], ['models'], ['model', 'list', '--json']]) {
      try {
        const models = parseModelOptions(await this.runText(args, 5000));
        if (models.length > 0) {
          return ensureDefaultModelOption(models.filter(model => model.id !== 'auto'));
        }
      } catch {
        // Try the next common CLI shape.
      }
    }

    return [
      { id: 'gpt-5.5', label: 'GPT-5.5', supportsTools: true },
      { id: 'gpt-5.4', label: 'GPT-5.4', supportsTools: true },
      DEFAULT_MODEL_OPTION,
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', supportsTools: true },
      { id: 'claude-opus-4.8', label: 'Claude Opus 4.8', supportsTools: true },
      { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6', supportsTools: true },
      { id: 'minimax-m3', label: 'MiniMax M3', supportsTools: true },
      { id: 'minimax-m2.7', label: 'MiniMax M2.7', supportsTools: true }
    ];
  }

  async listPlugins(workspaceRoot?: string): Promise<NapPluginSummary[]> {
    try {
      await this.appServer.start();
      const response = await this.appServer.request('plugin/list', {
        cwds: workspaceRoot ? [workspaceRoot] : undefined
      });
      return parsePluginListResponse(response);
    } catch (error) {
      appendDaemonLog(`[provider] plugin list failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
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
    try {
      await this.appServer.start();
      const appServerAuth = parseAppServerAccountAuthState(await this.appServer.readAccount({ refreshToken: true }));
      if (appServerAuth.status === 'authenticated') {
        return appServerAuth;
      }
    } catch (error) {
      appendDaemonLog(`[provider] app-server auth read failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const persisted = readPersistedAuthState();
    if (persisted) {
      return persisted;
    }

    let lastAuth: NapAuthState | undefined;
    for (const args of [['login', 'status'], ['doctor', '--json'], ['status', '--json']]) {
      try {
        appendDaemonLog(`[provider] auth probe: ${this.cliPath} ${args.join(' ')}`);
        const auth = parseAuthState(await this.runText(args, 4500));
        if (auth.status === 'authenticated') {
          return auth;
        }
        lastAuth = auth;
      } catch (error) {
        appendDaemonLog(`[provider] auth probe failed: ${args.join(' ')}: ${error instanceof Error ? error.message : String(error)}`);
        // Try the next common CLI shape.
      }
    }

    return readPersistedAuthState() ?? lastAuth ?? { status: 'signedOut', label: `Sign in with Nap CLI (${this.cliPath})` };
  }

  async login(): Promise<NapAuthState> {
    try {
      await this.appServer.start();
      const login = await this.startManagedAppServerLogin();
      appendDaemonLog(`[provider] opening app-server login URL id=${login.loginId}`);
      await openExternalUrl(login.authUrl);
      await this.waitForAppServerLogin(login.loginId);
      return parseAppServerAccountAuthState(await this.appServer.readAccount({ refreshToken: true }));
    } catch (error) {
      appendDaemonLog(`[provider] app-server login failed: ${error instanceof Error ? error.message : String(error)}`);
      return { status: 'signedOut', label: `Sign in with Nap (${this.cliPath})` };
    }
  }

  async logout(): Promise<NapAuthState> {
    try {
      await this.appServer.start();
      await this.appServer.logoutAccount();
    } catch {
      try {
        await this.runText(['logout'], 8000);
      } catch {
        // Status check can correct this later.
      }
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
    let threadId = await this.getOrStartThread(threadKey, request);
    const activeThreadIds = new Set([threadId]);
    stream.onThread?.(threadId);
    stream.onLog(`Starting Nap app-server turn in thread ${threadId}.`);

    let turnId: string | undefined;
    let cleanupCompleted: (() => void) | undefined;
    const activityBuffers = new Map<string, ProviderActivity>();
    const completed = new Promise<void>((resolve, reject) => {
      const cleanup = this.appServer.onNotification(notification => {
        if (!notificationMatchesAnyTurn(notification, activeThreadIds, turnId)) {
          return;
        }

        const delta = parseAppServerDelta(notification);
        if (delta) {
          stream.onDelta(delta);
        }
        const activity = parseAppServerActivityEvent(notification);
        if (activity !== undefined) {
          stream.onActivity(mergeActivity(activityBuffers, activity));
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
      const started = await this.startTurnWithFreshThreadFallback(threadKey, threadId, activeThreadIds, request);
      threadId = started.threadId;
      stream.onThread?.(threadId);
      const turnResult = started.result;
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

  private async handleAppServerRequest(request: NapAppServerRequest): Promise<unknown> {
    if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
      appendDaemonLog(`[provider] auto-approving app-server request method=${request.method}`);
      return { decision: 'accept' };
    }

    if (request.method !== 'account/chatgptAuthTokens/refresh') {
      return undefined;
    }

    appendDaemonLog('[provider] app-server requested external auth refresh; managed app-server login is required');
    throw new Error('Nap managed app-server login is required. Sign out and sign in again.');
  }

  private async startManagedAppServerLogin(): Promise<{ loginId: string; authUrl: string }> {
    try {
      return parseManagedLoginResponse(await this.appServer.loginAccount({
        type: 'chatgpt',
        napStreamlinedLogin: true
      }));
    } catch (error) {
      if (!isExternalAuthActiveError(error)) {
        throw error;
      }

      appendDaemonLog('[provider] clearing external auth before starting managed app-server login');
      await this.appServer.logoutAccount();
      return parseManagedLoginResponse(await this.appServer.loginAccount({
        type: 'chatgpt',
        napStreamlinedLogin: true
      }));
    }
  }

  private async getOrStartThread(threadKey: string, request: ProviderPromptRequest): Promise<string> {
    const existing = this.appThreads.get(threadKey);
    if (existing) {
      return existing;
    }

    if (request.appThreadId) {
      try {
        const resumedThreadId = await resumeThread(this.appServer, request.appThreadId, request);
        this.appThreads.set(threadKey, resumedThreadId);
        return resumedThreadId;
      } catch (error) {
        appendDaemonLog(`[provider] failed to resume app-server thread ${request.appThreadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const threadId = await getInitializedThread(this.appServer, request);
    this.appThreads.set(threadKey, threadId);
    return threadId;
  }

  private async startTurnWithFreshThreadFallback(
    threadKey: string,
    threadId: string,
    activeThreadIds: Set<string>,
    request: ProviderPromptRequest
  ): Promise<{ threadId: string; result: unknown }> {
    try {
      return { threadId, result: await this.startTurn(threadId, request) };
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        throw error;
      }

      appendDaemonLog(`[provider] app-server thread ${threadId} was stale; starting a fresh thread and retrying turn.`);
      this.appThreads.delete(threadKey);
      const freshThreadId = await getInitializedThread(this.appServer, {
        ...request,
        appThreadId: undefined
      });
      this.appThreads.set(threadKey, freshThreadId);
      activeThreadIds.add(freshThreadId);
      return { threadId: freshThreadId, result: await this.startTurn(freshThreadId, request) };
    }
  }

  private async startTurn(threadId: string, request: ProviderPromptRequest): Promise<unknown> {
    return this.appServer.startTurn({
      threadId,
      input: [{ type: 'text', text: buildTurnText(request) }],
      cwd: request.workspaceRoot ?? process.cwd(),
      model: request.modelId === 'auto' ? AUTO_MODEL_ID : request.modelId,
      approvalPolicy: 'on-request',
      sandboxPolicy: request.securityMode === 'strict'
        ? { mode: 'read-only' }
        : { mode: 'workspace-write' }
    });
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

  private async waitForAppServerLogin(loginId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Nap login timed out.'));
      }, 10 * 60 * 1000);
      const cleanup = this.appServer.onNotification(notification => {
        if (notification.method !== 'account/login/completed') {
          return;
        }
        const params = readObject(notification.params);
        const eventLoginId = readString(params?.loginId) ?? readString(params?.login_id);
        if (eventLoginId && eventLoginId !== loginId) {
          return;
        }
        cleanup();
        clearTimeout(timeout);
        if (params?.success === true) {
          resolve();
          return;
        }
        reject(new Error(readString(params?.error) ?? 'Nap login failed.'));
      });
    });
  }
}

function parseManagedLoginResponse(response: unknown): { loginId: string; authUrl: string } {
  const record = readObject(response);
  const loginId = readString(record?.loginId) ?? readString(record?.login_id);
  const authUrl = readString(record?.authUrl) ?? readString(record?.auth_url);
  if (record?.type !== 'chatgpt' || !loginId || !authUrl) {
    throw new Error('Nap app-server did not return a managed login URL.');
  }
  return { loginId, authUrl };
}

function isExternalAuthActiveError(error: unknown): boolean {
  return error instanceof Error && /External auth is active/i.test(error.message);
}

function isThreadNotFoundError(error: unknown): boolean {
  return error instanceof Error && /thread not found/i.test(error.message);
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

async function resumeThread(client: NapAppServerClient, threadId: string, request: ProviderPromptRequest): Promise<string> {
  const result = await client.resumeThread({
    threadId,
    cwd: request.workspaceRoot ?? process.cwd(),
    model: request.modelId === 'auto' ? AUTO_MODEL_ID : request.modelId,
    approvalPolicy: 'on-request',
    sandbox: request.securityMode === 'strict' ? 'read-only' : 'workspace-write'
  });
  return readThreadId(result) ?? threadId;
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

function notificationMatchesAnyTurn(notification: NapAppServerNotification, threadIds: Set<string>, turnId: string | undefined): boolean {
  for (const threadId of threadIds) {
    if (notificationMatchesTurn(notification, threadId, turnId)) {
      return true;
    }
  }
  return false;
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
  return parseAppServerActivityEvent(notification)?.text;
}

export function parseAppServerActivityEvent(notification: NapAppServerNotification): ProviderActivity | undefined {
  const params = readObject(notification.params);
  const item = readObject(params?.item);
  const status = readObject(params?.status);
  const itemType = readString(item?.type);
  const itemId = readString(params?.itemId) ?? readString(params?.item_id) ?? readString(item?.id);
  const method = notification.method;
  const text = readActivityText(params)
    ?? readActivityText(item)
    ?? readActivityText(status);

  if (method === 'item/agentMessage/delta') {
    return undefined;
  }

  if (method === 'item/reasoning/textDelta') {
    return deltaActivity(params, itemId, 'reasoning');
  }

  if (method === 'item/reasoning/summaryTextDelta') {
    return deltaActivity(params, itemId, 'thinking');
  }

  if (method === 'item/plan/delta') {
    return deltaActivity(params, itemId, 'plan');
  }

  if (method === 'item/commandExecution/outputDelta' || method === 'command/exec/outputDelta' || method === 'process/outputDelta') {
    return withActivityMetadata(deltaActivity(params, itemId, 'command'), params, item);
  }

  if (method === 'item/fileChange/outputDelta' || method === 'item/fileChange/patchUpdated') {
    return withActivityMetadata(
      deltaActivity(params, itemId, 'file') ?? { text: 'Updating files', kind: 'file', itemId },
      params,
      item
    );
  }

  if (method === 'warning' || method === 'guardianWarning' || method === 'configWarning' || method === 'deprecationNotice') {
    return { text: text ?? readString(params?.message) ?? 'Warning', kind: 'warning', itemId };
  }

  if (method === 'error') {
    return { text: text ?? readString(params?.message) ?? 'Error', kind: 'error', itemId };
  }

  if (method === 'thread/status/changed') {
    const statusType = readString(status?.type);
    if (statusType === 'idle') {
      return undefined;
    }
    const flags = readStringArray(status?.activeFlags);
    if (flags.includes('waitingOnApproval')) {
      return { text: text ?? 'Waiting on approval', kind: 'warning', itemId };
    }
    if (flags.includes('waitingOnUserInput')) {
      return { text: text ?? 'Waiting on input', kind: 'warning', itemId };
    }
    return { text: statusType === 'active' ? text ?? 'Working' : text ?? titleCase(statusType) ?? 'Working', kind: 'status', itemId };
  }

  if (method.includes('/reasoning') || method.includes('/thought')) {
    return { text: text ?? 'Thinking', kind: 'reasoning', itemId };
  }

  if (method.includes('/tool') || method.includes('/function')) {
    return { text: text ?? toolActivityText(item, 'Running tool'), kind: 'tool', itemId };
  }

  if (method.includes('/status') || method.includes('/progress')) {
    const statusText = text ?? statusActivityText(params, status);
    return statusText ? { text: statusText, kind: 'status', itemId } : undefined;
  }

  switch (method) {
    case 'turn/started':
      return { text: text ?? 'Thinking', kind: 'thinking', itemId };
    case 'mcpServer/startupStatus/updated': {
      const name = readString(params?.name) ?? 'MCP server';
      const serverStatus = readString(params?.status);
      if (serverStatus === 'starting') {
        return { text: `Starting ${name}`, kind: 'tool', itemId };
      }
      if (serverStatus === 'failed') {
        return undefined;
      }
      return serverStatus ? { text: `${titleCase(serverStatus)} ${name}`, kind: 'tool', itemId } : undefined;
    }
    case 'item/started':
      if (itemType === 'reasoning') {
        return { text: text ?? 'Thinking', kind: 'reasoning', itemId };
      }
      if (isToolItemType(itemType)) {
        return withActivityMetadata(
          { text: text ?? toolActivityText(item, 'Running tool'), kind: itemType === 'commandExecution' ? 'command' : 'tool', itemId },
          params,
          item
        );
      }
      if (itemType === 'fileChange') {
        return withActivityMetadata({ text: text ?? 'Editing files', kind: 'file', itemId }, params, item);
      }
      if (itemType === 'plan') {
        return { text: text ?? 'Planning', kind: 'plan', itemId };
      }
      if (isStatusItemType(itemType)) {
        const statusText = text ?? statusActivityText(params, status);
        return statusText ? { text: statusText, kind: 'status', itemId } : undefined;
      }
      if (itemType === 'agentMessage') {
        const phase = readString(item?.phase);
        return { text: text ?? (phase === 'commentary' ? 'Working' : 'Writing'), kind: phase === 'commentary' ? 'thinking' : 'writing', itemId };
      }
      return text ? { text, kind: 'status', itemId } : undefined;
    case 'item/completed':
      if (itemType === 'reasoning') {
        return { text: text ?? 'Writing', kind: 'writing', itemId };
      }
      if (isToolItemType(itemType)) {
        return undefined;
      }
      return isStatusItemType(itemType) && text ? { text, kind: 'status', itemId } : undefined;
    case 'turn/completed':
      return undefined;
    default:
      return text ? { text, kind: 'status', itemId } : undefined;
  }
}

function mergeActivity(activityBuffers: Map<string, ProviderActivity>, activity: ProviderActivity): ProviderActivity {
  if (!activity.append) {
    return activity;
  }

  const key = activity.itemId ?? activity.kind;
  const previous = activityBuffers.get(key);
  const text = `${previous?.text ?? ''}${activity.text}`.trimStart();
  const merged = {
    ...activity,
    text: truncateMiddle(text, 240),
    append: false
  };
  activityBuffers.set(key, merged);
  return merged;
}

function withActivityMetadata(
  activity: ProviderActivity | undefined,
  params: Record<string, unknown> | undefined,
  item: Record<string, unknown> | undefined
): ProviderActivity | undefined {
  if (!activity) {
    return undefined;
  }

  const command = readCommandText(params, item);
  const filePath = readFilePath(params, item);
  const patch = readPatchStats(params, item, activity.text);
  const toolName = readString(item?.name)
    ?? readString(item?.toolName)
    ?? readString(item?.functionName)
    ?? readString(params?.name);
  const verb = inferActivityVerb(activity.kind, activity.text, command, filePath, toolName);
  const title = formatActivityTitle(verb, activity.kind, activity.text, command, filePath, toolName);

  return {
    ...activity,
    verb,
    filePath,
    title,
    detail: command && title !== command ? command : undefined,
    additions: patch.additions,
    deletions: patch.deletions
  };
}

function deltaActivity(params: Record<string, unknown> | undefined, itemId: string | undefined, kind: NapActivityKind): ProviderActivity | undefined {
  const delta = readDeltaString(params?.delta)
    ?? decodeBase64(readString(params?.deltaBase64));
  return delta ? { text: delta, kind, append: true, itemId } : undefined;
}

function inferActivityVerb(
  kind: NapActivityKind,
  text: string,
  command: string | undefined,
  filePath: string | undefined,
  toolName: string | undefined
): NapActivityVerb {
  const haystack = `${toolName ?? ''} ${command ?? ''} ${text}`.toLowerCase();
  if (kind === 'file') {
    return 'edit';
  }
  if (/\b(rg|grep|find|search|glob)\b/.test(haystack)) {
    return 'search';
  }
  if (/\b(read|open|cat|sed|head|tail|git diff)\b/.test(haystack) || filePath) {
    return 'read';
  }
  if (kind === 'command') {
    return 'run';
  }
  if (kind === 'warning') {
    return 'warn';
  }
  if (kind === 'error') {
    return 'error';
  }
  if (kind === 'writing') {
    return 'write';
  }
  return 'status';
}

function formatActivityTitle(
  verb: NapActivityVerb,
  kind: NapActivityKind,
  text: string,
  command: string | undefined,
  filePath: string | undefined,
  toolName: string | undefined
): string {
  const fileName = filePath ? path.basename(filePath) : undefined;
  if (verb === 'edit') {
    return fileName ? `Edited ${fileName}` : 'Edited files';
  }
  if (verb === 'read') {
    if (command && /\bgit\s+diff\b/.test(command)) {
      return 'Read changes';
    }
    return fileName ? `Read ${fileName}` : formatShortActivity(text, 'Read a file');
  }
  if (verb === 'search') {
    const pattern = readSearchPattern(command);
    return pattern ? `Searched for ${pattern}` : formatShortActivity(text, 'Searched code');
  }
  if (verb === 'run') {
    return command ? `Ran ${firstCommandWord(command)}` : formatShortActivity(text, 'Ran command');
  }
  if (toolName) {
    return `${titleCase(toolName) ?? toolName}`;
  }
  return formatShortActivity(text, activityKindLabel(kind));
}

function readCommandText(params: Record<string, unknown> | undefined, item: Record<string, unknown> | undefined): string | undefined {
  const command = readString(item?.command)
    ?? readString(item?.cmd)
    ?? readString(params?.command)
    ?? readString(params?.cmd);
  const args = readStringArray(item?.args).length ? readStringArray(item?.args) : readStringArray(params?.args);
  if (command && args.length > 0) {
    return unwrapShellCommand(command, args);
  }
  return command ? unwrapInlineShellCommand(command) : undefined;
}

function readFilePath(params: Record<string, unknown> | undefined, item: Record<string, unknown> | undefined): string | undefined {
  return readString(item?.filePath)
    ?? readString(item?.path)
    ?? readString(item?.uri)
    ?? readString(params?.filePath)
    ?? readString(params?.path)
    ?? readString(params?.uri);
}

function readPatchStats(
  params: Record<string, unknown> | undefined,
  item: Record<string, unknown> | undefined,
  text: string
): { additions?: number; deletions?: number } {
  const additions = readNumber(item?.additions)
    ?? readNumber(params?.additions)
    ?? readNumber(item?.added)
    ?? readNumber(params?.added);
  const deletions = readNumber(item?.deletions)
    ?? readNumber(params?.deletions)
    ?? readNumber(item?.removed)
    ?? readNumber(params?.removed);
  if (additions !== undefined || deletions !== undefined) {
    return { additions, deletions };
  }

  let inferredAdditions = 0;
  let inferredDeletions = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      inferredAdditions += 1;
    } else if (line.startsWith('-')) {
      inferredDeletions += 1;
    }
  }
  return inferredAdditions || inferredDeletions
    ? { additions: inferredAdditions, deletions: inferredDeletions }
    : {};
}

function readSearchPattern(command: string | undefined): string | undefined {
  if (!command) {
    return undefined;
  }
  const match = command.match(/\b(?:rg|grep)\s+(?:-[A-Za-z]+\s+)*["']([^"']+)["']|\b(?:rg|grep)\s+(?:-[A-Za-z]+\s+)*([^\s]+)/);
  return (match?.[1] ?? match?.[2])?.trim();
}

function firstCommandWord(command: string): string {
  return command.trim().split(/\s+/, 1)[0] ?? 'command';
}

function unwrapShellCommand(command: string, args: string[]): string {
  const shellName = path.basename(command);
  if ((shellName === 'zsh' || shellName === 'bash' || shellName === 'sh') && args[0] === '-lc' && args[1]) {
    return args[1];
  }
  return [command, ...args].join(' ');
}

function unwrapInlineShellCommand(command: string): string {
  const trimmed = command.trim();
  const match = trimmed.match(/(?:^|\s)(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+(["'])([\s\S]*)\1$/);
  return match?.[2]?.replace(/\\"/g, '"').trim() ?? trimmed;
}

function formatShortActivity(text: string, fallback: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean ? truncateMiddle(clean, 90) : fallback;
}

function activityKindLabel(kind: NapActivityKind): string {
  switch (kind) {
    case 'reasoning':
      return 'Reasoning';
    case 'plan':
      return 'Plan';
    case 'tool':
      return 'Tool';
    case 'command':
      return 'Command';
    case 'file':
      return 'Files';
    case 'warning':
      return 'Warning';
    case 'error':
      return 'Error';
    case 'writing':
      return 'Writing';
    case 'status':
      return 'Status';
    default:
      return 'Thinking';
  }
}

function readActivityText(record: Record<string, unknown> | undefined): string | undefined {
  return readString(record?.activity)
    ?? readString(record?.activityText)
    ?? readString(record?.statusText)
    ?? readString(record?.summary)
    ?? readString(record?.message)
    ?? readString(record?.title)
    ?? readString(record?.text)
    ?? readString(record?.content);
}

function toolActivityText(item: Record<string, unknown> | undefined, fallback: string): string {
  const name = readString(item?.name)
    ?? readString(item?.toolName)
    ?? readString(item?.functionName)
    ?? readString(item?.command);
  return name ? `Running ${name}` : fallback;
}

function statusActivityText(params: Record<string, unknown> | undefined, status: Record<string, unknown> | undefined): string | undefined {
  const value = readString(status?.type)
    ?? readString(status?.state)
    ?? readString(status?.status)
    ?? readString(params?.status)
    ?? readString(params?.state);
  return value ? titleCase(value) : undefined;
}

function isToolItemType(itemType: string | undefined): boolean {
  return itemType === 'toolCall'
    || itemType === 'functionCall'
    || itemType === 'command'
    || itemType === 'commandExecution'
    || itemType === 'shellCommand'
    || itemType === 'mcpToolCall';
}

function isStatusItemType(itemType: string | undefined): boolean {
  return itemType === 'status'
    || itemType === 'progress'
    || itemType === 'log'
    || itemType === 'notice';
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

export function parseAppServerAccountAuthState(result: unknown): NapAuthState {
  const record = readObject(result);
  const account = readObject(record?.account);
  const accountType = readString(account?.type);
  if (!account || !accountType) {
    return {
      status: 'signedOut',
      label: record?.requiresOpenaiAuth === false ? 'Nap account not required' : 'Sign in with Nap'
    };
  }

  if (accountType === 'chatgpt') {
    const email = readString(account.email);
    const planType = readString(account.planType) ?? readString(account.plan_type);
    return enrichAuthState({
      status: 'authenticated',
      label: email ?? 'Nap account',
      accountEmail: email,
      accountName: email,
      planType
    }, false);
  }

  if (accountType === 'apiKey') {
    return {
      status: 'authenticated',
      label: 'Nap API key'
    };
  }

  return {
    status: 'authenticated',
    label: 'Nap account'
  };
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

export function readPersistedAuthState(napHome = process.env.NAP_HOME ?? path.join(os.homedir(), '.nap')): NapAuthState | undefined {
  for (const fileName of ['auth.json', 'service-auth.json']) {
    const record = readJsonObject(path.join(napHome, fileName));
    if (!record) {
      continue;
    }

    const token = getAuthAccessToken(record);
    const refreshToken = getAuthRefreshToken(record);
    if (!token && !refreshToken) {
      continue;
    }
    if (!refreshToken && token && isJwtExpired(token, readNumber(record.expiresAt))) {
      continue;
    }

    const profile = profileFromRecord(record);
    const label = profile.accountName ?? profile.accountEmail ?? 'Nap account';
    return {
      status: 'authenticated',
      label,
      accountName: profile.accountName,
      accountEmail: profile.accountEmail,
      avatarUrl: profile.avatarUrl
    };
  }

  return undefined;
}

function profileFromRecord(record: Record<string, unknown>): Partial<Pick<NapAuthState, 'accountName' | 'accountEmail' | 'avatarUrl'>> {
  const user = readObject(record.user) ?? readObject(record.account) ?? readObject(record.profile);
  const tokens = readObject(record.tokens);
  const tokenProfile = profileFromJwt(
    readString(record.accessToken)
      ?? readString(record.idToken)
      ?? readString(record.token)
      ?? readString(tokens?.id_token)
      ?? readString(tokens?.access_token)
  );
  return {
    accountName: readString(record.name) ?? readString(record.accountName) ?? readString(record.username) ?? readString(user?.name) ?? readString(user?.username) ?? tokenProfile.accountName,
    accountEmail: readString(record.email) ?? readString(record.accountEmail) ?? readString(user?.email) ?? tokenProfile.accountEmail,
    avatarUrl: readString(record.avatarUrl) ?? readString(record.avatar) ?? readString(record.picture) ?? readString(user?.avatarUrl) ?? readString(user?.avatar) ?? readString(user?.picture) ?? tokenProfile.avatarUrl
  };
}

function getAuthAccessToken(record: Record<string, unknown>): string | undefined {
  const tokens = readObject(record.tokens);
  return readString(record.accessToken)
    ?? readString(record.access_token)
    ?? readString(record.token)
    ?? readString(tokens?.access_token)
    ?? readString(tokens?.id_token);
}

function getAuthRefreshToken(record: Record<string, unknown>): string | undefined {
  const tokens = readObject(record.tokens);
  return readString(record.refreshToken)
    ?? readString(record.refresh_token)
    ?? readString(tokens?.refresh_token);
}

function isJwtExpired(token: string, fallbackExpiresAt?: number): boolean {
  const [, payload] = token.split('.');
  if (payload) {
    try {
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
      const claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
      const exp = readNumber(claims.exp);
      if (exp) {
        return exp * 1000 <= Date.now();
      }
    } catch {
      // Fall back to expiresAt below.
    }
  }

  return typeof fallbackExpiresAt === 'number' && fallbackExpiresAt <= Date.now();
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

async function openExternalUrl(url: string): Promise<void> {
  const command = process.platform === 'darwin'
    ? { cmd: 'open', args: [url] }
    : process.platform === 'win32'
      ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
      : { cmd: 'xdg-open', args: [url] };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.cmd, command.args, {
      env: process.env,
      stdio: 'ignore',
      detached: true
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
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

function parsePluginListResponse(response: unknown): NapPluginSummary[] {
  const record = readObject(response);
  const marketplaces = Array.isArray(record?.marketplaces) ? record.marketplaces : [];
  const plugins: NapPluginSummary[] = [];
  const seen = new Set<string>();

  for (const marketplace of marketplaces) {
    const marketplaceRecord = readObject(marketplace);
    const marketplacePlugins = Array.isArray(marketplaceRecord?.plugins) ? marketplaceRecord.plugins : [];
    for (const item of marketplacePlugins) {
      const plugin = readObject(item);
      if (!plugin) {
        continue;
      }

      const id = readString(plugin.id) ?? readString(plugin.name);
      const name = readString(plugin.name) ?? id;
      if (!id || !name || seen.has(id)) {
        continue;
      }

      const pluginInterface = readObject(plugin.interface);
      const label = readString(pluginInterface?.displayName) ?? titleCase(name) ?? name;
      const description = readString(pluginInterface?.shortDescription)
        ?? readString(pluginInterface?.longDescription);

      seen.add(id);
      plugins.push({
        id,
        name,
        label,
        description,
        installed: plugin.installed === true,
        enabled: plugin.enabled !== false
      });
    }
  }

  return plugins.sort((a, b) => {
    if (a.installed !== b.installed) {
      return a.installed ? -1 : 1;
    }
    return a.label.localeCompare(b.label);
  });
}

function ensureDefaultModelOption(models: NapModelOption[]): NapModelOption[] {
  const withoutAuto = models.filter(model => model.id !== 'auto');
  const existingIndex = withoutAuto.findIndex(model => model.id === AUTO_MODEL_ID);
  if (existingIndex === -1) {
    return [DEFAULT_MODEL_OPTION, ...withoutAuto];
  }

  return withoutAuto.map((model, index) => index === existingIndex
    ? { ...DEFAULT_MODEL_OPTION, ...model, label: DEFAULT_MODEL_OPTION.label, description: model.description ?? DEFAULT_MODEL_OPTION.description }
    : model);
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

function readDeltaString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function decodeBase64(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
