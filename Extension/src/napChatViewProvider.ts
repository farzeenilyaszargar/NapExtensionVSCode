import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
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
  NapQueuedPrompt,
  NapSessionRecord,
  NapSessionState,
  NapWorkspaceChangeSummary,
  WebviewToExtensionMessage
} from './shared/protocol';

export class NapChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'nap.chatView';

  private view: vscode.WebviewView | undefined;
  private currentCancellation: vscode.CancellationTokenSource | undefined;
  private state: NapSessionState;
  private isDrainingQueue = false;
  private loginPromise: Promise<void> | undefined;
  private workspaceChangeTimer: NodeJS.Timeout | undefined;
  private workspaceWatchers: vscode.Disposable[] = [];
  private conversationChangeBaseline: GitChangeSnapshot | undefined;
  private conversationTurnDiff: string | undefined;
  private conversationTurnDiffsByMessageId = new Map<string, string>();
  private workspaceChangeGeneration = 0;

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
    this.ensureWorkspaceChangeWatchers();
    void this.resetConversationChangeBaseline();

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
    await this.resetConversationChangeBaseline();
    await this.refreshEnvironment();
    await this.refreshSessions();
    this.log('info', `New Nap session ${this.state.sessionId} created.`);
    this.post({ type: 'showChat' });
    this.publishState();
  }

  async clearSession(): Promise<void> {
    this.stopGeneration();
    this.state = {
      ...this.state,
      status: 'idle',
      messages: [],
      queuedPrompts: [],
      logs: [],
      workspaceChanges: emptyWorkspaceChangeSummary()
    };
    await this.resetConversationChangeBaseline();
    await this.refreshSessions();
    this.publishState();
  }

  async login(): Promise<void> {
    if (this.loginPromise) {
      this.log('info', 'Nap sign in is already in progress.');
      return this.loginPromise;
    }

    this.loginPromise = this.performLogin().finally(() => {
      this.loginPromise = undefined;
    });
    return this.loginPromise;
  }

  private async performLogin(): Promise<void> {
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

  private async logout(): Promise<void> {
    this.log('info', 'Signing out of Nap.');
    try {
      const auth = await this.cliService.logout();
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
        await this.refreshWorkspaceChanges();
        await this.openMostRecentSessionIfEmpty();
        this.publishState();
        return;
      case 'sendPrompt':
        await this.sendPrompt(message.prompt);
        return;
      case 'newSessionWithPrompt':
        await this.newSession();
        await this.sendPrompt(message.prompt);
        return;
      case 'deleteQueuedPrompt':
        this.deleteQueuedPrompt(message.promptId);
        return;
      case 'reorderQueuedPrompt':
        this.reorderQueuedPrompt(message.promptId, message.targetPromptId);
        return;
      case 'stopGeneration':
        this.stopGeneration();
        return;
      case 'authLogin':
        await this.login();
        return;
      case 'authLogout':
        await this.logout();
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
      case 'reviewChanges':
        await this.reviewConversationChanges(message.messageId);
        return;
      case 'reviewFileChanges':
        await this.reviewConversationFile(message.filePath, message.messageId);
        return;
      case 'setMode':
        this.setMode(message.mode);
        return;
      case 'setModel':
        this.setModel(message.modelId);
        return;
      case 'refreshPlugins':
        await this.refreshEnvironment();
        await this.refreshWorkspaceChanges();
        this.publishState();
        return;
      case 'openExternal':
        await vscode.env.openExternal(vscode.Uri.parse(message.url));
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
      this.enqueuePrompt(prompt);
      return;
    }

    await this.runPrompt(prompt);
  }

  private async reviewConversationChanges(messageId?: string): Promise<void> {
    const messageDiff = messageId ? this.conversationTurnDiffsByMessageId.get(messageId) : undefined;
    if (messageDiff?.trim()) {
      await openUnifiedDiffReview(messageDiff, this.state.sessionId, 'Nap Diff');
      return;
    }

    if (this.state.workspaceChanges.filesChanged <= 0) {
      return;
    }

    if (this.conversationTurnDiff?.trim()) {
      await openUnifiedDiffReview(this.conversationTurnDiff, this.state.sessionId, 'Nap Diff');
      return;
    }

    if (!this.conversationChangeBaseline) {
      this.conversationChangeBaseline = await getGitChangeSnapshot();
    }

    const current = await getGitChangeSnapshot();
    const changedFiles = getConversationChangedFiles(this.conversationChangeBaseline, current);
    if (changedFiles.tracked.length === 0 && changedFiles.untracked.length === 0) {
      await this.refreshWorkspaceChanges();
      return;
    }

    await openChangedFilesReview(changedFiles);
  }

  private async reviewConversationFile(filePath: string, messageId?: string): Promise<void> {
    const normalizedPath = filePath.trim();
    if (!normalizedPath) {
      return;
    }

    const messageDiff = messageId ? this.conversationTurnDiffsByMessageId.get(messageId) : undefined;
    if (messageDiff?.trim()) {
      const entry = extractUnifiedDiffFileEntries(messageDiff).find(item => item.filePath === normalizedPath);
      if (entry?.diff.trim()) {
        await openUnifiedDiffReview(entry.diff, this.state.sessionId, `Nap Diff - ${normalizedPath}`);
        return;
      }
    }

    if (this.conversationTurnDiff?.trim()) {
      const entry = extractUnifiedDiffFileEntries(this.conversationTurnDiff).find(item => item.filePath === normalizedPath);
      if (entry?.diff.trim()) {
        await openUnifiedDiffReview(entry.diff, this.state.sessionId, `Nap Diff - ${normalizedPath}`);
        return;
      }
    }

    if (!this.conversationChangeBaseline) {
      this.conversationChangeBaseline = await getGitChangeSnapshot();
    }

    const current = await getGitChangeSnapshot();
    const changedFiles = getConversationChangedFiles(this.conversationChangeBaseline, current);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return;
    }

    if (changedFiles.tracked.includes(normalizedPath)) {
      await openTrackedFileDiff(workspaceRoot, normalizedPath);
    } else if (changedFiles.untracked.includes(normalizedPath)) {
      await openUntrackedFileReview(workspaceRoot, normalizedPath);
    }
  }

  private enqueuePrompt(prompt: string): void {
    const item: NapQueuedPrompt = {
      id: createId('queued'),
      prompt,
      createdAt: Date.now()
    };
    this.state = {
      ...this.state,
      queuedPrompts: [
        ...this.state.queuedPrompts,
        item
      ]
    };
    this.publishState();
  }

  private deleteQueuedPrompt(promptId: string): void {
    this.state = {
      ...this.state,
      queuedPrompts: this.state.queuedPrompts.filter(item => item.id !== promptId)
    };
    this.publishState();
  }

  private reorderQueuedPrompt(promptId: string, targetPromptId: string): void {
    if (promptId === targetPromptId) {
      return;
    }

    const items = [...this.state.queuedPrompts];
    const fromIndex = items.findIndex(item => item.id === promptId);
    const toIndex = items.findIndex(item => item.id === targetPromptId);
    if (fromIndex < 0 || toIndex < 0) {
      return;
    }

    const [moved] = items.splice(fromIndex, 1);
    items.splice(toIndex, 0, moved);
    this.state = {
      ...this.state,
      queuedPrompts: items
    };
    this.publishState();
  }

  private async drainQueuedPrompts(): Promise<void> {
    if (this.isDrainingQueue || this.state.status === 'streaming') {
      return;
    }

    this.isDrainingQueue = true;
    try {
      while (this.state.queuedPrompts.length > 0 && this.state.status !== 'streaming') {
        const [next, ...remaining] = this.state.queuedPrompts;
        this.state = {
          ...this.state,
          queuedPrompts: remaining
        };
        this.publishState();
        await this.runPrompt(next.prompt, { skipQueueDrain: true });
      }
    } finally {
      this.isDrainingQueue = false;
    }
  }

  private async runPrompt(rawPrompt: string, options: { skipQueueDrain?: boolean } = {}): Promise<void> {
    const prompt = rawPrompt.trim();
    if (!prompt) {
      return;
    }

    if (this.state.messages.length === 0) {
      await this.resetConversationChangeBaseline();
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
      activityText: 'Thinking',
      activityKind: 'thinking',
      messages: [
        ...this.state.messages,
        userMessage,
        assistantMessage
      ]
    };
    this.publishState();
    this.post({ type: 'activityTextChanged', text: 'Thinking', kind: 'thinking' });

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
          onTurnDiff: event => {
            this.updateConversationTurnDiff(event.diff, assistantMessage.id);
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
      await this.refreshWorkspaceChanges();
      this.publishState();
      if (!options.skipQueueDrain) {
        await this.drainQueuedPrompts();
      }
    }
  }

  private async refreshEnvironment(): Promise<void> {
    const config = this.state.config;
    const [modelsResult, authResult, mcpResult, pluginsResult] = await Promise.allSettled([
      this.cliService.getModels(config.defaultModel),
      this.cliService.getAuthState(),
      this.cliService.getMcpState(),
      this.cliService.getPlugins()
    ]);
    const models = modelsResult.status === 'fulfilled'
      ? modelsResult.value
      : [{ id: config.defaultModel, label: config.defaultModel, description: 'Current model' }];
    const auth = this.resolveRefreshedAuth(authResult);
    const mcp = mcpResult.status === 'fulfilled'
      ? mcpResult.value
      : { status: 'disabled' as const, servers: [] };
    const plugins = pluginsResult.status === 'fulfilled'
      ? pluginsResult.value
      : [];

    for (const result of [modelsResult, authResult, mcpResult, pluginsResult]) {
      if (result.status === 'rejected') {
        this.output.appendLine(`[warn] ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }

    const currentModelId = this.state.modelId === 'auto' ? config.defaultModel : this.state.modelId;
    const selectedModelId = models.some(model => model.id === currentModelId)
      ? currentModelId
      : models.some(model => model.id === config.defaultModel)
        ? config.defaultModel
        : models[0]?.id ?? config.defaultModel;

    this.state = {
      ...this.state,
      models,
      modelId: selectedModelId,
      auth,
      mcp,
      plugins
    };

    this.post({ type: 'modelsChanged', models, selectedModelId });
    this.post({ type: 'authStateChanged', auth });
    this.post({ type: 'mcpStateChanged', mcp });
    this.post({ type: 'pluginsChanged', plugins });
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
      await this.resetConversationChangeBaseline();
    } catch (error) {
      this.output.appendLine(`[warn] Failed to restore latest session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async openSession(sessionId: string): Promise<void> {
    this.stopGeneration();

    const session = await this.cliService.getSession(sessionId);
    this.state = this.toSessionState(session);
    await this.resetConversationChangeBaseline();
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
        await this.resetConversationChangeBaseline();
      } else {
        this.state = this.createInitialState();
        await this.resetConversationChangeBaseline();
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

  private updateConversationTurnDiff(diff: string, messageId?: string): void {
    const trimmed = diff.trim();
    this.conversationTurnDiff = trimmed ? `${trimmed}\n` : undefined;
    if (messageId) {
      if (this.conversationTurnDiff) {
        this.conversationTurnDiffsByMessageId.set(messageId, this.conversationTurnDiff);
      } else {
        this.conversationTurnDiffsByMessageId.delete(messageId);
      }
    }
    const workspaceChanges = this.conversationTurnDiff
      ? summarizeUnifiedDiff(this.conversationTurnDiff)
      : emptyWorkspaceChangeSummary();
    this.state = {
      ...this.state,
      workspaceChanges
    };
    this.post({ type: 'workspaceChangesChanged', workspaceChanges, messageId });
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
      queuedPrompts: [],
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
      plugins: previousState?.plugins ?? [],
      workspaceChanges: emptyWorkspaceChangeSummary(),
      config
    };
  }

  private toSessionState(session: NapSessionRecord): NapSessionState {
    return {
      ...this.state,
      sessionId: session.id,
      appThreadId: session.appThreadId,
      title: session.title || 'New Chat',
      status: 'idle',
      mode: session.mode,
      modelId: session.modelId,
      debugMode: session.debugMode,
      securityMode: session.securityMode,
      messages: session.messages,
      queuedPrompts: [],
      logs: [],
      plugins: this.state.plugins,
      workspaceChanges: emptyWorkspaceChangeSummary()
    };
  }

  private toCurrentSessionRecord(): NapSessionRecord {
    const now = Date.now();
    const firstUserMessage = this.state.messages.find(message => message.role === 'user')?.content.trim() ?? '';
    return {
      id: this.state.sessionId,
      appThreadId: this.state.appThreadId,
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

  private ensureWorkspaceChangeWatchers(): void {
    this.workspaceWatchers.forEach(disposable => disposable.dispose());
    this.workspaceWatchers = [];

    if (!vscode.workspace.workspaceFolders?.length) {
      return;
    }

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const schedule = () => this.scheduleWorkspaceChangeRefresh();
    this.workspaceWatchers.push(
      watcher,
      watcher.onDidCreate(schedule),
      watcher.onDidChange(schedule),
      watcher.onDidDelete(schedule),
      vscode.workspace.onDidSaveTextDocument(schedule),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.ensureWorkspaceChangeWatchers();
        this.scheduleWorkspaceChangeRefresh();
      })
    );
  }

  private scheduleWorkspaceChangeRefresh(): void {
    if (this.workspaceChangeTimer) {
      clearTimeout(this.workspaceChangeTimer);
    }
    const generation = this.workspaceChangeGeneration;
    this.workspaceChangeTimer = setTimeout(() => {
      this.workspaceChangeTimer = undefined;
      void this.refreshWorkspaceChanges(generation);
    }, 250);
  }

  private async refreshWorkspaceChanges(generation = this.workspaceChangeGeneration): Promise<void> {
    if (generation !== this.workspaceChangeGeneration) {
      return;
    }

    if (this.state.messages.length === 0) {
      await this.resetConversationChangeBaseline();
      return;
    }

    if (this.conversationTurnDiff?.trim()) {
      const workspaceChanges = summarizeUnifiedDiff(this.conversationTurnDiff);
      this.state = {
        ...this.state,
        workspaceChanges
      };
      this.post({ type: 'workspaceChangesChanged', workspaceChanges });
      return;
    }

    if (!this.conversationChangeBaseline) {
      this.conversationChangeBaseline = await getGitChangeSnapshot();
    }
    if (generation !== this.workspaceChangeGeneration) {
      return;
    }

    const current = await getGitChangeSnapshot();
    if (generation !== this.workspaceChangeGeneration) {
      return;
    }

    const workspaceChanges = summarizeConversationChanges(this.conversationChangeBaseline, current);
    this.state = {
      ...this.state,
      workspaceChanges
    };
    this.post({ type: 'workspaceChangesChanged', workspaceChanges });
  }

  private async resetConversationChangeBaseline(): Promise<void> {
    this.workspaceChangeGeneration += 1;
    if (this.workspaceChangeTimer) {
      clearTimeout(this.workspaceChangeTimer);
      this.workspaceChangeTimer = undefined;
    }
    const generation = this.workspaceChangeGeneration;
    const baseline = await getGitChangeSnapshot();
    if (generation !== this.workspaceChangeGeneration) {
      return;
    }
    this.conversationChangeBaseline = baseline;
    this.conversationTurnDiff = undefined;
    this.conversationTurnDiffsByMessageId.clear();
    this.state = {
      ...this.state,
      workspaceChanges: emptyWorkspaceChangeSummary()
    };
    this.post({ type: 'workspaceChangesChanged', workspaceChanges: this.state.workspaceChanges });
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
    const iconUris = {
      archive: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'archive.svg')).toString(),
      arrowUp: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'arrow-up.svg')).toString(),
      copy: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'copy.svg')).toString(),
      defaultPermissions: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'default-permissions.svg')).toString(),
      diff: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'diff.svg')).toString(),
      drag: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'drag.svg')).toString(),
      edit: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'edit.svg')).toString(),
      fullPermissions: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'full-permissions.svg')).toString(),
      new: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'new.svg')).toString(),
      settings: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'settings.svg')).toString(),
      settingsCat: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'settings-cat.svg')).toString()
    };
    html = html.replace(/(href|src)="\/([^"]+)"/g, (_match, attribute: string, resourcePath: string) => {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, resourcePath));
      return `${attribute}="${uri}"`;
    });
    html = html.replace(/%CSP_SOURCE%/g, webview.cspSource);
    html = html.replace(/%NONCE%/g, nonce);
    html = html.replace(/<script /g, `<script nonce="${nonce}" `);
    html = html.replace('<div id="root"></div>', `<script nonce="${nonce}">window.__NAP_LOGO_URI__ = ${JSON.stringify(logoUri.toString())}; window.__NAP_ICON_URIS__ = ${JSON.stringify(iconUris)};</script><div id="root"></div>`);
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
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#[\](){}<>]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(please\s+)?(can you|could you|would you|i want you to|i need you to|help me(?:\s+to)?)\s+/i, '')
    .trim();
  if (!cleaned) {
    return 'New Chat';
  }
  const sentence = cleaned.split(/[.!?\n]/)[0]?.trim() || cleaned;
  const words = sentence.match(/[A-Za-z0-9@._/+:-]+/g) ?? sentence.split(/\s+/);
  const title = words.slice(0, 8).map((word, index) => titleCaseWord(word, index)).join(' ') || sentence;
  return truncateText(title, 48);
}

