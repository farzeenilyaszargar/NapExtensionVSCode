import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { getNapConfiguration } from './configuration';
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
    const auth = await this.cliService.login();
    this.state = {
      ...this.state,
      auth
    };
    this.post({ type: 'authStateChanged', auth });
    this.log('info', auth.label);
    this.publishState();
  }

  async openProfile(): Promise<void> {
    await this.refreshEnvironment();
    this.publishState();
    this.post({ type: 'showProfile' });
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
      case 'setMode':
        this.setMode(message.mode);
        return;
      case 'setModel':
        this.setModel(message.modelId);
        return;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:NapCode.nap');
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

    await this.refreshEnvironment();
    if (this.state.auth.status !== 'authenticated') {
      this.post({ type: 'error', message: 'Sign in with Nap CLI before using chat.' });
      this.publishState();
      return;
    }

    const userMessage = this.createMessage('user', prompt, 'complete');
    const assistantMessage = this.createMessage('assistant', '', 'streaming');
    this.state = {
      ...this.state,
      status: 'streaming',
      messages: [
        ...this.state.messages,
        userMessage,
        assistantMessage
      ]
    };
    this.publishState();

    const cancellation = new vscode.CancellationTokenSource();
    this.currentCancellation = cancellation;

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
            this.post({ type: 'messageDelta', messageId: assistantMessage.id, delta });
          },
          onLog: event => {
            this.appendLog(event);
            this.post({ type: 'logEvent', event });
          }
        },
        cancellation.token
      );

      this.finishAssistantMessage(assistantMessage.id, 'complete');
      this.state = { ...this.state, status: 'idle' };
      this.cliService.saveSession(this.toCurrentSessionRecord());
      this.post({ type: 'messageDone', messageId: assistantMessage.id, status: 'complete' });
    } catch (error) {
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

  private async openSession(sessionId: string): Promise<void> {
    this.stopGeneration();

    const session = await this.cliService.getSession(sessionId);
    this.state = this.toSessionState(session);
    await this.refreshEnvironment();
    await this.refreshSessions();
    this.publishState();
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
      title: truncateText(firstUserMessage, 42) || 'New Chat',
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
