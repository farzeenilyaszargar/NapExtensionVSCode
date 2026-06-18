import * as vscode from 'vscode';
import { getNapConfiguration } from './configuration';

export class NapSettingsPanel {
  private static panel: vscode.WebviewPanel | undefined;

  static open(extensionUri: vscode.Uri): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.panel.webview.html = this.getHtml(this.panel.webview);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'nap.settings',
      'Nap Settings',
      vscode.ViewColumn.Active,
      {
        enableScripts: false,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'logo.svg');
    panel.webview.html = this.getHtml(panel.webview);
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private static getHtml(webview: vscode.Webview): string {
    const config = getNapConfiguration();
    const settings = [
      ['nap.cliPath', config.cliPath],
      ['nap.defaultModel', config.defaultModel],
      ['nap.debugMode', String(config.debugMode)],
      ['nap.securityMode', config.securityMode],
      ['nap.accentColor', config.accentColor || 'theme default']
    ];
    const rows = settings.map(([key, value]) => `
      <div class="row">
        <code>${escapeHtml(key)}</code>
        <span>${escapeHtml(value)}</span>
      </div>
    `).join('');

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nap Settings</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font: 13px var(--vscode-font-family);
    }
    main {
      width: min(760px, calc(100vw - 72px));
      margin: 0 auto;
      padding: 42px 0 64px;
    }
    header {
      padding-bottom: 22px;
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border, #3c3c3c) 65%, transparent);
    }
    h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 600;
      letter-spacing: 0;
    }
    .subtle {
      margin: 8px 0 0;
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
    }
    section {
      padding: 24px 0;
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border, #3c3c3c) 48%, transparent);
    }
    h2 {
      margin: 0 0 14px;
      font-size: 13px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .code-surface {
      overflow: hidden;
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border, #3c3c3c) 80%, transparent);
      border-radius: 6px;
      background: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background));
    }
    .row {
      display: grid;
      grid-template-columns: minmax(170px, 32%) minmax(0, 1fr);
      gap: 16px;
      align-items: center;
      min-height: 38px;
      padding: 0 14px;
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border, #3c3c3c) 40%, transparent);
    }
    .row:last-child {
      border-bottom: 0;
    }
    code {
      color: var(--vscode-symbolIcon-propertyForeground, var(--vscode-textPreformat-foreground));
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }
    .row span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-descriptionForeground);
    }
    .hint {
      margin-top: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Nap Settings</h1>
      <p class="subtle">Central configuration surface for the Nap VS Code extension.</p>
    </header>
    <section>
      <h2>Current Configuration</h2>
      <div class="code-surface">${rows}</div>
      <p class="hint">Edit these from VS Code Settings for now; this panel is ready for richer Nap-native controls.</p>
    </section>
    <section>
      <h2>Runtime</h2>
      <div class="code-surface">
        <div class="row"><code>app-server</code><span>nap app-server --listen stdio://</span></div>
        <div class="row"><code>transport</code><span>stdio JSON-RPC-like messages</span></div>
        <div class="row"><code>client</code><span>Nap Chat webview</span></div>
      </div>
    </section>
  </main>
</body>
</html>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
