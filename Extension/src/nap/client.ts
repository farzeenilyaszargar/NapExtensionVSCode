import { spawn } from 'node:child_process';
import * as path from 'node:path';
import {
  AuthChangedEvent,
  CacheStatus,
  DaemonHealth,
  DaemonRuntimeInfo,
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
  WorkspaceIndexStatus,
  createNapId
} from './protocol';
import { clearRuntimeInfo, readRuntimeInfo } from './runtimePaths';
import { connectWebSocket, MinimalWsConnection } from './ws';
import { NapAuthState, NapMcpState } from '../shared/protocol';

export type NapDaemonEvent =
  | JsonRpcNotification<SessionMessageDeltaEvent>
  | JsonRpcNotification<SessionMessageDoneEvent>
  | JsonRpcNotification<JobEvent>
  | JsonRpcNotification<AuthChangedEvent>
  | JsonRpcNotification<McpChangedEvent>
  | JsonRpcNotification<unknown>;

type EventHandler<T = unknown> = (event: T) => void;

export class NapDaemonClient {
  private connection: MinimalWsConnection | undefined;
  private connecting: Promise<void> | undefined;
  private pending = new Map<string | number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private handlers = new Map<NapRpcEvent, Set<EventHandler>>();
  private closeHandlers = new Set<(error: Error) => void>();
  private readonly clientId = createNapId('client');

  constructor(
    private readonly options: {
      workspaceRoot?: string;
      daemonEntry?: string;
      nodePath?: string;
      cliPath?: string;
      extensionVersion?: string;
      spawnDaemon?: boolean;
    } = {}
  ) {}

  async dispose(): Promise<void> {
    this.connection?.close();
    this.connection = undefined;
    this.pending.clear();
  }

  on<T>(event: NapRpcEvent, handler: EventHandler<T>): () => void {
    const handlers = this.handlers.get(event) ?? new Set<EventHandler>();
    handlers.add(handler as EventHandler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler as EventHandler);
  }

