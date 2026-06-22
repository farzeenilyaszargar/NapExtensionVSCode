import {
  ExtensionToWebviewMessage,
  NAP_DEFAULT_ACCENT,
  NapSessionState
} from '../shared/protocol';

export type NapViewState = NapSessionState;

export const initialViewState: NapViewState = {
  sessionId: 'pending',
  title: 'New Chat',
  status: 'idle',
  mode: 'chat',
  modelId: 'gpt-5.4-mini',
  debugMode: false,
  securityMode: 'standard',
  messages: [],
  queuedPrompts: [],
  activityText: undefined,
  activityKind: undefined,
  activityItems: [],
  logs: [],
  models: [],
  sessions: [],
  auth: {
    status: 'unknown',
    label: 'Unknown'
  },
  mcp: {
    status: 'disabled',
    servers: []
  },
  plugins: [],
  workspaceChanges: {
    filesChanged: 0,
    additions: 0,
    deletions: 0
  },
  config: {
    cliPath: 'nap',
    accentColor: NAP_DEFAULT_ACCENT,
    defaultModel: 'gpt-5.4-mini',
    debugMode: false,
    securityMode: 'standard'
  }
};

export type NapViewAction =
  | { type: 'extensionMessage'; message: ExtensionToWebviewMessage };

export function napViewReducer(state: NapViewState, action: NapViewAction): NapViewState {
  switch (action.type) {
    case 'extensionMessage':
      return applyExtensionMessage(state, action.message);
  }
}

export function applyExtensionMessage(state: NapViewState, message: ExtensionToWebviewMessage): NapViewState {
  switch (message.type) {
    case 'showChat':
      return state;
    case 'sessionState':
      return { ...message.state, activityItems: [] };
    case 'messageDelta':
      return {
        ...state,
        activityText: undefined,
        activityKind: undefined,
        messages: state.messages.map(item => item.id === message.messageId
          ? { ...item, content: item.content + message.delta, status: 'streaming' }
          : item)
      };
    case 'activityTextChanged':
      return {
        ...state,
        activityText: message.activity?.title ?? message.text,
        activityKind: message.kind,
        activityItems: appendActivityItem(state.activityItems ?? [], message)
      };
    case 'messageDone':
      return {
        ...state,
        activityText: undefined,
        activityKind: undefined,
        status: message.status === 'complete' ? 'idle' : message.status,
        messages: state.messages.map(item => item.id === message.messageId
          ? { ...item, status: message.status, completedAt: item.completedAt ?? Date.now() }
          : item)
      };
    case 'logEvent':
      return {
        ...state,
        logs: [
          ...state.logs,
          message.event
        ].slice(-80)
      };
    case 'error':
      return {
        ...state,
        status: 'error',
        logs: [
          ...state.logs,
          {
            id: `webview-error-${Date.now()}`,
            level: 'error',
            message: message.message,
            source: 'webview',
            createdAt: Date.now()
          }
        ].slice(-80)
      };
    case 'modelsChanged':
      return {
        ...state,
        models: message.models,
        modelId: message.selectedModelId
      };
    case 'sessionsChanged':
      return {
        ...state,
        sessions: message.sessions
      };
    case 'authStateChanged':
      return {
        ...state,
        auth: message.auth
      };
    case 'mcpStateChanged':
      return {
        ...state,
        mcp: message.mcp
      };
    case 'pluginsChanged':
      return {
        ...state,
        plugins: message.plugins
      };
    case 'workspaceChangesChanged':
      return {
        ...state,
        workspaceChanges: message.workspaceChanges,
        messages: message.messageId
          ? state.messages.map(item => item.id === message.messageId
            ? { ...item, workspaceChanges: message.workspaceChanges }
            : item)
          : state.messages
      };
  }
}

function appendActivityItem(
  items: NonNullable<NapViewState['activityItems']>,
  message: Extract<ExtensionToWebviewMessage, { type: 'activityTextChanged' }>
): NonNullable<NapViewState['activityItems']> {
  if (!message.persistent || !message.text || !message.kind) {
    return items;
  }

  const previous = items[items.length - 1];
  if (previous?.text === message.text && previous.kind === message.kind) {
    return items;
  }

  return [
    ...items,
    {
      id: `activity-${Date.now()}-${items.length}`,
      text: message.text,
      kind: message.kind,
      createdAt: Date.now(),
      ...message.activity
    }
  ].slice(-18);
}