function titleCaseWord(word: string, index = 0): string {
  if (/^[A-Z0-9_.+:/-]{2,}$/.test(word) || /[./:@]/.test(word)) {
    return word;
  }
  if (index > 0 && /^(a|an|the|to|for|with|and|or|of|in|on|as)$/i.test(word)) {
    return word.toLowerCase();
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

interface GitFileChangeStats {
  additions: number;
  deletions: number;
}

interface GitChangeSnapshot {
  tracked: Map<string, GitFileChangeStats>;
  untracked: Set<string>;
}

interface ConversationChangedFiles {
  tracked: string[];
  untracked: string[];
}

interface UnifiedDiffFileEntry {
  filePath: string;
  additions: number;
  deletions: number;
  diff: string;
}

async function getGitChangeSnapshot(): Promise<GitChangeSnapshot> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return emptyGitChangeSnapshot();
  }

  try {
    await runGit(workspaceRoot, ['rev-parse', '--is-inside-work-tree']);
    const [numstat, untracked] = await Promise.all([
      runGit(workspaceRoot, ['diff', '--numstat', 'HEAD', '--']),
      runGit(workspaceRoot, ['ls-files', '--others', '--exclude-standard'])
    ]);

    const tracked = new Map<string, GitFileChangeStats>();

    for (const line of numstat.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const [added, deleted, ...fileParts] = line.split('\t');
      const filePath = fileParts.join('\t');
      if (!filePath) {
        continue;
      }
      tracked.set(filePath, {
        additions: parseGitNumstatValue(added),
        deletions: parseGitNumstatValue(deleted)
      });
    }

    const untrackedFiles = untracked
      .split(/\r?\n/)
      .map(item => item.trim())
      .filter(Boolean);

    return {
      tracked,
      untracked: new Set(untrackedFiles)
    };
  } catch {
    return emptyGitChangeSnapshot();
  }
}

