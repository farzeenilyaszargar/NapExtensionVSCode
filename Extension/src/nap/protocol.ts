import {
  NapActivityKind,
  NapActivityVerb,
  NapAuthState,
  NapLogEvent,
  NapMcpState,
  NapMessage,
  NapMode,
  NapModelOption,
  NapSecurityMode
} from '../shared/protocol';

export const NAP_DAEMON_PROTOCOL_VERSION = 3;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  method: NapRpcMethod;
  params?: TParams;
}

export interface JsonRpcSuccess<TResult = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  result: TResult;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: '2.0';
  method: NapRpcEvent;
  params: TParams;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification;

export type NapRpcMethod =
  | 'daemon.health'
  | 'daemon.version'
  | 'daemon.shutdown'
  | 'sessions.list'
  | 'sessions.create'
  | 'sessions.get'
  | 'sessions.delete'
  | 'sessions.sendMessage'
  | 'sessions.stop'
  | 'jobs.list'
  | 'jobs.get'
  | 'jobs.cancel'
  | 'models.list'
  | 'models.setDefault'
  | 'auth.status'
  | 'auth.login'
  | 'auth.logout'
  | 'mcp.listServers'
  | 'mcp.connect'
  | 'mcp.disconnect'
  | 'workspace.open'
  | 'workspace.indexStatus'
  | 'workspace.reindex'
  | 'cache.status'
  | 'cache.clear';

export type NapRpcEvent =
  | 'session.message.delta'
  | 'session.message.done'
  | 'session.activity'
  | 'job.created'
  | 'job.progress'
  | 'job.done'
  | 'job.error'
  | 'workspace.index.progress'
  | 'workspace.index.done'
  | 'mcp.server.changed'
  | 'auth.changed'
  | 'daemon.log';

export interface NapRpcEnvelope {
  clientId: string;
  workspaceRoot?: string;
  sessionId?: string;
}

export interface DaemonRuntimeInfo {
  version: number;
  pid: number;
  port: number;
  token: string;
  startedAt: number;
}

export interface DaemonHealth {
  ok: true;
  version: number;
  pid: number;
  uptimeMs: number;
}

export interface NapSessionRecord {
  id: string;
  workspaceRoot?: string;
  appThreadId?: string;
  title: string;
  mode: NapMode;
  modelId: string;
  debugMode: boolean;
  securityMode: NapSecurityMode;
  messages: NapMessage[];
  createdAt: number;
  updatedAt: number;
}

export type NapJobStatus = 'queued' | 'running' | 'done' | 'cancelled' | 'error';
export type NapJobKind = 'chat' | 'index' | 'mcp' | 'auth' | 'cache';

export interface NapJobRecord {
  id: string;
  kind: NapJobKind;
  status: NapJobStatus;
  workspaceRoot?: string;
  sessionId?: string;
  cancellable: boolean;
  progress: number;
  label: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionCreateParams extends NapRpcEnvelope {
  sessionId?: string;
  mode?: NapMode;
  modelId?: string;
  debugMode?: boolean;
  securityMode?: NapSecurityMode;
}

export interface SessionSendMessageParams extends NapRpcEnvelope {
  sessionId: string;
  prompt: string;
  mode: NapMode;
  modelId: string;
  debugMode: boolean;
  securityMode: NapSecurityMode;
}

export interface SessionStopParams extends NapRpcEnvelope {
  sessionId: string;
  jobId?: string;
}

export interface ModelListResult {
  models: NapModelOption[];
  selectedModelId: string;
}

export interface WorkspaceIndexStatus {
  workspaceRoot?: string;
  status: 'idle' | 'indexing' | 'ready' | 'error';
  indexedFiles: number;
  updatedAt?: number;
}

export interface CacheStatus {
  entries: number;
  bytes: number;
  updatedAt?: number;
}

export interface SessionMessageDeltaEvent extends NapRpcEnvelope {
  eventId: string;
  createdAt: number;
  messageId: string;
  jobId: string;
  delta: string;
}

export interface SessionMessageDoneEvent extends NapRpcEnvelope {
  eventId: string;
  createdAt: number;
  messageId: string;
  jobId: string;
  status: 'complete' | 'stopped' | 'error';
}

export interface SessionActivityEvent extends NapRpcEnvelope {
  eventId: string;
  createdAt: number;
  jobId: string;
  text?: string;
  kind?: NapActivityKind;
  verb?: NapActivityVerb;
  filePath?: string;
  title?: string;
  detail?: string;
  additions?: number;
  deletions?: number;
  itemId?: string;
}

export interface JobEvent extends NapRpcEnvelope {
  eventId: string;
  createdAt: number;
  jobId: string;
  job: NapJobRecord;
}

export interface DaemonLogEvent extends NapRpcEnvelope {
  eventId: string;
  createdAt: number;
  jobId?: string;
  log: NapLogEvent;
}

export interface AuthChangedEvent extends NapRpcEnvelope {
  eventId: string;
  createdAt: number;
  auth: NapAuthState;
}

export interface McpChangedEvent extends NapRpcEnvelope {
  eventId: string;
  createdAt: number;
  mcp: NapMcpState;
}

export function createNapId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
