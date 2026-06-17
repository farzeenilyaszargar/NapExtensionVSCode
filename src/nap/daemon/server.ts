import * as crypto from 'node:crypto';
import * as http from 'node:http';
import {
  AuthChangedEvent,
  CacheStatus,
  createNapId,
  DaemonHealth,
  DaemonLogEvent,
  JobEvent,
  JsonRpcFailure,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccess,
  McpChangedEvent,
  ModelListResult,
  NAP_DAEMON_PROTOCOL_VERSION,
  NapJobRecord,
  NapRpcEvent,
  NapRpcMethod,
  NapSessionRecord,
  SessionCreateParams,
  SessionMessageDeltaEvent,
  SessionMessageDoneEvent,
  SessionSendMessageParams,
  SessionStopParams,
  WorkspaceIndexStatus
} from '../protocol';
import { attachWebSocketUpgrade, MinimalWsConnection } from '../ws';
import { clearRuntimeInfo, ensureNapDataDir, writeRuntimeInfo } from '../runtimePaths';
import { DaemonStorage } from './storage';
import { NapBackendProviderAdapter, ProviderAdapter } from './provider';
import {
  NapAuthState,
  NapLogEvent,
  NapMcpState,
  NapMessage,
  NapMode,
  NapSecurityMode
} from '../../shared/protocol';

interface ActiveJob {
  job: NapJobRecord;
  abort: AbortController;
}

export class NapDaemon {
  private readonly server = http.createServer();
  private readonly clients = new Set<MinimalWsConnection>();
  private readonly startedAt = Date.now();
  private readonly storage = new DaemonStorage();
  private readonly provider: ProviderAdapter;
  private readonly token: string;
  private readonly activeJobs = new Map<string, ActiveJob>();
  private mcpState: NapMcpState = { status: 'disabled', servers: [] };
  private authState: NapAuthState = { status: 'unknown', label: 'Unknown' };

  constructor(options: { provider?: ProviderAdapter; token?: string } = {}) {
    this.provider = options.provider ?? new NapBackendProviderAdapter();
    this.token = options.token ?? crypto.randomBytes(24).toString('hex');
  }

  async start(): Promise<void> {
    ensureNapDataDir();
    attachWebSocketUpgrade(this.server, {
      token: this.token,
      onConnection: connection => this.registerConnection(connection)
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(0, '127.0.0.1');
    });

    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('napd failed to bind a local port.');
    }

    writeRuntimeInfo({
      version: NAP_DAEMON_PROTOCOL_VERSION,
      pid: process.pid,
      port: address.port,
      token: this.token,
      startedAt: this.startedAt
    });

