import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { getNapConfiguration } from './configuration';
import { resolveNapCliCommand } from './nap/appServerClient';
import { NapSettingsPanel } from './napSettingsPanel';
import { INapCliService } from './services/napCliService';
import {
  ExtensionToWebviewMessage,
  isWebviewToExtensionMessage,
  NapLogEvent,
  NapMessage,
  NapMode,
  NapSessionRecord,
  NapSessionState,
  WebviewToExtensionMessage
} from './shared/protocol';

export class NapChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'nap.chatView';

  private view: vscode.WebviewView | undefined;
  private currentCancellation: vscode.CancellationTokenSource | undefined;
  private state: NapSessionState;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly cliService: INapCliService,
    private readonly output: vscode.OutputChannel
  ) {
    this.state = this.createInitialState();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.cliService.ensureInteractiveTerminal();
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'resources')
      ]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isWebviewToExtensionMessage(message)) {
        this.post({ type: 'error', message: 'Nap received an unsupported webview message.' });
        return;
      }

      try {
        await this.handleMessage(message);
      } catch (error) {
        this.reportError(error);
      }
    });
  }

  async refreshConfiguration(): Promise<void> {
    const config = getNapConfiguration();
    this.state = {
      ...this.state,
      config,
      debugMode: config.debugMode,
      securityMode: config.securityMode,
      modelId: this.state.modelId || config.defaultModel
    };
    await this.refreshEnvironment();
    await this.refreshSessions();
    this.publishState();
  }

  async newSession(): Promise<void> {
    this.stopGeneration();
    this.state = this.createInitialState();
    await this.refreshEnvironment();
    await this.refreshSessions();
    this.log('info', `New Nap session ${this.state.sessionId} created.`);
    this.publishState();
  }

  async clearSession(): Promise<void> {
    this.stopGeneration();
    this.state = {
      ...this.state,
      status: 'idle',
      messages: [],
      logs: []
    };
    await this.refreshSessions();
    this.publishState();
  }

  async login(): Promise<void> {
    const cliPath = this.state.config.cliPath || 'nap';
    this.log('info', 'Starting Nap sign in.');
    try {
      await runNapLoginFlow(cliPath, this.output);
      await this.pollAuthAfterLogin();
    } catch (error) {
      this.reportError(error);
    }
  }

  stopGeneration(): void {
    if (this.currentCancellation && !this.currentCancellation.token.isCancellationRequested) {
      this.currentCancellation.cancel();
    }
  }

  private async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.publishState();
        await this.refreshEnvironment();
        await this.refreshSessions();
        await this.openMostRecentSessionIfEmpty();
        this.publishState();
        return;
      case 'sendPrompt':
        await this.sendPrompt(message.prompt);
        return;
      case 'stopGeneration':
        this.stopGeneration();
        return;
      case 'authLogin':
        await this.login();
        return;
      case 'refreshSessions':
        await this.refreshSessions();
        return;
      case 'newSession':
        await this.newSession();
        return;
      case 'clearSession':
        await this.clearSession();
        return;
      case 'openSession':
        await this.openSession(message.sessionId);
        return;
      case 'deleteSession':
        await this.deleteSession(message.sessionId);
        return;
      case 'openFile':
        await this.openFileReference(message.filePath);
        return;
      case 'setMode':
        this.setMode(message.mode);
        return;
      case 'setModel':
        this.setModel(message.modelId);
        return;
      case 'openSettings':
        NapSettingsPanel.open(this.extensionUri);
        return;
    }
  }

  private async sendPrompt(rawPrompt: string): Promise<void> {
    const prompt = rawPrompt.trim();
    if (!prompt) {
      return;
    }

    if (this.state.status === 'streaming') {
      this.post({ type: 'error', message: 'Nap is already streaming a response.' });
      return;
    }

    const userMessage = this.createMessage('user', prompt, 'complete');
    const assistantMessage = this.createMessage('assistant', '', 'streaming');
    const nextTitle = this.state.messages.length === 0 || this.state.title === 'New Chat'
      ? titleFromPrompt(prompt)
      : this.state.title;
    this.state = {
      ...this.state,
      title: nextTitle,
      status: 'streaming',
      messages: [
        ...this.state.messages,
        userMessage,
        assistantMessage
      ]
    };
    this.publishState();

    await this.refreshEnvironment();
    if (this.state.auth.status !== 'authenticated') {
      this.finishAssistantMessage(assistantMessage.id, 'error');
      this.state = { ...this.state, status: 'error' };
      this.post({ type: 'error', message: 'Sign in with Nap CLI before using chat.' });
      this.post({ type: 'messageDone', messageId: assistantMessage.id, status: 'error' });
      this.publishState();
      return;
    }

    const cancellation = new vscode.CancellationTokenSource();
    this.currentCancellation = cancellation;
    const deltaStreamer = new SmoothDeltaStreamer(delta => {
      this.post({ type: 'messageDelta', messageId: assistantMessage.id, delta });
    });

    try {
      await this.cliService.streamPrompt(
        {
          sessionId: this.state.sessionId,
          prompt,
          mode: this.state.mode,
          modelId: this.state.modelId,
          debugMode: this.state.debugMode,
          securityMode: this.state.securityMode
        },
        {
          onDelta: delta => {
            this.appendAssistantDelta(assistantMessage.id, delta);
            deltaStreamer.enqueue(delta);
          },
          onActivity: text => {
            this.post({ type: 'activityTextChanged', text });
          },
          onLog: event => {
            this.appendLog(event);
            this.post({ type: 'logEvent', event });
          }
        },
        cancellation.token
      );

      await deltaStreamer.flush();
      this.post({ type: 'activityTextChanged', text: undefined });
      this.finishAssistantMessage(assistantMessage.id, 'complete');
      this.state = { ...this.state, status: 'idle' };
      this.cliService.saveSession(this.toCurrentSessionRecord());
      this.post({ type: 'messageDone', messageId: assistantMessage.id, status: 'complete' });
    } catch (error) {
      await deltaStreamer.flush();
      this.post({ type: 'activityTextChanged', text: undefined });
      if (error instanceof vscode.CancellationError || cancellation.token.isCancellationRequested) {
        this.finishAssistantMessage(assistantMessage.id, 'stopped');
        this.state = { ...this.state, status: 'stopped' };
        this.cliService.saveSession(this.toCurrentSessionRecord());
        this.post({ type: 'messageDone', messageId: assistantMessage.id, status: 'stopped' });
      } else {
        this.finishAssistantMessage(assistantMessage.id, 'error');
        this.state = { ...this.state, status: 'error' };
        this.cliService.saveSession(this.toCurrentSessionRecord());
        this.reportError(error);
        this.post({ type: 'messageDone', messageId: assistantMessage.id, status: 'error' });
      }
    } finally {
      deltaStreamer.dispose();
      if (this.currentCancellation === cancellation) {
        this.currentCancellation = undefined;
      }
      cancellation.dispose();
      await this.refreshSessions();
      this.publishState();
    }
  }

  private async refreshEnvironment(): Promise<void> {
    const config = this.state.config;
    const [modelsResult, authResult, mcpResult] = await Promise.allSettled([
      this.cliService.getModels(config.defaultModel),
      this.cliService.getAuthState(),
      this.cliService.getMcpState()
    ]);
    const models = modelsResult.status === 'fulfilled'
      ? modelsResult.value
      : [{ id: config.defaultModel, label: config.defaultModel, description: 'Current model' }];
    const auth = authResult.status === 'fulfilled'
      ? authResult.value
      : { status: 'unknown' as const, label: 'Auth unavailable' };
    const mcp = mcpResult.status === 'fulfilled'
      ? mcpResult.value
      : { status: 'disabled' as const, servers: [] };

    for (const result of [modelsResult, authResult, mcpResult]) {
      if (result.status === 'rejected') {
        this.output.appendLine(`[warn] ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }

    const selectedModelId = models.some(model => model.id === this.state.modelId)
      ? this.state.modelId
      : models[0]?.id ?? config.defaultModel;

    this.state = {
      ...this.state,
      models,
      modelId: selectedModelId,
      auth,
      mcp
    };

    this.post({ type: 'modelsChanged', models, selectedModelId });
    this.post({ type: 'authStateChanged', auth });
    this.post({ type: 'mcpStateChanged', mcp });
  }

  private async refreshSessions(): Promise<void> {
    try {
      const sessions = await this.cliService.listSessions();
      this.state = {
        ...this.state,
        sessions
      };
      this.post({ type: 'sessionsChanged', sessions });
    } catch (error) {
      this.output.appendLine(`[warn] Failed to refresh sessions: ${error instanceof Error ? error.message : String(error)}`);
      this.state = {
        ...this.state,
        sessions: []
      };
      this.post({ type: 'sessionsChanged', sessions: this.state.sessions });
    }
  }

  private async openMostRecentSessionIfEmpty(): Promise<void> {
    if (this.state.messages.length > 0 || this.state.status === 'streaming') {
      return;
    }

    const [latest] = this.state.sessions;
    if (!latest || latest.id === this.state.sessionId) {
      return;
    }

    try {
      const session = await this.cliService.getSession(latest.id);
      this.state = this.toSessionState(session);
    } catch (error) {
      this.output.appendLine(`[warn] Failed to restore latest session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async openSession(sessionId: string): Promise<void> {
    this.stopGeneration();

    const session = await this.cliService.getSession(sessionId);
    this.state = this.toSessionState(session);
    await this.refreshEnvironment();
    await this.refreshSessions();
    this.publishState();
  }

  private async deleteSession(sessionId: string): Promise<void> {
    this.stopGeneration();
    await this.cliService.deleteSession(sessionId);
    await this.refreshSessions();

    if (sessionId === this.state.sessionId) {
      const [latest] = this.state.sessions;
      if (latest) {
        const session = await this.cliService.getSession(latest.id);
        this.state = this.toSessionState(session);
      } else {
        this.state = this.createInitialState();
        await this.refreshEnvironment();
      }
      await this.refreshSessions();
    }

    this.publishState();
  }

  private async openFileReference(rawFilePath: string): Promise<void> {
    const target = parseFileReference(rawFilePath);
    if (!target.filePath) {
      return;
    }

    const uri = await this.resolveWorkspaceFile(target.filePath);
    if (!uri) {
      this.post({ type: 'error', message: `Could not find ${target.filePath}` });
      return;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    if (target.line !== undefined) {
      const line = Math.max(0, Math.min(document.lineCount - 1, target.line - 1));
      const range = document.lineAt(line).range;
      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  private async resolveWorkspaceFile(filePath: string): Promise<vscode.Uri | undefined> {
    const candidates: vscode.Uri[] = [];
    if (path.isAbsolute(filePath)) {
      candidates.push(vscode.Uri.file(filePath));
    } else {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        candidates.push(vscode.Uri.file(path.join(folder.uri.fsPath, filePath)));
      }
      candidates.push(vscode.Uri.file(path.resolve(filePath)));
    }

    for (const candidate of candidates) {
      try {
        const stat = await vscode.workspace.fs.stat(candidate);
        if (stat.type !== vscode.FileType.Directory) {
          return candidate;
        }
      } catch {
        // Try the next likely workspace-relative path.
      }
    }

    return undefined;
  }

  private async pollAuthAfterLogin(): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 180000) {
      await delay(1500);
      try {
        const auth = await this.cliService.getAuthState();
        this.state = {
          ...this.state,
          auth
        };
        this.post({ type: 'authStateChanged', auth });
        if (auth.status === 'authenticated') {
          this.log('info', auth.label);
          this.publishState();
          return;
        }
      } catch (error) {
        this.output.appendLine(`[warn] Auth poll failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.post({ type: 'error', message: 'Nap login finished, but credentials were not detected. Please try signing in again.' });
  }

  private setMode(mode: NapMode): void {
    this.state = {
      ...this.state,
      mode,
      debugMode: mode === 'debug' ? true : this.state.config.debugMode
    };
    this.log('info', `Mode set to ${mode}.`);
    this.publishState();
  }

  private setModel(modelId: string): void {
    this.state = {
      ...this.state,
      modelId
    };
    this.log('info', `Model set to ${modelId}.`);
    this.publishState();
  }

  private appendAssistantDelta(messageId: string, delta: string): void {
    this.state = {
      ...this.state,
      messages: this.state.messages.map(message => message.id === messageId
        ? { ...message, content: message.content + delta, status: 'streaming' }
        : message)
    };
  }

  private finishAssistantMessage(messageId: string, status: NapMessage['status']): void {
    this.state = {
      ...this.state,
      messages: this.state.messages.map(message => message.id === messageId
        ? { ...message, status }
        : message)
    };
  }

  private appendLog(event: NapLogEvent): void {
    this.state = {
      ...this.state,
      logs: [
        ...this.state.logs,
        event
      ].slice(-80)
    };
  }

  private log(level: NapLogEvent['level'], message: string): void {
    const event: NapLogEvent = {
      id: createId('log'),
      level,
      message,
      source: 'extension',
      createdAt: Date.now()
    };
    this.output.appendLine(`[${level}] ${message}`);
    this.appendLog(event);
    this.post({ type: 'logEvent', event });
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`[error] ${message}`);
    this.post({ type: 'error', message });
  }

  private createInitialState(): NapSessionState {
    const config = getNapConfiguration();
    return {
      sessionId: createId('session'),
      title: 'New Chat',
      status: 'idle',
      mode: 'chat',
      modelId: config.defaultModel,
      debugMode: config.debugMode,
      securityMode: config.securityMode,
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
      config
    };
  }

  private toSessionState(session: NapSessionRecord): NapSessionState {
    return {
      ...this.state,
      sessionId: session.id,
      title: session.title || 'New Chat',
      status: 'idle',
      mode: session.mode,
      modelId: session.modelId,
      debugMode: session.debugMode,
      securityMode: session.securityMode,
      messages: session.messages,
      logs: []
    };
  }

  private toCurrentSessionRecord(): NapSessionRecord {
    const now = Date.now();
    const firstUserMessage = this.state.messages.find(message => message.role === 'user')?.content.trim() ?? '';
    return {
      id: this.state.sessionId,
      title: this.state.title || truncateText(firstUserMessage, 42) || 'New Chat',
      mode: this.state.mode,
      modelId: this.state.modelId,
      debugMode: this.state.debugMode,
      securityMode: this.state.securityMode,
      messages: this.state.messages,
      createdAt: this.state.messages[0]?.createdAt ?? now,
      updatedAt: this.state.messages[this.state.messages.length - 1]?.createdAt ?? now
    };
  }

  private createMessage(role: NapMessage['role'], content: string, status: NapMessage['status']): NapMessage {
    return {
      id: createId(role),
      role,
      content,
      status,
      createdAt: Date.now()
    };
  }

  private publishState(): void {
    this.post({ type: 'sessionState', state: this.state });
  }

  private post(message: ExtensionToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const distRoot = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const indexPath = vscode.Uri.joinPath(distRoot, 'index.html').fsPath;
    const nonce = createNonce();

    if (!fs.existsSync(indexPath)) {
      return this.getFallbackHtml(webview, nonce);
    }

    let html = fs.readFileSync(indexPath, 'utf8');
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'logo.png'));
    html = html.replace(/(href|src)="\/([^"]+)"/g, (_match, attribute: string, resourcePath: string) => {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, resourcePath));
      return `${attribute}="${uri}"`;
    });
    html = html.replace(/%CSP_SOURCE%/g, webview.cspSource);
    html = html.replace(/%NONCE%/g, nonce);
    html = html.replace(/<script /g, `<script nonce="${nonce}" `);
    html = html.replace('<div id="root"></div>', `<script nonce="${nonce}">window.__NAP_LOGO_URI__ = ${JSON.stringify(logoUri.toString())};</script><div id="root"></div>`);
    return html;
  }

  private getFallbackHtml(webview: vscode.Webview, nonce: string): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nap</title>
</head>
<body>
  <main style="font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px;">
    <h1 style="font-size: 16px;">Nap</h1>
    <p>Run <code>npm run build:webview</code> to build the Nap chat surface.</p>
  </main>
</body>
</html>`;
  }
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseFileReference(rawFilePath: string): { filePath: string; line?: number } {
  const cleaned = rawFilePath.trim().replace(/^file:\/\//, '');
  const match = cleaned.match(/^(.*?)(?::(\d+))?(?::\d+)?$/);
  const filePath = match?.[1]?.trim() ?? cleaned;
  const line = match?.[2] ? Number.parseInt(match[2], 10) : undefined;
  return {
    filePath,
    line: Number.isFinite(line) ? line : undefined
  };
}

async function runNapLoginFlow(cliPath: string, output: vscode.OutputChannel): Promise<void> {
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Signing in to Nap',
    cancellable: true
  }, async (progress, token) => {
    progress.report({ message: 'Preparing browser login...' });
    const oauth = createCliOAuthRequest();
    const callback = await startNapOAuthCallbackServer(oauth, output, token);
    try {
      const loginUrl = buildNapLoginUrl(callback.redirectUri, oauth);
      output.appendLine(`[Nap] Opening login URL for redirect ${callback.redirectUri}`);
      progress.report({ message: 'Opening browser...' });
      await vscode.env.openExternal(vscode.Uri.parse(loginUrl));

      const code = await callback.waitForCode();
      progress.report({ message: 'Exchanging code...' });
      const tokenSet = await exchangeNapOAuthCode(callback.redirectUri, oauth, code);
      progress.report({ message: 'Saving credentials...' });
      await persistNapTokenSet(cliPath, tokenSet, output);
    } finally {
      callback.dispose();
    }
  });
}

interface CliOAuthRequest {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

interface CliTokenSet {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
}

function createCliOAuthRequest(): CliOAuthRequest {
  const codeVerifier = randomBase64Url(32);
  return {
    state: randomBase64Url(32),
    codeVerifier,
    codeChallenge: base64Url(crypto.createHash('sha256').update(codeVerifier).digest())
  };
}

function buildNapLoginUrl(redirectUri: string, oauth: CliOAuthRequest): string {
  const url = new URL('https://www.nap-code.com/login');
  url.searchParams.set('next', '/dashboard');
  url.searchParams.set('mode', 'cli');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', 'app_EMoamEEZ73f0CkXaXp7hrann');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'openid profile email offline_access api.connectors.read api.connectors.invoke');
  url.searchParams.set('code_challenge', oauth.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('nap_cli_simplified_flow', 'true');
  url.searchParams.set('state', oauth.state);
  url.searchParams.set('originator', 'nap_vscode_extension');
  return url.toString();
}

async function startNapOAuthCallbackServer(
  oauth: CliOAuthRequest,
  output: vscode.OutputChannel,
  token: vscode.CancellationToken
): Promise<{
  redirectUri: string;
  waitForCode(): Promise<string>;
  dispose(): void;
}> {
  for (const port of [1455, 1457]) {
    try {
      return await listenForNapOAuthCallback(port, oauth, output, token);
    } catch (error) {
      output.appendLine(`[Nap] Could not listen on localhost:${port}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error('Could not start a local Nap login callback server on port 1455 or 1457.');
}

function listenForNapOAuthCallback(
  port: number,
  oauth: CliOAuthRequest,
  output: vscode.OutputChannel,
  token: vscode.CancellationToken
): Promise<{
  redirectUri: string;
  waitForCode(): Promise<string>;
  dispose(): void;
}> {
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://localhost:${port}`);
    if (url.pathname !== '/auth/callback') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (error) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(napLoginHtml('Nap sign in failed', escapeHtml(error)));
      rejectCode(new Error(error));
      return;
    }
    if (!code || state !== oauth.state) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(napLoginHtml('Nap sign in failed', 'The login callback was invalid. You can close this tab and try again.'));
      rejectCode(new Error('Nap login callback was invalid.'));
      return;
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(napLoginHtml('Nap sign in complete', 'You can close this tab and return to VS Code.'));
    resolveCode(code);
  });

  token.onCancellationRequested(() => {
    rejectCode(new Error('Nap login cancelled.'));
    server.close();
  });

  return new Promise((resolve, reject) => {
    server.once('error', error => reject(error));
    server.listen(port, '127.0.0.1', () => {
      output.appendLine(`[Nap] Login callback listening on http://localhost:${port}/auth/callback`);
      resolve({
        redirectUri: `http://localhost:${port}/auth/callback`,
        waitForCode: () => codePromise,
        dispose: () => server.close()
      });
    });
  });
}

async function exchangeNapOAuthCode(redirectUri: string, oauth: CliOAuthRequest, code: string): Promise<CliTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    code_verifier: oauth.codeVerifier
  });

  const response = await fetch('https://www.nap-code.com/oauth/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(readString(payload.error_description) ?? readString(payload.error) ?? 'Nap token exchange failed.');
  }
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new Error('Nap token exchange did not return an access token.');
  }
  return payload as unknown as CliTokenSet;
}

async function persistNapTokenSet(cliPath: string, tokenSet: CliTokenSet, output: vscode.OutputChannel): Promise<void> {
  const command = resolveNapCliCommand(['login', '--with-access-token'], cliPath);
  output.appendLine(`[Nap] Saving credentials with: ${command.command} ${command.args.join(' ')}`);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.command, command.args, {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stderr = '';
      let stdout = '';
      child.stdout.on('data', data => {
        stdout += data.toString('utf8');
      });
      child.stderr.on('data', data => {
        stderr += data.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', code => {
        output.append(stdout);
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(stripAnsi(stderr).trim() || stripAnsi(stdout).trim() || `Nap credential save exited with code ${code}.`));
      });
      child.stdin.end(`${tokenSet.access_token}\n`);
    });
  } catch (error) {
    output.appendLine(`[Nap] CLI credential save failed, writing VS Code credentials directly: ${error instanceof Error ? error.message : String(error)}`);
  }

  persistNapAuthJson(tokenSet, output);
}

