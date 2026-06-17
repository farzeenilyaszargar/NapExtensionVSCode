import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  NapAuthState,
  NapLogEvent,
  NapMcpState,
  NapMode,
  NapModelOption,
  NapSecurityMode,
  NapSessionRecord,
  NapSessionSummary
} from '../shared/protocol';
import { NapDaemonClient } from '../nap/client';
import {
  NapSessionRecord as DaemonSessionRecord,
  SessionMessageDeltaEvent,
  SessionMessageDoneEvent
} from '../nap/protocol';

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
  onLog(event: NapLogEvent): void;
}

export interface INapCliService extends vscode.Disposable {
  ensureInteractiveTerminal(): void;
  sendSlashCommand(command: string): void;
  login(): Promise<NapAuthState>;
  getModels(defaultModelId: string): Promise<NapModelOption[]>;
  getAuthState(): Promise<NapAuthState>;
  getMcpState(): Promise<NapMcpState>;
  listSessions(): Promise<NapSessionSummary[]>;
  getSession(sessionId: string): Promise<NapSessionRecord>;
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
      daemonEntry: path.join(extensionUri.fsPath, 'out', 'nap', 'daemon', 'server.js')
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
    this.output.appendLine(`[Nap] Auth: ${auth.label}`);
    return auth;
  }

  async getModels(defaultModelId: string): Promise<NapModelOption[]> {
    const result = await this.client.listModels(defaultModelId);
    return result.models;
  }

  async getAuthState(): Promise<NapAuthState> {
    return this.client.authStatus();
  }

  async getMcpState(): Promise<NapMcpState> {
    return this.client.mcpServers();
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

  saveSession(_session: NapSessionRecord): void {
    // Session persistence is daemon-owned in the active architecture.
  }

  async streamPrompt(request: NapPromptRequest, stream: NapPromptStream, token: vscode.CancellationToken): Promise<void> {
    const auth = await this.client.authStatus();
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
    let cleanupDelta: (() => void) | undefined;
    let cleanupDone: (() => void) | undefined;
    let cleanupClose: (() => void) | undefined;

    const done = new Promise<void>((resolve, reject) => {
      cleanupDelta = this.client.on<SessionMessageDeltaEvent>('session.message.delta', event => {
        if (event.sessionId === request.sessionId && (!jobId || event.jobId === jobId)) {
          stream.onDelta(event.delta);
        }
      });
      cleanupDone = this.client.on<SessionMessageDoneEvent>('session.message.done', event => {
        if (event.sessionId === request.sessionId && (!jobId || event.jobId === jobId)) {
          doneStatus = event.status;
          event.status === 'error' ? reject(new Error('napd chat job failed.')) : resolve();
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
      cleanupDelta?.();
      cleanupDone?.();
      cleanupClose?.();
      cancellation.dispose();
    }
  }
}

function toSessionSummary(session: DaemonSessionRecord): NapSessionSummary {
  const firstUserMessage = session.messages.find(message => message.role === 'user')?.content.trim() ?? '';
  const preview = firstUserMessage || session.messages[0]?.content.trim() || '';
  const title = session.title?.trim() || truncateText(preview, 42) || 'New Chat';

  return {
    id: session.id,
    title,
    preview: truncateText(preview, 84),
    messageCount: session.messages.length,
    updatedAt: session.updatedAt
  };
}

function toSharedSessionRecord(session: DaemonSessionRecord): NapSessionRecord {
  return {
    id: session.id,
    workspaceRoot: session.workspaceRoot,
    title: session.title,
    mode: session.mode,
    modelId: session.modelId,
    debugMode: session.debugMode,
    securityMode: session.securityMode,
    messages: session.messages,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
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
