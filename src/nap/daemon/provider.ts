import { spawn } from 'node:child_process';
import {
  NapAuthState,
  NapMode,
  NapModelOption,
  NapSecurityMode
} from '../../shared/protocol';
import { extractTextFromJson, parseGeminiStreamLine } from '../../services/geminiStreamParser';

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

export class GeminiProviderAdapter implements ProviderAdapter {
  constructor(private readonly cliPath = 'gemini') {}

  async listModels(defaultModelId: string): Promise<NapModelOption[]> {
    try {
      const output = await this.runGeminiText(['/models'], 5000);
      const parsed = parseModelOptions(output);
      return parsed.length > 0 ? parsed : this.fallbackModels(defaultModelId);
    } catch {
      return this.fallbackModels(defaultModelId);
    }
  }

  async authStatus(): Promise<NapAuthState> {
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_USE_VERTEXAI) {
      return { status: 'authenticated', label: 'Gemini env auth' };
    }
    try {
      const output = await this.runGeminiText(['/auth'], 4000);
      if (/signed\s*in|authenticated|logged\s*in/i.test(output)) {
        return { status: 'authenticated', label: 'Gemini signed in' };
      }
    } catch {
      // Fall through to unknown.
    }
    return { status: 'unknown', label: 'Gemini auth unknown' };
  }

  async login(): Promise<NapAuthState> {
    return { status: 'unknown', label: 'Run Gemini login in an interactive terminal' };
  }

  async logout(): Promise<NapAuthState> {
    return { status: 'signedOut', label: 'Signed out' };
  }

  async streamPrompt(request: ProviderPromptRequest, stream: ProviderPromptStream, signal: AbortSignal): Promise<void> {
    const args = [
      '-p',
      buildProviderPrompt(request),
      '--skip-trust',
      '--output-format',
      'stream-json'
    ];
    if (request.modelId && request.modelId !== 'auto') {
      args.push('-m', request.modelId);
    }
    if (request.mode === 'plan') {
      args.push('--approval-mode', 'plan');
    } else if (request.securityMode === 'strict') {
      args.push('--approval-mode', 'default');
    }
    if (request.debugMode || request.mode === 'debug') {
      args.push('--debug');
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.cliPath, args, {
        cwd: request.workspaceRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let emittedText = false;

      const abort = () => {
        child.kill();
        reject(new Error('Provider request cancelled.'));
      };
      signal.addEventListener('abort', abort, { once: true });

      child.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString('utf8');
        if (isAuthPrompt(chunk)) {
          emittedText = true;
          stream.onDelta('Gemini needs authentication. Run Nap auth login from the CLI or Accounts from the editor, then try again.');
          child.kill();
          return;
        }

        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const text = parseGeminiStreamLine(line);
          if (text) {
            emittedText = true;
            stream.onDelta(text);
          } else if (line.trim() && !looksLikeJson(line)) {
            emittedText = true;
            stream.onDelta(line.endsWith('\n') ? line : `${line}\n`);
          }
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString('utf8');
        if (isAuthPrompt(chunk)) {
          emittedText = true;
          stream.onDelta('Gemini needs authentication. Run Nap auth login from the CLI or Accounts from the editor, then try again.');
          child.kill();
          return;
        }
        stderrBuffer += chunk;
      });

      child.on('error', error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      });

      child.on('close', code => {
        signal.removeEventListener('abort', abort);
        const tailText = parseGeminiStreamLine(stdoutBuffer) || (!looksLikeJson(stdoutBuffer) ? stdoutBuffer : '');
        if (tailText) {
          emittedText = true;
          stream.onDelta(tailText);
        }
        if (code === 0) {
          resolve();
          return;
        }
        const message = stripAnsi(stderrBuffer).trim() || `Gemini CLI exited with code ${code}.`;
        if (!emittedText) {
          stream.onDelta(`Provider error: ${message}`);
        }
        reject(new Error(message));
      });
    });
  }

  private async runGeminiText(prompts: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cliPath, [
        '-p',
        prompts.join('\n'),
        '--skip-trust',
        '--output-format',
        'json'
      ], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Gemini probe timed out.'));
      }, timeoutMs);

      child.stdout.on('data', data => {
        stdout += data.toString('utf8');
      });
      child.stderr.on('data', data => {
        stderr += data.toString('utf8');
      });
      child.on('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', code => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve(extractTextFromJson(stdout) || stdout);
          return;
        }
        reject(new Error(stripAnsi(stderr).trim() || `Gemini CLI exited with code ${code}.`));
      });
    });
  }

  private fallbackModels(defaultModelId: string): NapModelOption[] {
    return [
      { id: 'auto', label: 'Auto', description: 'Let Nap choose the model', supportsTools: true },
      { id: defaultModelId === 'auto' ? 'gemini-2.5-flash' : defaultModelId, label: defaultModelId === 'auto' ? 'Gemini 2.5 Flash' : defaultModelId, supportsTools: true },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', supportsTools: true },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', supportsTools: true }
    ];
  }
}

function buildProviderPrompt(request: ProviderPromptRequest): string {
  const prefixes = [
    request.mode !== 'chat' ? `Mode: ${request.mode}.` : undefined,
    request.securityMode === 'strict' ? 'Security mode: strict. Ask before potentially destructive actions.' : undefined,
    request.debugMode ? 'Debug mode is enabled; include useful diagnostic context when relevant.' : undefined
  ].filter(Boolean);
  return prefixes.length > 0 ? `${prefixes.join('\n')}\n\n${request.prompt}` : request.prompt;
}

function parseModelOptions(output: string): NapModelOption[] {
  const ids = new Set<string>();
  for (const match of output.matchAll(/\b(?:gemini|models\/gemini)[-\w.]+/gi)) {
    ids.add(match[0].replace(/^models\//, ''));
  }
  return [...ids].map(id => ({
    id,
    label: id.replace(/^gemini-/, 'Gemini ').replace(/-/g, ' '),
    supportsTools: true
  }));
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function isAuthPrompt(value: string): boolean {
  return /opening authentication page|do you want to continue\?|log\s*in|sign\s*in/i.test(value);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

