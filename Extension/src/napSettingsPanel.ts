import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getNapConfiguration } from './configuration';

interface SettingsRow {
  key: string;
  value: string;
}

interface LocalAccountInfo {
  status: string;
  name: string;
  email: string;
  accountId: string;
  authMode: string;
  refreshToken: string;
  lastRefresh: string;
  tokenExpires: string;
}

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
    const account = readLocalAccountInfo();
    const configRows: SettingsRow[] = [
      { key: 'nap.cliPath', value: config.cliPath },
      { key: 'nap.defaultModel', value: config.defaultModel },
      { key: 'nap.debugMode', value: String(config.debugMode) },
      { key: 'nap.securityMode', value: config.securityMode },
      { key: 'nap.accentColor', value: config.accentColor || 'theme default' }
    ];
    const accountRows: SettingsRow[] = [
      { key: 'status', value: account.status },
      { key: 'username', value: account.name },
      { key: 'email', value: account.email },
      { key: 'account_id', value: account.accountId },
      { key: 'auth_mode', value: account.authMode },
      { key: 'refresh_token', value: account.refreshToken },
      { key: 'last_refresh', value: account.lastRefresh },
      { key: 'token_expires', value: account.tokenExpires }
    ];
    const usageRows: SettingsRow[] = [
      { key: 'plan', value: 'Not reported by local CLI yet' },
      { key: 'usage', value: 'Pending Nap backend usage endpoint' },
      { key: 'remaining', value: 'Pending Nap backend usage endpoint' },
      { key: 'billing', value: 'Open dashboard for live billing details' }
    ];
    const runtimeRows: SettingsRow[] = [
      { key: 'app-server', value: 'nap app-server --listen stdio://' },
      { key: 'transport', value: 'stdio JSON-RPC-like messages' },
      { key: 'client', value: 'Nap Chat webview' }
    ];

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nap Settings</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font: 13px var(--vscode-font-family);
    }
    main {
      width: min(820px, calc(100vw - 72px));
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
    .row:last-child { border-bottom: 0; }
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
      color: #d6d6d6;
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
      <p class="subtle">Account, configuration, usage, and runtime state for the Nap VS Code extension.</p>
    </header>
    ${section('Account', accountRows)}
    ${section('Usage & Billing', usageRows)}
    ${section('Current Configuration', configRows)}
    ${section('Runtime', runtimeRows)}
  </main>
</body>
</html>`;
  }
}

function section(title: string, rows: SettingsRow[]): string {
  return `<section><h2>${escapeHtml(title)}</h2><div class="code-surface">${rows.map(row).join('')}</div></section>`;
}

function row(item: SettingsRow): string {
  return `<div class="row"><code>${escapeHtml(item.key)}</code><span>${escapeHtml(item.value)}</span></div>`;
}

function readLocalAccountInfo(): LocalAccountInfo {
  const napHome = process.env.NAP_HOME ?? path.join(os.homedir(), '.nap');
  const auth = readJsonObject(path.join(napHome, 'auth.json'));
  const serviceAuth = readJsonObject(path.join(napHome, 'service-auth.json'));
  const tokens = readObject(auth?.tokens);
  const idToken = readString(tokens?.id_token) ?? readString(tokens?.access_token) ?? readString(serviceAuth?.accessToken);
  const claims = readJwtClaims(idToken);
  const expiresAt = readNumber(claims?.exp) ? readNumber(claims?.exp)! * 1000 : readNumber(serviceAuth?.expiresAt);
  const refreshToken = readString(tokens?.refresh_token) ?? readString(auth?.refreshToken) ?? readString(auth?.refresh_token);
  const hasAuth = Boolean(auth || serviceAuth);
  const hasAccount = Boolean(readString(claims?.email) || readString(claims?.sub) || readString(tokens?.account_id));

  return {
    status: hasAuth && hasAccount ? 'Signed in locally' : hasAuth ? 'Credentials saved locally' : 'Not signed in',
    name: readString(claims?.name) ?? readString(claims?.preferred_username) ?? 'Unknown',
    email: readString(claims?.email) ?? 'Unknown',
    accountId: readString(tokens?.account_id) ?? readString(claims?.sub) ?? readString(claims?.chatgpt_account_id) ?? 'Unknown',
    authMode: readString(auth?.auth_mode) ?? readString(serviceAuth?.source) ?? 'Unknown',
    refreshToken: refreshToken ? 'Available' : 'Not saved',
    lastRefresh: formatDate(readString(auth?.last_refresh) ?? readNumber(serviceAuth?.createdAt)),
    tokenExpires: formatDate(expiresAt)
  };
}

function readJwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  const [, payload] = token?.split('.') ?? [];
  if (!payload) {
    return undefined;
  }
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return readObject(JSON.parse(Buffer.from(padded, 'base64').toString('utf8')));
  } catch {
    return undefined;
  }
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  try {
    return readObject(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return undefined;
  }
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatDate(value: string | number | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return 'Unknown';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