    await this.refreshAuthState();
    this.log('info', `napd listening on 127.0.0.1:${address.port}`);
  }

  async stop(): Promise<void> {
    for (const { abort } of this.activeJobs.values()) {
      abort.abort();
    }
    for (const client of this.clients) {
      client.close();
    }
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    clearRuntimeInfo();
  }

  private registerConnection(connection: MinimalWsConnection): void {
    this.clients.add(connection);
    connection.onClose(() => this.clients.delete(connection));
    connection.onMessage(message => {
      void this.handleRawMessage(connection, message);
    });
  }

  private async handleRawMessage(connection: MinimalWsConnection, raw: string): Promise<void> {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      connection.send(JSON.stringify(this.error(null, -32700, 'Invalid JSON-RPC payload.')));
      return;
    }

    if (!isRequest(message)) {
      return;
    }

    try {
      const result = await this.handleRequest(message.method, message.params);
      connection.send(JSON.stringify(this.success(message.id, result)));
    } catch (error) {
      connection.send(JSON.stringify(this.error(message.id, -32000, error instanceof Error ? error.message : String(error))));
    }
  }

  private async handleRequest(method: NapRpcMethod, params: unknown): Promise<unknown> {
    switch (method) {
      case 'daemon.health':
        return this.health();
      case 'daemon.version':
        return { version: NAP_DAEMON_PROTOCOL_VERSION };
      case 'daemon.shutdown':
        setTimeout(() => void this.stop(), 10);
        return { ok: true };
      case 'sessions.list':
        return this.storage.listSessions();
      case 'sessions.create':
        return this.createSession(params as SessionCreateParams);
      case 'sessions.get':
        return this.getSession(requireParam(params, 'sessionId'));
      case 'sessions.delete':
        this.storage.deleteSession(requireParam(params, 'sessionId'));
        return { ok: true };
      case 'sessions.sendMessage':
        return this.sendMessage(params as SessionSendMessageParams);
      case 'sessions.stop':
        return this.stopSession(params as SessionStopParams);
      case 'jobs.list':
        return this.storage.listJobs();
      case 'jobs.get':
        return this.storage.getJob(requireParam(params, 'jobId'));
      case 'jobs.cancel':
        return this.cancelJob(requireParam(params, 'jobId'));
      case 'models.list':
        return this.listModels(params as { defaultModelId?: string });
      case 'models.setDefault':
        this.storage.setDefaultModelId(requireParam(params, 'modelId'));
        return this.listModels({});
      case 'auth.status':
        return this.refreshAuthState();
      case 'auth.login':
        this.authState = await this.provider.login();
        this.broadcast('auth.changed', this.authEvent(undefined));
        return this.authState;
      case 'auth.logout':
        this.authState = await this.provider.logout();
        this.broadcast('auth.changed', this.authEvent(undefined));
        return this.authState;
      case 'mcp.listServers':
        return this.mcpState;
      case 'mcp.connect':
      case 'mcp.disconnect':
        this.broadcast('mcp.server.changed', this.mcpEvent(undefined));
        return this.mcpState;
      case 'workspace.open':
        return this.storage.getWorkspaceIndex((params as { workspaceRoot?: string } | undefined)?.workspaceRoot);
      case 'workspace.indexStatus':
        return this.storage.getWorkspaceIndex((params as { workspaceRoot?: string } | undefined)?.workspaceRoot);
      case 'workspace.reindex':
        return this.reindexWorkspace((params as { workspaceRoot?: string } | undefined)?.workspaceRoot);
      case 'cache.status':
        return this.storage.getCacheStatus();
      case 'cache.clear':
        return this.storage.clearCache();
    }
  }

  private health(): DaemonHealth {
    return {
      ok: true,
      version: NAP_DAEMON_PROTOCOL_VERSION,
      pid: process.pid,
      uptimeMs: Date.now() - this.startedAt
    };
  }

  private createSession(params: SessionCreateParams | undefined): NapSessionRecord {
    const now = Date.now();
    const session: NapSessionRecord = {
      id: params?.sessionId ?? createNapId('session'),
      workspaceRoot: params?.workspaceRoot,
      title: 'New Chat',
      mode: params?.mode ?? 'chat',
      modelId: params?.modelId ?? this.storage.getDefaultModelId(),
      debugMode: params?.debugMode ?? false,
      securityMode: params?.securityMode ?? 'standard',
      messages: [],
      createdAt: now,
      updatedAt: now
    };
    this.storage.upsertSession(session);
    return session;
  }

  private getSession(sessionId: string): NapSessionRecord {
    return this.storage.getSession(sessionId) ?? this.createSession({ clientId: 'daemon', sessionId });
  }

  private async sendMessage(params: SessionSendMessageParams): Promise<{ jobId: string; session: NapSessionRecord; assistantMessageId: string }> {
    const session = this.storage.getSession(params.sessionId) ?? this.createSession(params);
    const now = Date.now();
    const userMessage: NapMessage = {
      id: createNapId('user'),
      role: 'user',
      content: params.prompt,
      status: 'complete',
      createdAt: now
    };
    const assistantMessage: NapMessage = {
      id: createNapId('assistant'),
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: now
    };
    const updatedSession: NapSessionRecord = {
      ...session,
      mode: params.mode,
      modelId: params.modelId,
      debugMode: params.debugMode,
      securityMode: params.securityMode,
      messages: [...session.messages, userMessage, assistantMessage],
      updatedAt: now
    };
    this.storage.upsertSession(updatedSession);

    const job: NapJobRecord = {
      id: createNapId('job'),
      kind: 'chat',
      status: 'running',
      workspaceRoot: params.workspaceRoot,
      sessionId: updatedSession.id,
      cancellable: true,
      progress: 0,
      label: 'Generating response',
      createdAt: now,
      updatedAt: now
    };
    const abort = new AbortController();
    this.activeJobs.set(job.id, { job, abort });
    this.storage.upsertJob(job);
    this.broadcast('job.created', this.jobEvent(job));

    void this.runChatJob(updatedSession, assistantMessage.id, job, params, abort);
    return { jobId: job.id, session: updatedSession, assistantMessageId: assistantMessage.id };
  }

  private async runChatJob(
    session: NapSessionRecord,
    assistantMessageId: string,
    job: NapJobRecord,
    params: SessionSendMessageParams,
    abort: AbortController
  ): Promise<void> {
    try {
      await this.provider.streamPrompt({
        prompt: params.prompt,
        mode: params.mode,
        modelId: params.modelId,
        debugMode: params.debugMode,
        securityMode: params.securityMode,
        workspaceRoot: params.workspaceRoot
      }, {
        onDelta: delta => {
          this.appendAssistantDelta(session.id, assistantMessageId, delta);
          job.progress = Math.min(95, job.progress + 5);
          job.updatedAt = Date.now();
          this.storage.upsertJob(job);
          this.broadcast('session.message.delta', this.deltaEvent(session, assistantMessageId, job.id, delta));
          this.broadcast('job.progress', this.jobEvent(job));
        },
        onLog: message => this.log('info', message, params.workspaceRoot, session.id, job.id)
      }, abort.signal);

      this.finishAssistant(session.id, assistantMessageId, 'complete');
      job.status = 'done';
      job.progress = 100;
      job.updatedAt = Date.now();
      this.storage.upsertJob(job);
      this.broadcast('session.message.done', this.doneEvent(session, assistantMessageId, job.id, 'complete'));
      this.broadcast('job.done', this.jobEvent(job));
    } catch (error) {
      const cancelled = abort.signal.aborted;
      this.finishAssistant(session.id, assistantMessageId, cancelled ? 'stopped' : 'error');
      job.status = cancelled ? 'cancelled' : 'error';
      job.error = cancelled ? undefined : error instanceof Error ? error.message : String(error);
      job.updatedAt = Date.now();
      this.storage.upsertJob(job);
      this.broadcast('session.message.done', this.doneEvent(session, assistantMessageId, job.id, cancelled ? 'stopped' : 'error'));
      this.broadcast(cancelled ? 'job.done' : 'job.error', this.jobEvent(job));
    } finally {
      this.activeJobs.delete(job.id);
    }
  }

  private stopSession(params: SessionStopParams): { ok: true } {
    const active = [...this.activeJobs.values()].find(item =>
      item.job.sessionId === params.sessionId && (!params.jobId || item.job.id === params.jobId)
    );
    active?.abort.abort();
    return { ok: true };
  }

  private cancelJob(jobId: string): { ok: true } {
    this.activeJobs.get(jobId)?.abort.abort();
    return { ok: true };
  }

  private async listModels(params: { defaultModelId?: string }): Promise<ModelListResult> {
    const selectedModelId = this.storage.getDefaultModelId() || params.defaultModelId || 'auto';
    const models = await this.provider.listModels(selectedModelId);
    return { models, selectedModelId: models.some(model => model.id === selectedModelId) ? selectedModelId : models[0]?.id ?? 'auto' };
  }

  private async refreshAuthState(): Promise<NapAuthState> {
    this.authState = await this.provider.authStatus();
    return this.authState;
  }

  private reindexWorkspace(workspaceRoot?: string): WorkspaceIndexStatus {
    const index: WorkspaceIndexStatus = {
      workspaceRoot,
      status: 'ready',
      indexedFiles: 0,
      updatedAt: Date.now()
    };
    this.storage.upsertWorkspaceIndex(index);
    this.broadcast('workspace.index.progress', {
      eventId: createNapId('event'),
      createdAt: Date.now(),
      workspaceRoot,
      status: index.status,
      indexedFiles: index.indexedFiles
    });
    this.broadcast('workspace.index.done', {
      eventId: createNapId('event'),
      createdAt: Date.now(),
      workspaceRoot,
      status: index.status,
      indexedFiles: index.indexedFiles
    });
    return index;
  }

  private appendAssistantDelta(sessionId: string, messageId: string, delta: string): void {
    const session = this.storage.getSession(sessionId);
    if (!session) {
      return;
    }
    const updated = {
      ...session,
      messages: session.messages.map(message => message.id === messageId
        ? { ...message, content: message.content + delta, status: 'streaming' as const }
        : message),
      updatedAt: Date.now()
    };
    this.storage.upsertSession(updated);
  }

  private finishAssistant(sessionId: string, messageId: string, status: NapMessage['status']): void {
    const session = this.storage.getSession(sessionId);
    if (!session) {
      return;
    }
    this.storage.upsertSession({
      ...session,
      messages: session.messages.map(message => message.id === messageId ? { ...message, status } : message),
      updatedAt: Date.now()
    });
  }

  private broadcast<T>(method: NapRpcEvent, params: T): void {
    const notification: JsonRpcNotification<T> = {
      jsonrpc: '2.0',
      method,
      params
    };
    const serialized = JSON.stringify(notification);
    for (const client of this.clients) {
      client.send(serialized);
    }
  }

  private deltaEvent(session: NapSessionRecord, messageId: string, jobId: string, delta: string): SessionMessageDeltaEvent {
    return {
      eventId: createNapId('event'),
      createdAt: Date.now(),
      workspaceRoot: session.workspaceRoot,
      sessionId: session.id,
      clientId: 'napd',
      messageId,
      jobId,
      delta
    };
  }

  private doneEvent(session: NapSessionRecord, messageId: string, jobId: string, status: 'complete' | 'stopped' | 'error'): SessionMessageDoneEvent {
    return {
      eventId: createNapId('event'),
      createdAt: Date.now(),
      workspaceRoot: session.workspaceRoot,
      sessionId: session.id,
      clientId: 'napd',
      messageId,
      jobId,
      status
    };
  }

  private jobEvent(job: NapJobRecord): JobEvent {
    return {
      eventId: createNapId('event'),
      createdAt: Date.now(),
      workspaceRoot: job.workspaceRoot,
      sessionId: job.sessionId,
      clientId: 'napd',
      jobId: job.id,
      job
    };
  }

  private authEvent(workspaceRoot?: string): AuthChangedEvent {
    return {
      eventId: createNapId('event'),
      createdAt: Date.now(),
      workspaceRoot,
      clientId: 'napd',
      auth: this.authState
    };
  }

  private mcpEvent(workspaceRoot?: string): McpChangedEvent {
    return {
      eventId: createNapId('event'),
      createdAt: Date.now(),
      workspaceRoot,
      clientId: 'napd',
      mcp: this.mcpState
    };
  }

  private log(level: NapLogEvent['level'], message: string, workspaceRoot?: string, sessionId?: string, jobId?: string): void {
    const log: NapLogEvent = {
      id: createNapId('log'),
      level,
      message,
      source: 'nap-cli',
      createdAt: Date.now()
    };
    const event: DaemonLogEvent = {
      eventId: createNapId('event'),
      createdAt: Date.now(),
      workspaceRoot,
      sessionId,
      clientId: 'napd',
      jobId,
      log
    };
    this.broadcast('daemon.log', event);
  }

  private success(id: string | number, result: unknown): JsonRpcSuccess {
    return { jsonrpc: '2.0', id, result };
  }

  private error(id: string | number | null, code: number, message: string): JsonRpcFailure {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return message.jsonrpc === '2.0' && 'id' in message && 'method' in message;
}

function requireParam(params: unknown, key: string): string {
  if (!params || typeof params !== 'object') {
    throw new Error(`Missing parameter: ${key}`);
  }
  const value = (params as Record<string, unknown>)[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Missing parameter: ${key}`);
  }
  return value;
}

export async function startNapDaemon(): Promise<NapDaemon> {
  const daemon = new NapDaemon();
  await daemon.start();
  return daemon;
}

if (require.main === module) {
  startNapDaemon().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
