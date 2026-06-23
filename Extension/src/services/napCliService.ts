import * as path from 'node:path';
import * as vscode from 'vscode';
import { getNapConfiguration } from '../configuration';
import {
  NapActivityKind,
  NapAuthState,
  NapLogEvent,
  NapMcpState,
  NapMode,
  NapModelOption,
  NapPluginSummary,
  NapSecurityMode,
  NapSessionRecord,
  NapSessionSummary
} from '../shared/protocol';
import { NapDaemonClient } from '../nap/client';
import {
  NapSessionRecord as DaemonSessionRecord,
  SessionActivityEvent,
  SessionDiffUpdatedEvent,
  SessionMessageDeltaEvent,
  SessionMessageDoneEvent
} from '../nap/protocol';
import { generateSessionTitleFromPrompt } from '../shared/sessionTitle';

export interface NapPromptRequest {
  sessionId: string;
  prompt: string;
  mode: NapMode;
  modelId: string;
  debugMode: boolean;
  securityMode: NapSecurityMode;
}

export interface NapPromptStream {
  onDelta(delta: string): void;
  onActivity(activity: Partial<SessionActivityEvent> | undefined): void;
  onTurnDiff?(event: SessionDiffUpdatedEvent): void;
  onLog(event: NapLogEvent): void;
}

export interface INapCliService extends vscode.Disposable {
  ensureInteractiveTerminal(): void;
  sendSlashCommand(command: string): void;
  login(): Promise<NapAuthState>;
  logout(): Promise<NapAuthState>;
  getModels(defaultModelId: string): Promise<NapModelOption[]>;
  getAuthState(): Promise<NapAuthState>;
  getMcpState(): Promise<NapMcpState>;
  getPlugins(): Promise<NapPluginSummary[]>;
  listSessions(): Promise<NapSessionSummary[]>;
  getSession(sessionId: string): Promise<NapSessionRecord>;
  deleteSession(sessionId: string): Promise<void>;
  saveSession(session: NapSessionRecord): void;
  streamPrompt(request: NapPromptRequest, stream: NapPromptStream, token: vscode.CancellationToken): Promise<void>;
}