function persistNapAuthJson(tokenSet: CliTokenSet, output: vscode.OutputChannel): void {
  const napHome = process.env.NAP_HOME ?? path.join(os.homedir(), '.nap');
  fs.mkdirSync(napHome, { recursive: true });
  const authPath = path.join(napHome, 'auth.json');
  const idToken = tokenSet.id_token ?? tokenSet.access_token;
  const accountId = readJwtClaim(idToken, 'sub');
  const auth = {
    auth_mode: 'agentIdentity',
    tokens: {
      id_token: idToken,
      access_token: tokenSet.access_token,
      refresh_token: tokenSet.refresh_token,
      account_id: accountId
    },
    last_refresh: new Date().toISOString()
  };
  fs.writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  output.appendLine(`[Nap] Saved persistent credentials to ${authPath}`);
}

function readJwtClaim(token: string | undefined, claim: string): string | undefined {
  if (!token) {
    return undefined;
  }
  const [, payload] = token.split('.');
  if (!payload) {
    return undefined;
  }
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
    return readString(claims[claim]);
  } catch {
    return undefined;
  }
}

function napLoginHtml(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#050505;color:#e5e5e5;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:grid;min-height:100vh;place-items:center}.box{max-width:420px;padding:32px;text-align:center}h1{font-size:22px;margin:0 0 12px}p{color:#9a9a9a;line-height:1.5}</style></head><body><main class="box"><h1>${escapeHtml(title)}</h1><p>${message}</p></main></body></html>`;
}

