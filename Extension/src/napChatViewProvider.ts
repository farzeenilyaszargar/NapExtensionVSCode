import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getNapConfiguration } from './configuration';
import { NapSettingsPanel } from './napSettingsPanel';
import { INapCliService } from './services/napCliService';
import {
  ExtensionToWebviewMessage,
  isWebviewToExtensionMessage,
  NapActivityItem,
  NapLogEvent,
  NapMessage,
  NapAuthState,
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
    this.log('info', 'Starting Nap sign in.');
    try {
      const auth = await this.cliService.login();
      this.state = {
        ...this.state,
        auth
      };
      this.post({ type: 'authStateChanged', auth });
      this.log('info', auth.label);
      this.publishState();
      await this.refreshEnvironment();
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
    const inlineActivityKeys = new Set<string>();

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
          onActivity: activity => {
            const inlineActivity = activity ? createInlineActivityMarkdown(activity, inlineActivityKeys) : '';
            if (inlineActivity) {
              this.appendAssistantDelta(assistantMessage.id, inlineActivity);
              deltaStreamer.enqueue(inlineActivity);
            }
            this.post({
              type: 'activityTextChanged',
              text: activity?.text,
              kind: activity?.kind,
              persistent: activity ? isPersistentActivityKind(activity.kind) : false,
              activity
            });
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
        const interruptedText = getInterruptedProcessText(this.state.messages.find(message => message.id === assistantMessage.id)?.content ?? '');
        if (interruptedText) {
          this.appendAssistantDelta(assistantMessage.id, interruptedText);
          deltaStreamer.enqueue(interruptedText);
          await deltaStreamer.flush();
        }
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
    const auth = this.resolveRefreshedAuth(authResult);
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
    const completedAt = Date.now();
    this.state = {
      ...this.state,
      messages: this.state.messages.map(message => message.id === messageId
        ? { ...message, status, completedAt: message.completedAt ?? completedAt }
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
    const previousState = this.state;
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
      auth: previousState?.auth ?? {
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

  private resolveRefreshedAuth(authResult: PromiseSettledResult<NapAuthState>): NapAuthState {
    const currentAuth = this.state.auth;
    if (authResult.status === 'rejected') {
      return currentAuth.status === 'authenticated'
        ? currentAuth
        : { status: 'unknown', label: 'Auth unavailable' };
    }

    const nextAuth = authResult.value;
    if (nextAuth.status === 'authenticated') {
      return nextAuth;
    }

    if (currentAuth.status === 'authenticated') {
      this.output.appendLine(`[Nap] Keeping authenticated account while app-server auth probe returned ${nextAuth.status}.`);
      return currentAuth;
    }

    return nextAuth;
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
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'logo.svg'));
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

function titleFromPrompt(prompt: string): string {
  const cleaned = prompt
    .replace(/[`*_#[\](){}<>]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(please\s+)?(can you|could you|would you|i want you to|i need you to|help me|make|create|build)\s+/i, '')
    .trim();
  if (!cleaned) {
    return 'New Chat';
  }
  const sentence = cleaned.split(/[.!?\n]/)[0]?.trim() || cleaned;
  const words = sentence.split(/\s+/).filter(word => !/^(a|an|the|to|for|with|and|or|of|in|on)$/i.test(word));
  const title = words.slice(0, 7).map(titleCaseWord).join(' ') || sentence;
  return title.length > 42 ? `${title.slice(0, 39).trimEnd()}...` : title;
}

function titleCaseWord(word: string): string {
  if (/^[A-Z0-9_.-]{2,}$/.test(word)) {
    return word;
  }
  return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
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

function isPersistentActivityKind(kind: string | undefined): boolean {
  return kind === 'file' || kind === 'tool' || kind === 'command' || kind === 'warning' || kind === 'error';
}

function getInterruptedProcessText(content: string): string {
  if (/\binterrupted process\b/i.test(content)) {
    return '';
  }
  const prefix = content.trim().length > 0 && !content.endsWith('\n') ? '\n\n' : '';
  return `${prefix}Interrupted process`;
}

function createInlineActivityMarkdown(activity: Partial<NapActivityItem> & { itemId?: string }, seen: Set<string>): string {
  if (!isPersistentActivityKind(activity.kind)) {
    return '';
  }
  const key = activity.itemId ?? activity.filePath ?? activity.title ?? `${activity.kind}:${activity.text}`;
  if (!key || seen.has(key)) {
    return '';
  }
  seen.add(key);

  const encoded = Buffer.from(JSON.stringify({
    id: key,
    text: activity.text,
    kind: activity.kind,
    verb: activity.verb,
    filePath: activity.filePath,
    title: activity.title,
    detail: activity.detail,
    additions: activity.additions,
    deletions: activity.deletions
  }), 'utf8').toString('base64');
  return `\n\n:::nap-activity ${encoded}\n:::\n\n`;
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