export class NapDaemonService implements INapCliService {
  private readonly client: NapDaemonClient;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel
  ) {
    this.client = new NapDaemonClient({
      workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      daemonEntry: path.join(extensionUri.fsPath, 'out', 'nap', 'daemon', 'server.js'),
      cliPath: getNapConfiguration().cliPath,
      extensionVersion: vscode.extensions.getExtension('NapCode.nap')?.packageJSON?.version
    });
  }

  dispose(): void {
    void this.client.dispose();
    this.output.appendLine('[Nap] Daemon client disposed.');
  }

  ensureInteractiveTerminal(): void {
    void this.client.connect().then(
      () => this.output.appendLine('[Nap] Connected to napd.'),
      error => this.output.appendLine(`[Nap] napd connection failed: ${getErrorMessage(error)}`)
    );
  }

  sendSlashCommand(command: string): void {
    if (command === '/login') {
      void this.login();
      return;
    }

    this.output.appendLine(`[Nap] Unsupported daemon command: ${command}`);
  }

  async login(): Promise<NapAuthState> {
    const auth = await this.client.login();
    this.rememberAuth(auth);
    this.output.appendLine(`[Nap] Auth: ${auth.label}`);
    return auth;
  }

  async logout(): Promise<NapAuthState> {
    const auth = await this.client.logout();
    this.rememberAuth(auth);
    this.output.appendLine(`[Nap] Auth: ${auth.label}`);
    return auth;
  }

  async getModels(defaultModelId: string): Promise<NapModelOption[]> {
    const result = await this.client.listModels(defaultModelId);
    return result.models;
  }

  async getAuthState(): Promise<NapAuthState> {
    const auth = await this.client.authStatus();
    return this.rememberAuth(auth);
  }

  async getMcpState(): Promise<NapMcpState> {
    return this.client.mcpServers();
  }

  async getPlugins(): Promise<NapPluginSummary[]> {
    const result = await this.client.listPlugins();
    return result.plugins;
  }

  async listSessions(): Promise<NapSessionSummary[]> {
    const sessions = await this.client.listSessions();
    return sessions
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(toSessionSummary);
  }

  async getSession(sessionId: string): Promise<NapSessionRecord> {
    return toSharedSessionRecord(await this.client.getSession(sessionId));
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.client.deleteSession(sessionId);
  }

  saveSession(_session: NapSessionRecord): void {
    // Session persistence is daemon-owned in the active architecture.
  }

  async streamPrompt(request: NapPromptRequest, stream: NapPromptStream, token: vscode.CancellationToken): Promise<void> {
    const auth = await this.getAuthState();
    if (auth.status !== 'authenticated') {
      throw new Error('Sign in with Nap CLI before using chat.');
    }

    await this.client.createSession({
      sessionId: request.sessionId,
      mode: request.mode,
      modelId: request.modelId,
      debugMode: request.debugMode,
      securityMode: request.securityMode
    });

    let jobId: string | undefined;
    let doneStatus: SessionMessageDoneEvent['status'] | undefined;
    let cleanupActivity: (() => void) | undefined;
    let cleanupDelta: (() => void) | undefined;
    let cleanupDiff: (() => void) | undefined;
    let cleanupDone: (() => void) | undefined;
    let cleanupClose: (() => void) | undefined;

    const done = new Promise<void>((resolve, reject) => {
      cleanupActivity = this.client.on<SessionActivityEvent>('session.activity', event => {
        if (event.sessionId === request.sessionId && (!jobId || event.jobId === jobId)) {
          stream.onActivity(event);
        }
      });
      cleanupDelta = this.client.on<SessionMessageDeltaEvent>('session.message.delta', event => {
        if (event.sessionId === request.sessionId && (!jobId || event.jobId === jobId)) {
          stream.onDelta(event.delta);
        }
      });
      cleanupDiff = this.client.on<SessionDiffUpdatedEvent>('session.diff.updated', event => {
        if (event.sessionId === request.sessionId && (!jobId || event.jobId === jobId)) {
          stream.onTurnDiff?.(event);
        }
      });
      cleanupDone = this.client.on<SessionMessageDoneEvent>('session.message.done', event => {
        if (event.sessionId === request.sessionId && (!jobId || event.jobId === jobId)) {
          doneStatus = event.status;
          if (event.status === 'error') {
            void this.client.getJob(event.jobId).then(job => {
              reject(new Error(job?.error || 'Nap chat job failed before returning a response.'));
            }, () => {
              reject(new Error('Nap chat job failed before returning a response.'));
            });
          } else {
            resolve();
          }
        }
      });
      cleanupClose = this.client.onClose(error => {
        reject(error);
      });
    });

    const cancellation = token.onCancellationRequested(() => {
      void this.client.stopSession({ sessionId: request.sessionId, jobId });
    });

    try {
      const result = await this.client.sendMessage({
        sessionId: request.sessionId,
        prompt: request.prompt,
        mode: request.mode,
        modelId: request.modelId,
        debugMode: request.debugMode,
        securityMode: request.securityMode
      });
      jobId = result.jobId;
      stream.onLog(createLog('info', `napd job ${jobId} started.`));
      await done;
      if (doneStatus === 'stopped') {
        throw new vscode.CancellationError();
      }
    } finally {
      cleanupActivity?.();
      cleanupDelta?.();
      cleanupDiff?.();
      cleanupDone?.();
      cleanupClose?.();
      cancellation.dispose();
    }
  }

  private rememberAuth(auth: NapAuthState): NapAuthState {
    return auth;
  }
}

function toSessionSummary(session: DaemonSessionRecord): NapSessionSummary {
  const firstUserMessage = session.messages.find(message => message.role === 'user')?.content.trim() ?? '';
  const preview = firstUserMessage || session.messages[0]?.content.trim() || '';
  const storedTitle = session.title?.trim() ?? '';
  const title = isWeakGeneratedTitle(storedTitle, firstUserMessage)
    ? generateSessionTitleFromPrompt(firstUserMessage, '')
    : storedTitle || generateSessionTitleFromPrompt(preview, '') || 'New Chat';

  return {
    id: session.id,
    title,
    preview: truncateText(preview, 84),
    messageCount: session.messages.length,
    updatedAt: session.updatedAt
  };
}

function toSharedSessionRecord(session: DaemonSessionRecord): NapSessionRecord {
  const firstUserMessage = session.messages.find(message => message.role === 'user')?.content.trim() ?? '';
  const title = isWeakGeneratedTitle(session.title, firstUserMessage)
    ? generateSessionTitleFromPrompt(firstUserMessage, 'New Chat')
    : session.title;

  return {
    id: session.id,
    workspaceRoot: session.workspaceRoot,
    appThreadId: session.appThreadId,
    title,
    mode: session.mode,
    modelId: session.modelId,
    debugMode: session.debugMode,
    securityMode: session.securityMode,
    messages: session.messages,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

function isWeakGeneratedTitle(title: string | undefined, prompt: string): boolean {
  const cleanedTitle = title?.trim();
  if (!cleanedTitle || cleanedTitle === 'New Chat' || !prompt.trim()) {
    return true;
  }

  const titleWords = cleanedTitle.split(/\s+/).filter(Boolean);
  const promptWords = prompt.split(/\s+/).filter(Boolean);
  return titleWords.length <= 1 && promptWords.length >= 4;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function createLog(level: NapLogEvent['level'], message: string): NapLogEvent {
  return {
    id: `log-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    level,
    message,
    source: 'nap-cli',
    createdAt: Date.now()
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