function randomBase64Url(byteLength: number): string {
  return base64Url(crypto.randomBytes(byteLength));
}

function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function titleFromPrompt(prompt: string): string {
  const cleaned = prompt
    .replace(/[`*_#[\](){}<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return 'New Chat';
  }
  const sentence = cleaned.split(/[.!?\n]/)[0]?.trim() || cleaned;
  return sentence.length > 42 ? `${sentence.slice(0, 39).trimEnd()}...` : sentence;
}

class SmoothDeltaStreamer {
  private readonly queue: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushResolvers: Array<() => void> = [];

  constructor(private readonly emit: (delta: string) => void) {}

  enqueue(delta: string): void {
    this.queue.push(...splitSmoothDelta(delta));
    this.schedule();
  }

  flush(): Promise<void> {
    if (this.queue.length === 0 && !this.timer) {
      return Promise.resolve();
    }

    return new Promise(resolve => {
      this.flushResolvers.push(resolve);
      this.drain();
    });
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.queue.length = 0;
    this.resolveFlushes();
  }

  private schedule(): void {
    if (!this.timer && this.queue.length > 0) {
      this.timer = setTimeout(() => this.drain(), this.nextDelayMs());
    }
  }

  private drain(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const batchSize = this.nextBatchSize();
    const chunk = this.queue.splice(0, batchSize).join('');
    if (chunk) {
      this.emit(chunk);
    }

    if (this.queue.length > 0) {
      this.schedule();
      return;
    }

    this.resolveFlushes();
  }

  private nextBatchSize(): number {
    if (this.queue.length > 260) {
      return 3;
    }
    if (this.queue.length > 120) {
      return 2;
    }
    return 1;
  }

  private nextDelayMs(): number {
    if (this.queue.length > 260) {
      return 24;
    }
    if (this.queue.length > 120) {
      return 32;
    }
    return 46;
  }

  private resolveFlushes(): void {
    const resolvers = this.flushResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve();
    }
  }
}

function splitSmoothDelta(delta: string): string[] {
  const tokens = delta.match(/\n+|[ \t]+|[^\s]+/g);
  if (!tokens) {
    return [];
  }

  const chunks: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    const splitToken = splitLongToken(token);
    if (token.trim() && next && /^[ \t]+$/.test(next)) {
      const last = splitToken.pop();
      chunks.push(...splitToken);
      chunks.push(`${last ?? ''}${next}`);
      index += 1;
    } else {
      chunks.push(...splitToken);
    }
  }
  return chunks;
}

function splitLongToken(token: string): string[] {
  if (!token.trim() || token.length <= 24) {
    return [token];
  }

  const chunks: string[] = [];
  for (let index = 0; index < token.length; index += 18) {
    chunks.push(token.slice(index, index + 18));
  }
  return chunks;
}

function createNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