async function openChangedFilesReview(files: ConversationChangedFiles): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return;
  }

  await vscode.extensions.getExtension('vscode.git')?.activate();
  await vscode.commands.executeCommand('workbench.view.scm');

  const tracked = [...files.tracked].sort((first, second) => first.localeCompare(second));
  const untracked = [...files.untracked].sort((first, second) => first.localeCompare(second));

  for (const filePath of tracked) {
    await openTrackedFileDiff(workspaceRoot, filePath);
  }

  for (const filePath of untracked) {
    await openUntrackedFileReview(workspaceRoot, filePath);
  }
}

async function openUnifiedDiffReview(diff: string, sessionId: string, title = 'Suggested Edits'): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'napSuggestedEdits',
    title,
    vscode.ViewColumn.Active,
    {
      enableScripts: false,
      retainContextWhenHidden: true
    }
  );
  panel.webview.html = renderSuggestedEditsHtml(diff, title, sessionId);
}

async function openTrackedFileDiff(workspaceRoot: string, filePath: string): Promise<void> {
  const absolutePath = path.join(workspaceRoot, filePath);
  const workingUri = vscode.Uri.file(absolutePath);
  const headUri = workingUri.with({
    scheme: 'git',
    query: JSON.stringify({
      path: absolutePath,
      ref: 'HEAD'
    })
  });
  const title = `${filePath} (HEAD ↔ Working Tree)`;

  try {
    await vscode.commands.executeCommand('vscode.diff', headUri, workingUri, title, { preview: false });
  } catch {
    try {
      await vscode.commands.executeCommand('git.openChange', workingUri);
    } catch {
      await openExistingFile(workingUri);
    }
  }
}