  onClose(handler: (error: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async connect(): Promise<void> {
    if (this.connection) {
      return;
    }

    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.openConnection().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async health(): Promise<DaemonHealth> {
    return this.request('daemon.health', {});
  }

  async shutdown(): Promise<{ ok: true }> {
    return this.request('daemon.shutdown', {});
  }

  async createSession(params: Omit<SessionCreateParams, 'clientId' | 'workspaceRoot'> = {}): Promise<NapSessionRecord> {
    return this.request('sessions.create', this.withEnvelope(params));
  }

  async listSessions(): Promise<NapSessionRecord[]> {
    return this.request('sessions.list', this.withEnvelope({}));
  }

  async getSession(sessionId: string): Promise<NapSessionRecord> {
    return this.request('sessions.get', this.withEnvelope({ sessionId }));
  }

  async deleteSession(sessionId: string): Promise<{ ok: true }> {
    return this.request('sessions.delete', this.withEnvelope({ sessionId }));
  }

  async sendMessage(params: Omit<SessionSendMessageParams, 'clientId' | 'workspaceRoot'>): Promise<{ jobId: string; session: NapSessionRecord; assistantMessageId: string }> {
    return this.request('sessions.sendMessage', this.withEnvelope(params));
  }

  async stopSession(params: Omit<SessionStopParams, 'clientId' | 'workspaceRoot'>): Promise<{ ok: true }> {
    return this.request('sessions.stop', this.withEnvelope(params));
  }

  async listJobs(): Promise<NapJobRecord[]> {
    return this.request('jobs.list', this.withEnvelope({}));
  }

  async cancelJob(jobId: string): Promise<{ ok: true }> {
    return this.request('jobs.cancel', this.withEnvelope({ jobId }));
  }

  async listModels(defaultModelId: string): Promise<ModelListResult> {
    return this.request('models.list', this.withEnvelope({ defaultModelId }));
  }

  async setDefaultModel(modelId: string): Promise<ModelListResult> {
    return this.request('models.setDefault', this.withEnvelope({ modelId }));
  }

  async authStatus(): Promise<NapAuthState> {
    return this.request('auth.status', this.withEnvelope({}));
  }

  async login(): Promise<NapAuthState> {
    return this.request('auth.login', this.withEnvelope({}));
  }

  async logout(): Promise<NapAuthState> {
    return this.request('auth.logout', this.withEnvelope({}));
  }

  async mcpServers(): Promise<NapMcpState> {
    return this.request('mcp.listServers', this.withEnvelope({}));
  }

  async indexStatus(): Promise<WorkspaceIndexStatus> {
    return this.request('workspace.indexStatus', this.withEnvelope({}));
  }

  async reindex(): Promise<WorkspaceIndexStatus> {
    return this.request('workspace.reindex', this.withEnvelope({}));
  }

  async cacheStatus(): Promise<CacheStatus> {
    return this.request('cache.status', this.withEnvelope({}));
  }

  async clearCache(): Promise<CacheStatus> {
    return this.request('cache.clear', this.withEnvelope({}));
  }

  private async request<TResult, TParams>(method: NapRpcMethod, params: TParams): Promise<TResult> {
    await this.connect();
    if (!this.connection) {
      throw new Error('napd connection unavailable.');
    }

    const id = createNapId('rpc');
    const request: JsonRpcRequest<TParams> = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };
    const response = new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => resolve(value as TResult),
        reject
      });
    });
    this.connection.send(JSON.stringify(request));
    return response;
  }

  private async openConnection(): Promise<void> {
    const runtime = await this.getOrStartRuntime();
    const connection = await connectWebSocket(runtime.port, runtime.token);
    this.connection = connection;
    connection.onMessage(raw => this.handleMessage(raw));
    connection.onClose(() => {
      if (this.connection !== connection) {
        return;
      }

      const error = new Error('napd connection closed.');
      this.connection = undefined;
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      for (const handler of this.closeHandlers) {
        handler(error);
      }
    });
  }

  private handleMessage(raw: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return;
    }

    if (isSuccess(message)) {
      this.pending.get(message.id)?.resolve(message.result);
      this.pending.delete(message.id);
      return;
    }

    if (isFailure(message)) {
      this.pending.get(message.id ?? '')?.reject(new Error(message.error.message));
      this.pending.delete(message.id ?? '');
      return;
    }

    if (isNotification(message)) {
      const handlers = this.handlers.get(message.method);
      if (handlers) {
        for (const handler of handlers) {
          handler(message.params);
        }
      }
    }
  }

  private withEnvelope<T extends object>(params: T): T & { clientId: string; workspaceRoot?: string } {
    return {
      ...params,
      clientId: this.clientId,
      workspaceRoot: this.options.workspaceRoot
    };
  }

  private async getOrStartRuntime(): Promise<DaemonRuntimeInfo> {
    const existing = readRuntimeInfo();
    if (existing) {
      if (existing.version !== NAP_DAEMON_PROTOCOL_VERSION) {
        this.stopStaleRuntime(existing);
        clearRuntimeInfo();
      } else {
        try {
          const connection = await connectWebSocket(existing.port, existing.token);
          connection.close();
          return existing;
        } catch {
          clearRuntimeInfo();
        }
      }
    }

    if (this.options.spawnDaemon === false) {
      throw new Error('napd is not running.');
    }

    this.spawnDaemon();
    const started = Date.now();
    while (Date.now() - started < 8000) {
      await delay(150);
      const runtime = readRuntimeInfo();
      if (runtime) {
        if (runtime.version !== NAP_DAEMON_PROTOCOL_VERSION) {
          this.stopStaleRuntime(runtime);
          clearRuntimeInfo();
          continue;
        }
        try {
          const connection = await connectWebSocket(runtime.port, runtime.token);
          connection.close();
          return runtime;
        } catch {
          // Still starting.
        }
      }
    }

    throw new Error('Timed out waiting for napd to start.');
  }

  private spawnDaemon(): void {
    const daemonEntry = this.options.daemonEntry ?? path.join(__dirname, 'daemon', 'server.js');
    const nodePath = this.options.nodePath ?? process.env.NAP_NODE_PATH ?? 'node';
    const child = spawn(nodePath, [daemonEntry], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        NAP_CLI: this.options.cliPath ?? process.env.NAP_CLI,
        NAP_EXTENSION_VERSION: this.options.extensionVersion ?? process.env.NAP_EXTENSION_VERSION
      }
    });
    child.unref();
  }

  private stopStaleRuntime(runtime: DaemonRuntimeInfo): void {
    try {
      process.kill(runtime.pid);
    } catch {
      // Best-effort cleanup; clearing metadata is enough for the new daemon to start.
    }
  }
}

function isSuccess(message: JsonRpcMessage): message is JsonRpcSuccess {
  return message.jsonrpc === '2.0' && 'result' in message && 'id' in message;
}

function isFailure(message: JsonRpcMessage): message is JsonRpcFailure {
  return message.jsonrpc === '2.0' && 'error' in message && 'id' in message;
}

function isNotification(message: JsonRpcMessage): message is NapDaemonEvent {
  return message.jsonrpc === '2.0' && 'method' in message && 'params' in message && !('id' in message);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
