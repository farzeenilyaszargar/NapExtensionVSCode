import {
  ExtensionToWebviewMessage,
  NAP_DEFAULT_ACCENT,
  NapSessionState
} from '../shared/protocol';

export type NapViewState = NapSessionState;

export const initialViewState: NapViewState = {
  sessionId: 'pending',
  status: 'idle',
  mode: 'chat',
  modelId: 'auto',
  debugMode: false,
  securityMode: 'standard',
  messages: [],
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
  config: {
    cliPath: 'nap',
    accentColor: NAP_DEFAULT_ACCENT,
    defaultModel: 'auto',
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
    case 'sessionState':
      return message.state;
    case 'messageDelta':
      return {
        ...state,
        messages: state.messages.map(item => item.id === message.messageId
          ? { ...item, content: item.content + message.delta, status: 'streaming' }
          : item)
      };
    case 'messageDone':
      return {
        ...state,
        status: message.status === 'complete' ? 'idle' : message.status,
        messages: state.messages.map(item => item.id === message.messageId
          ? { ...item, status: message.status }
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
    case 'showProfile':
      return state;
  }
}
