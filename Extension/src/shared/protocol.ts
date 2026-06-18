export const NAP_DEFAULT_ACCENT = '';

export const NAP_MODES = ['chat', 'plan', 'debug', 'security'] as const;
export type NapMode = typeof NAP_MODES[number];

export const NAP_SECURITY_MODES = ['standard', 'strict'] as const;
export type NapSecurityMode = typeof NAP_SECURITY_MODES[number];

export type NapRunStatus = 'idle' | 'streaming' | 'stopped' | 'error';
export type NapMessageRole = 'user' | 'assistant' | 'system';
export type NapMessageStatus = 'complete' | 'streaming' | 'stopped' | 'error';
export type NapLogLevel = 'trace' | 'info' | 'warn' | 'error';

export interface NapConfigurationSnapshot {
  cliPath: string;
  accentColor: string;
  defaultModel: string;
  debugMode: boolean;
  securityMode: NapSecurityMode;
}

export interface NapMessage {
  id: string;
  role: NapMessageRole;
  content: string;
  createdAt: number;
  status: NapMessageStatus;
}

export interface NapLogEvent {
  id: string;
  level: NapLogLevel;
  message: string;
  source: 'extension' | 'nap-cli' | 'webview';
  createdAt: number;
}

export interface NapModelOption {
  id: string;
  label: string;
  description?: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
}

export interface NapSessionSummary {
  id: string;
  title: string;
  preview: string;
  messageCount: number;
  updatedAt: number;
}

export interface NapSessionRecord {
  id: string;
  workspaceRoot?: string;
  title: string;
  mode: NapMode;
  modelId: string;
  debugMode: boolean;
  securityMode: NapSecurityMode;
  messages: NapMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface NapAuthState {
  status: 'mock' | 'unknown' | 'authenticated' | 'signedOut';
  label: string;
  accountName?: string;
  accountEmail?: string;
  avatarUrl?: string;
}

export interface NapMcpServerState {
  id: string;
  label: string;
  status: 'mock' | 'connected' | 'disabled' | 'error';
}

export interface NapMcpState {
  status: 'mock' | 'disabled' | 'connected' | 'error';
  servers: NapMcpServerState[];
}

export interface NapSessionState {
  sessionId: string;
  title: string;
  status: NapRunStatus;
  mode: NapMode;
  modelId: string;
  debugMode: boolean;
  securityMode: NapSecurityMode;
  messages: NapMessage[];
  activityText?: string;
  activityKind?: NapActivityKind;
  logs: NapLogEvent[];
  models: NapModelOption[];
  sessions: NapSessionSummary[];
  auth: NapAuthState;
  mcp: NapMcpState;
  config: NapConfigurationSnapshot;
}

export type NapActivityKind =
  | 'thinking'
  | 'reasoning'
  | 'plan'
  | 'tool'
  | 'command'
  | 'file'
  | 'warning'
  | 'error'
  | 'writing'
  | 'status';

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'sendPrompt'; prompt: string }
  | { type: 'stopGeneration' }
  | { type: 'authLogin' }
  | { type: 'refreshSessions' }
  | { type: 'newSession' }
  | { type: 'clearSession' }
  | { type: 'openSession'; sessionId: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'openFile'; filePath: string }
  | { type: 'setMode'; mode: NapMode }
  | { type: 'setModel'; modelId: string }
  | { type: 'openSettings' };

export type ExtensionToWebviewMessage =
  | { type: 'sessionState'; state: NapSessionState }
  | { type: 'messageDelta'; messageId: string; delta: string }
  | { type: 'activityTextChanged'; text?: string; kind?: NapActivityKind }
  | { type: 'messageDone'; messageId: string; status: NapMessageStatus }
  | { type: 'logEvent'; event: NapLogEvent }
  | { type: 'error'; message: string }
  | { type: 'modelsChanged'; models: NapModelOption[]; selectedModelId: string }
  | { type: 'sessionsChanged'; sessions: NapSessionSummary[] }
  | { type: 'authStateChanged'; auth: NapAuthState }
  | { type: 'mcpStateChanged'; mcp: NapMcpState };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNapMode(value: unknown): value is NapMode {
  return typeof value === 'string' && NAP_MODES.includes(value as NapMode);
}

export function isWebviewToExtensionMessage(value: unknown): value is WebviewToExtensionMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  switch (value.type) {
    case 'ready':
    case 'stopGeneration':
    case 'authLogin':
    case 'refreshSessions':
    case 'newSession':
    case 'clearSession':
    case 'openSettings':
      return true;
    case 'sendPrompt':
      return typeof value.prompt === 'string';
    case 'openSession':
    case 'deleteSession':
      return typeof value.sessionId === 'string' && value.sessionId.length > 0;
    case 'openFile':
      return typeof value.filePath === 'string' && value.filePath.trim().length > 0;
    case 'setMode':
      return isNapMode(value.mode);
    case 'setModel':
      return typeof value.modelId === 'string' && value.modelId.length > 0;
    default:
      return false;
  }
}