function renderSuggestedEditsHtml(diff: string, title: string, sessionId: string): string {
  const entries = extractUnifiedDiffFileEntries(diff);
  const files = entries.length > 0
    ? entries
    : [{ filePath: 'Nap Diff', additions: 0, deletions: 0, diff }];
  const totalAdditions = files.reduce((total, file) => total + file.additions, 0);
  const totalDeletions = files.reduce((total, file) => total + file.deletions, 0);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: var(--vscode-editor-background, #141414);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --muted: var(--vscode-descriptionForeground, #858585);
      --border: var(--vscode-panel-border, #2d2d2d);
      --card: var(--vscode-editorWidget-background, #1b1b1b);
      --add-bg: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #73c991) 16%, transparent);
      --add-fg: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
      --del-bg: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c) 16%, transparent);
      --del-fg: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c);
      --hunk-bg: color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 15%, transparent);
      --hunk-fg: var(--vscode-editorInfo-foreground, #3794ff);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 18px;
      color: var(--fg);
      background: var(--bg);
      font: 12px var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
    }
    header {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 14px;
      font-family: var(--vscode-font-family, system-ui, sans-serif);
    }
    h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }
    .meta {
      margin-top: 5px;
      color: var(--muted);
      font-size: 11px;
    }
    .stats {
      display: inline-flex;
      gap: 10px;
      color: var(--muted);
      white-space: nowrap;
    }
    .add-stat { color: var(--add-fg); }
    .del-stat { color: var(--del-fg); }
    .file {
      overflow: hidden;
      margin: 0 0 14px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--card);
    }
    .file-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 9px 12px;
      border-bottom: 1px solid var(--border);
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: 12px;
      font-weight: 600;
    }
    .file-path {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    pre {
      margin: 0;
      padding: 0;
      overflow-x: auto;
      line-height: 1.45;
      tab-size: 2;
    }
    .line {
      display: block;
      min-height: 18px;
      padding: 0 12px;
      white-space: pre;
    }
    .line.add {
      color: var(--add-fg);
      background: var(--add-bg);
    }
    .line.del {
      color: var(--del-fg);
      background: var(--del-bg);
    }
    .line.hunk {
      color: var(--hunk-fg);
      background: var(--hunk-bg);
    }
    .line.file-marker {
      color: var(--muted);
      background: color-mix(in srgb, var(--border) 30%, transparent);
    }
    .line.context {
      color: var(--fg);
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">${files.length} ${files.length === 1 ? 'file' : 'files'} · ${escapeHtml(sessionId)}</div>
    </div>
    <div class="stats"><span class="add-stat">+${totalAdditions}</span><span class="del-stat">-${totalDeletions}</span></div>
  </header>
  ${files.map(renderDiffFileHtml).join('')}
</body>
</html>`;
}

function renderDiffFileHtml(file: UnifiedDiffFileEntry): string {
  return `<section class="file">
    <div class="file-header">
      <span class="file-path">${escapeHtml(file.filePath)}</span>
      <span class="stats"><span class="add-stat">+${file.additions}</span><span class="del-stat">-${file.deletions}</span></span>
    </div>
    <pre>${file.diff.split(/\r?\n/).filter((line, index, lines) => line || index < lines.length - 1).map(renderDiffLineHtml).join('')}</pre>
  </section>`;
}

function renderDiffLineHtml(line: string): string {
  const className = line.startsWith('@@')
    ? 'hunk'
    : line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')
      ? 'file-marker'
      : line.startsWith('+')
        ? 'add'
        : line.startsWith('-')
          ? 'del'
          : 'context';
  return `<span class="line ${className}">${escapeHtml(line || ' ')}</span>`;
}

async function openUntrackedFileReview(workspaceRoot: string, filePath: string): Promise<void> {
  const uri = vscode.Uri.file(path.join(workspaceRoot, filePath));
  await openExistingFile(uri);
}

async function openExistingFile(uri: vscode.Uri): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  } catch {
    // The file may have been deleted after the review bar was rendered.
  }
}

function getConversationChangedFiles(
  baseline: GitChangeSnapshot,
  current: GitChangeSnapshot
): ConversationChangedFiles {
  const tracked = new Set<string>();
  const untracked = new Set<string>();

  const trackedPaths = new Set([
    ...baseline.tracked.keys(),
    ...current.tracked.keys()
  ]);

  for (const filePath of trackedPaths) {
    const before = baseline.tracked.get(filePath) ?? { additions: 0, deletions: 0 };
    const after = current.tracked.get(filePath) ?? { additions: 0, deletions: 0 };
    if (before.additions !== after.additions || before.deletions !== after.deletions) {
      tracked.add(filePath);
    }
  }

  for (const filePath of current.untracked) {
    if (!baseline.untracked.has(filePath)) {
      untracked.add(filePath);
    }
  }

  return {
    tracked: [...tracked],
    untracked: [...untracked]
  };
}

function summarizeConversationChanges(
  baseline: GitChangeSnapshot,
  current: GitChangeSnapshot
): NapWorkspaceChangeSummary {
  const changedFiles = getConversationChangedFiles(baseline, current);
  let additions = 0;
  let deletions = 0;
  const files: NapWorkspaceChangeSummary['files'] = [];

  const trackedPaths = new Set([
    ...baseline.tracked.keys(),
    ...current.tracked.keys()
  ]);

  for (const filePath of trackedPaths) {
    const before = baseline.tracked.get(filePath) ?? { additions: 0, deletions: 0 };
    const after = current.tracked.get(filePath) ?? { additions: 0, deletions: 0 };
    if (before.additions === after.additions && before.deletions === after.deletions) {
      continue;
    }
    const fileAdditions = Math.max(0, after.additions - before.additions);
    const fileDeletions = Math.max(0, after.deletions - before.deletions);
    additions += fileAdditions;
    deletions += fileDeletions;
    files.push({
      filePath,
      additions: fileAdditions,
      deletions: fileDeletions,
      status: 'tracked'
    });
  }

  for (const filePath of changedFiles.untracked) {
    files.push({
      filePath,
      additions: 0,
      deletions: 0,
      status: 'untracked'
    });
  }

  files.sort((first, second) => first.filePath.localeCompare(second.filePath));

  return {
    filesChanged: changedFiles.tracked.length + changedFiles.untracked.length,
    additions,
    deletions,
    files
  };
}

function summarizeUnifiedDiff(diff: string): NapWorkspaceChangeSummary {
  const files = extractUnifiedDiffFileEntries(diff);
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);

  return {
    filesChanged: files.length,
    additions,
    deletions,
    files: files.map(file => ({
      filePath: file.filePath,
      additions: file.additions,
      deletions: file.deletions,
      status: 'tracked'
    }))
  };
}

function extractUnifiedDiffFileEntries(diff: string): UnifiedDiffFileEntry[] {
  const entries: UnifiedDiffFileEntry[] = [];
  let current: UnifiedDiffFileEntry | undefined;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const filePath = readUnifiedDiffFilePath(line);
      current = filePath
        ? { filePath, additions: 0, deletions: 0, diff: `${line}\n` }
        : undefined;
      if (current) {
        entries.push(current);
      }
      continue;
    }

    if (!current) {
      continue;
    }

    current.diff += `${line}\n`;
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      continue;
    }
    if (line.startsWith('+')) {
      current.additions += 1;
    } else if (line.startsWith('-')) {
      current.deletions += 1;
    }
  }

  return entries;
}

function readUnifiedDiffFilePath(line: string): string | undefined {
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  return match?.[2] ?? match?.[1];
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseGitNumstatValue(value: string | undefined): number {
  if (!value || value === '-') {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptyWorkspaceChangeSummary(): NapWorkspaceChangeSummary {
  return {
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    files: []
  };
}

function emptyGitChangeSnapshot(): GitChangeSnapshot {
  return {
    tracked: new Map(),
    untracked: new Set()
  };
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { cwd, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
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
