import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendDaemonLog } from './runtimePaths';

export type NapAppServerId = number;

export interface NapAppServerRequest<TParams = unknown> {
  id: NapAppServerId;
  method: string;
  params?: TParams;
}

export interface NapAppServerNotification<TParams = unknown> {
  method: string;
  params?: TParams;
}

export interface NapAppServerSuccess<TResult = unknown> {
  id: NapAppServerId;
  result: TResult;
}

export interface NapAppServerFailure {
  id: NapAppServerId;
  error: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export type NapAppServerMessage =
  | NapAppServerRequest
  | NapAppServerNotification
  | NapAppServerSuccess
  | NapAppServerFailure;

export interface StartThreadParams {
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  approvalPolicy?: string;
  sandbox?: string;
}

export interface ResumeThreadParams extends StartThreadParams {
  threadId: string;
}

export interface StartTurnParams {
  threadId: string;
  input: Array<{ type: 'text'; text: string; text_elements: [] }>;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  approvalPolicy?: string;
  sandbox?: string;
}

export type LoginAccountParams =
  | {
    type: 'chatgpt';
    napStreamlinedLogin?: boolean;
  }
  | {
    type: 'chatgptAuthTokens';
    accessToken: string;
    chatgptAccountId: string;
    chatgptPlanType?: string;
  };

export interface GetAccountParams {
  refreshToken?: boolean;
}

export interface NapCliCommand {
  command: string;
  args: string[];
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
};

type NotificationHandler = (notification: NapAppServerNotification) => void;
type RequestHandler = (request: NapAppServerRequest) => Promise<unknown> | unknown | undefined;
type SpawnFunction = typeof spawn;

export class NapAppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private stdoutBuffer = '';
  private readonly pending = new Map<NapAppServerId, PendingRequest>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly requestHandlers = new Set<RequestHandler>();
  private startPromise: Promise<void> | undefined;
  private initialized = false;
  private readonly requestTimeoutMs = 30000;
  private readonly initializeTimeoutMs = 30000;

  constructor(
    private readonly extensionVersion: string,
    private readonly spawnProcess: SpawnFunction = spawn
  ) {}

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onRequest(handler: RequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async initialize(): Promise<void> {
    await this.start();
    if (!this.initialized) {
      await this.sendInitialize();
    }
  }

  private async sendInitialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    try {
      await this.request('initialize', {
        clientInfo: {
          name: 'nap_extension',
          title: 'Nap Extension',
          version: this.extensionVersion
        },
        capabilities: {
          experimentalApi: true
        }
      }, this.initializeTimeoutMs);
    } catch (error) {
      this.stop();
      throw error;
    }
    this.notify('initialized');
    this.initialized = true;
  }

  async startThread(params: StartThreadParams): Promise<unknown> {
    return this.request('thread/start', params);
  }

  async resumeThread(params: ResumeThreadParams): Promise<unknown> {
    return this.request('thread/resume', params);
  }

  async startTurn(params: StartTurnParams): Promise<unknown> {
    return this.request('turn/start', params);
  }

  async loginAccount(params: LoginAccountParams): Promise<unknown> {
    return this.request('account/login/start', params);
  }

  async readAccount(params: GetAccountParams = {}): Promise<unknown> {
    return this.request('account/read', params);
  }

  async logoutAccount(): Promise<unknown> {
    return this.request('account/logout');
  }

