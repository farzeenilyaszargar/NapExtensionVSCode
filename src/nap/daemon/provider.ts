import {
  NapAuthState,
  NapMode,
  NapModelOption,
  NapSecurityMode
} from '../../shared/protocol';

export interface ProviderPromptRequest {
  prompt: string;
  mode: NapMode;
  modelId: string;
  debugMode: boolean;
  securityMode: NapSecurityMode;
  workspaceRoot?: string;
}

export interface ProviderPromptStream {
  onDelta(delta: string): void;
  onLog(message: string): void;
}

export interface ProviderAdapter {
  listModels(defaultModelId: string): Promise<NapModelOption[]>;
  authStatus(): Promise<NapAuthState>;
  login(): Promise<NapAuthState>;
  logout(): Promise<NapAuthState>;
  streamPrompt(request: ProviderPromptRequest, stream: ProviderPromptStream, signal: AbortSignal): Promise<void>;
}

export class NapBackendProviderAdapter implements ProviderAdapter {
  private auth: NapAuthState = { status: 'signedOut', label: 'Sign in to Nap' };

  async listModels(defaultModelId: string): Promise<NapModelOption[]> {
    return [
      { id: 'auto', label: 'Auto', description: 'Let Nap choose the model', supportsTools: true },
      { id: defaultModelId === 'auto' ? 'gpt-5.5' : defaultModelId, label: defaultModelId === 'auto' ? 'GPT-5.5' : defaultModelId, supportsTools: true },
      { id: 'codex-5.3', label: 'Codex-5.3', supportsTools: true },
      { id: 'sonnet-4.8', label: 'Sonnet-4.8', supportsTools: true },
      { id: 'opus-4.3', label: 'Opus-4.3', supportsTools: true }
    ];
  }

  async authStatus(): Promise<NapAuthState> {
    return this.auth;
  }

  async login(): Promise<NapAuthState> {
    this.auth = {
      status: 'authenticated',
      label: 'Nap signed in',
      accountName: 'Nap User'
    };
    return this.auth;
  }

  async logout(): Promise<NapAuthState> {
    this.auth = { status: 'signedOut', label: 'Nap signed out' };
    return this.auth;
  }

  async streamPrompt(request: ProviderPromptRequest, stream: ProviderPromptStream, signal: AbortSignal): Promise<void> {
    if (this.auth.status !== 'authenticated') {
      throw new Error('Sign in with Nap before using chat.');
    }

    stream.onLog('Nap daemon accepted chat request.');
    const chunks = [
      `I received your request in ${request.mode} mode.`,
      '\n\n',
      'The VS Code extension and CLI are both thin clients now; ',
      'they communicate with napd through JSON-RPC over the local WebSocket transport.',
      '\n\n',
      `Prompt: ${request.prompt}`
    ];

    for (const chunk of chunks) {
      if (signal.aborted) {
        throw new Error('Provider request cancelled.');
      }
      stream.onDelta(chunk);
      await delay(70);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
