import * as vscode from 'vscode';
import { NapChatViewProvider } from './napChatViewProvider';
import { NapDaemonService } from './services/napCliService';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Nap');
  const cliService = new NapDaemonService(context.extensionUri, output);
  const provider = new NapChatViewProvider(context.extensionUri, cliService, output);

  context.subscriptions.push(
    output,
    cliService,
    vscode.window.registerWebviewViewProvider(NapChatViewProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.commands.registerCommand('nap.openChat', async () => {
      cliService.ensureInteractiveTerminal();
      await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar').then(undefined, () => undefined);
      await vscode.commands.executeCommand(`${NapChatViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand('nap.moveChatToRight', async () => {
      await moveChatToRightPicker();
    }),
    vscode.commands.registerCommand('nap.newChat', async () => {
      await provider.newSession();
      await vscode.commands.executeCommand(`${NapChatViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand('nap.clearChat', () => {
      provider.clearSession();
    }),
    vscode.commands.registerCommand('nap.openAccounts', async () => {
      await vscode.env.openExternal(vscode.Uri.parse('https://www.nap-code.com/dashboard'));
    }),
    vscode.commands.registerCommand('nap.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:NapCode.nap');
    }),
    vscode.workspace.onDidChangeConfiguration(async event => {
      if (event.affectsConfiguration('nap')) {
        await provider.refreshConfiguration();
      }
    })
  );

  output.appendLine('[Nap] Extension activated.');
  void maybePromptToMoveRight(context);
}

export function deactivate(): void {
  // VS Code disposes extension subscriptions automatically.
}

async function runFirstAvailableCommand(commandIds: readonly string[]): Promise<void> {
  for (const commandId of commandIds) {
    try {
      await vscode.commands.executeCommand(commandId);
      return;
    } catch {
      // Try the next compatible VS Code command.
    }
  }
}

async function maybePromptToMoveRight(context: vscode.ExtensionContext): Promise<void> {
  const promptKey = 'nap.didPromptMoveChatToRight';
  if (context.globalState.get<boolean>(promptKey)) {
    return;
  }

  await context.globalState.update(promptKey, true);
  const move = 'Move View';
  const choice = await vscode.window.showInformationMessage(
    'Move Nap Chat to the right Secondary Sidebar?',
    move,
    'Later'
  );
  if (choice === move) {
    await moveChatToRightPicker();
  }
}

async function moveChatToRightPicker(): Promise<void> {
  await vscode.commands.executeCommand(`${NapChatViewProvider.viewType}.focus`);
  await runFirstAvailableCommand([
    'workbench.action.moveFocusedView',
    'workbench.action.moveView'
  ]);
}