  async request<TResult = unknown, TParams = unknown>(method: string, params?: TParams, timeoutMs = this.requestTimeoutMs): Promise<TResult> {
    if (!this.child) {
      await this.start();
    }
    const id = this.nextId++;
    const message: NapAppServerRequest<TParams> = { id, method, params };
    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Nap app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timeout);
          resolve(value as TResult);
        },
        reject: error => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout
      });
      this.write(message);
    });
  }

  notify<TParams = unknown>(method: string, params?: TParams): void {
    if (!this.child) {
      throw new Error('Nap app-server is not running.');
    }
    this.write({ method, params });
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    this.stdoutBuffer = '';
    this.initialized = false;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Nap app-server stopped.'));
    }
    this.pending.clear();

    if (child && !child.killed) {
      child.kill();
    }
  }

  dispose(): void {
    this.stop();
    this.notificationHandlers.clear();
  }

  private async startProcess(): Promise<void> {
    const command = resolveNapCliCommand(['app-server', '--listen', 'stdio://']);
    appendDaemonLog(`[app-server] spawn: ${command.command} ${command.args.join(' ')}`);

    const child = this.spawnProcess(command.command, command.args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;

    child.stdout.on('data', (data: Buffer) => this.handleStdout(data));
    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString('utf8');
      appendDaemonLog(`[app-server:stderr] ${stripAnsi(text).trim()}`);
    });
    child.on('error', error => {
      appendDaemonLog(`[app-server] process error: ${error.message}`);
      this.rejectAll(error);
      if (this.child === child) {
        this.child = undefined;
      }
    });
    child.on('close', code => {
      appendDaemonLog(`[app-server] closed code=${code ?? 'unknown'}`);
      this.rejectAll(new Error(`Nap app-server exited with code ${code ?? 'unknown'}.`));
      if (this.child === child) {
        this.child = undefined;
      }
    });

    await this.sendInitialize();
  }

  private handleStdout(data: Buffer): void {
    this.stdoutBuffer += data.toString('utf8');
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message: NapAppServerMessage;
    try {
      message = JSON.parse(trimmed) as NapAppServerMessage;
    } catch {
      appendDaemonLog(`[app-server] non-json stdout: ${stripAnsi(trimmed).slice(0, 500)}`);
      return;
    }

    if (isResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        appendDaemonLog(`[app-server] response for unknown id=${message.id}`);
        return;
      }
      this.pending.delete(message.id);
      if ('error' in message) {
        pending.reject(errorFromResponse(message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (isServerRequest(message)) {
      void this.handleServerRequest(message);
      return;
    }

    if (isNotification(message)) {
      for (const handler of this.notificationHandlers) {
        handler(message);
      }
    }
  }

  private write(message: NapAppServerRequest | NapAppServerNotification): void {
    if (!this.child) {
      throw new Error('Nap app-server is not running.');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async handleServerRequest(request: NapAppServerRequest): Promise<void> {
    for (const handler of this.requestHandlers) {
      try {
        const result = await handler(request);
        if (result !== undefined) {
          this.write({
            id: request.id,
            result
          } as unknown as NapAppServerRequest);
          return;
        }
      } catch (error) {
        this.write({
          id: request.id,
          error: {
            message: error instanceof Error ? error.message : String(error)
          }
        } as unknown as NapAppServerRequest);
        return;
      }
    }

    appendDaemonLog(`[app-server] unhandled server request method=${request.method}`);
    this.write({
      id: request.id,
      error: {
        message: `Unhandled app-server request: ${request.method}`
      }
    } as unknown as NapAppServerRequest);
  }
}

export function resolveNapCliCommand(args: string[], cliPath = 'nap'): NapCliCommand {
  if (cliPath && cliPath !== 'nap') {
    return {
      command: cliPath,
      args
    };
  }

  return resolveBundledDarwinArm64NapCommand(args);
}

function resolveBundledDarwinArm64NapCommand(args: string[]): NapCliCommand {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Bundled Nap CLI is pinned to @nap-ai/cli@0.0.26-darwin-arm64 and can only run on macOS arm64.');
  }

  try {
    // The extension is compiled to CommonJS, so require.resolve is available.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const packageJson = require.resolve('@nap-ai/cli-darwin-arm64/package.json') as string;
    const napBinary = path.join(path.dirname(packageJson), 'vendor', 'aarch64-apple-darwin', 'bin', 'nap');
    if (!fs.existsSync(napBinary)) {
      throw new Error(`Missing native Nap binary at ${napBinary}`);
    }
    return {
      command: napBinary,
      args
    };
  } catch (error) {
    appendDaemonLog(`[app-server] bundled @nap-ai/cli@0.0.26-darwin-arm64 not available: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

function isResponse(message: NapAppServerMessage): message is NapAppServerSuccess | NapAppServerFailure {
  return typeof (message as { id?: unknown }).id === 'number'
    && ('result' in message || 'error' in message)
    && !('method' in message);
}

function isServerRequest(message: NapAppServerMessage): message is NapAppServerRequest {
  return typeof (message as { id?: unknown }).id === 'number'
    && typeof (message as { method?: unknown }).method === 'string'
    && !('result' in message)
    && !('error' in message);
}

function isNotification(message: NapAppServerMessage): message is NapAppServerNotification {
  return typeof (message as { method?: unknown }).method === 'string' && !('id' in message);
}

function errorFromResponse(message: NapAppServerFailure): Error {
  const error = message.error;
  const detail = typeof error?.message === 'string' ? error.message : 'Nap app-server request failed.';
  return new Error(detail);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}
