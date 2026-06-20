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
    :root {
      color-scheme: light dark;
      --nap-bg: var(--vscode-editor-background);
      --nap-page: color-mix(in srgb, var(--vscode-editor-background) 88%, #2a2a2a);
      --nap-fg: var(--vscode-editor-foreground);
      --nap-muted: var(--vscode-descriptionForeground);
      --nap-border: color-mix(in srgb, var(--vscode-panel-border, #3c3c3c) 62%, transparent);
      --nap-card: color-mix(in srgb, var(--vscode-editorWidget-background, #1b1b1b) 88%, transparent);
      --nap-card-strong: color-mix(in srgb, var(--vscode-sideBar-background, #181818) 90%, #101010);
      --nap-row: color-mix(in srgb, var(--vscode-list-hoverBackground, #2a2a2a) 32%, transparent);
      --nap-accent: var(--vscode-button-background, #6f6f6f);
      --settings-nav-width: 210px;
    }
    * { box-sizing: border-box; }
    html {
      width: 100dvw;
      max-width: 100%;
      margin: 0;
      padding: 0;
      overflow-x: hidden;
    }
    body {
      width: 100dvw;
      max-width: 100%;
      margin: 0;
      padding: 0;
      overflow-x: hidden;
      background: var(--nap-page);
      color: var(--nap-fg);
      font: 13px var(--vscode-font-family);
    }
    .settings-shell {
      width: 100dvw;
      max-width: 100%;
      min-height: 100vh;
      margin: 0;
      padding: 0;
      padding-left: var(--settings-nav-width);
      display: block;
    }
    .sidebar {
      position: fixed;
      left: 0;
      top: 0;
      bottom: 0;
      width: var(--settings-nav-width);
      height: 100vh;
      display: block;
      padding: 18px 10px;
      overflow-y: auto;
      overflow-x: hidden;
      border-right: 1px solid var(--nap-border);
      background: color-mix(in srgb, var(--vscode-sideBar-background, #181818) 92%, #222222);
      box-shadow: none;
      scrollbar-width: none;
    }
    .sidebar::-webkit-scrollbar {
      display: none;
    }
    nav {
      display: grid;
      gap: 3px;
    }
    nav a {
      display: flex;
      align-items: center;
      min-height: 30px;
      padding: 0 9px;
      border-radius: 7px;
      color: var(--nap-muted);
      text-decoration: none;
      font-size: 12px;
    }
    nav a:first-child {
      color: #f0f0f0;
      background: color-mix(in srgb, var(--vscode-list-hoverBackground, #2b2b2b) 72%, transparent);
    }
    .content {
      min-width: 0;
      display: grid;
      gap: 18px;
      width: min(920px, calc(100% - 48px));
      margin: 0 auto;
      padding: 34px 0 56px;
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 20px;
      align-items: end;
      padding: 2px 0 8px;
    }
    h1 {
      margin: 0;
      font-size: 25px;
      font-weight: 600;
      letter-spacing: 0;
    }
    .subtle {
      margin: 7px 0 0;
      max-width: 640px;
      color: var(--nap-muted);
      line-height: 1.5;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 28px;
      padding: 0 10px;
      border: 1px solid var(--nap-border);
      border-radius: 999px;
      color: #d8d8d8;
      background: color-mix(in srgb, var(--nap-card) 82%, transparent);
      font-size: 11.5px;
      white-space: nowrap;
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: #7bbf7b;
      box-shadow: 0 0 12px rgba(123, 191, 123, 0.28);
    }
    .account-card {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 16px;
      align-items: center;
      padding: 18px;
      border: 1px solid var(--nap-border);
      border-radius: 12px;
      background: var(--nap-card-strong);
      box-shadow: 0 18px 55px rgba(0, 0, 0, 0.22);
    }
    .avatar {
      width: 52px;
      height: 52px;
      display: grid;
      place-items: center;
      border-radius: 15px;
      border: 1px solid #343434;
      background: #202020;
      color: #eeeeee;
      font-size: 17px;
      font-weight: 650;
    }
    .account-main {
      min-width: 0;
    }
    .account-name {
      margin: 0;
      color: #efefef;
      font-size: 16px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .account-meta {
      margin-top: 5px;
      color: var(--nap-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .quick-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .metric {
      padding: 12px 13px;
      border: 1px solid var(--nap-border);
      border-radius: 10px;
      background: var(--nap-card);
    }
    .metric-label {
      color: var(--nap-muted);
      font-size: 11px;
    }
    .metric-value {
      margin-top: 6px;
      color: #e2e2e2;
      font-size: 13px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    section.setting-section {
      overflow: hidden;
      border: 1px solid var(--nap-border);
      border-radius: 12px;
      background: color-mix(in srgb, var(--nap-card) 92%, transparent);
    }
    h2 {
      margin: 0;
      padding: 14px 16px 13px;
      border-bottom: 1px solid color-mix(in srgb, var(--nap-border) 72%, transparent);
      font-size: 13px;
      font-weight: 600;
      color: #e0e0e0;
    }
    .code-surface {
      overflow: hidden;
      background: transparent;
    }
    .row {
      display: grid;
      grid-template-columns: minmax(170px, 32%) minmax(0, 1fr);
      gap: 16px;
      align-items: center;
      min-height: 40px;
      padding: 0 16px;
      border-bottom: 1px solid color-mix(in srgb, var(--nap-border) 46%, transparent);
    }
    .row:last-child { border-bottom: 0; }
    code {
      color: #8f8f8f;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
    }
    .row span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #d8d8d8;
    }
    .hint {
      margin-top: 12px;
      color: var(--nap-muted);
      line-height: 1.5;
    }
    @media (max-width: 760px) {
      .settings-shell {
        width: 100dvw;
        max-width: 100%;
        padding-left: 0;
      }
      .sidebar {
        position: static;
        height: auto;
        padding: 8px;
        border-right: 0;
        border-bottom: 1px solid var(--nap-border);
      }
      nav {
        display: flex;
        gap: 4px;
        overflow-x: auto;
        scrollbar-width: none;
      }
      nav::-webkit-scrollbar {
        display: none;
      }
      nav a {
        flex: 0 0 auto;
        min-height: 28px;
        white-space: nowrap;
      }
      .content {
        width: calc(100dvw - 20px);
        padding: 18px 0 36px;
      }
      .hero {
        grid-template-columns: 1fr;
      }
      .quick-grid {
        grid-template-columns: 1fr;
      }
      .row {
        grid-template-columns: 1fr;
        gap: 5px;
        padding: 10px 14px;
      }
    }
  </style>
</head>
<body>
  <main class="settings-shell">
    <aside class="sidebar" aria-label="Nap settings sections">
      <nav>
        <a href="#account">General</a>
        <a href="#config">Config</a>
        <a href="#usage">Usage & Billing</a>
        <a href="#runtime">Runtime</a>
        <a href="#mcp">MCPs</a>
        <a href="#hooks">Hooks</a>
        <a href="#plugins">Plugins</a>
      </nav>
    </aside>
    <div class="content">
      <header class="hero">
        <div>
          <h1>Nap Settings</h1>
          <p class="subtle">Account, configuration, usage, and runtime state for the Nap VS Code extension.</p>
        </div>
        <div class="status-pill"><span class="status-dot"></span>${escapeHtml(account.status)}</div>
      </header>
      ${accountHero(account)}
      <div class="quick-grid">
        ${metric('Model', config.defaultModel)}
        ${metric('Security', config.securityMode)}
        ${metric('Auth', account.refreshToken)}
      </div>
      <div id="account">${section('Account', accountRows)}</div>
      <div id="usage">${section('Usage & Billing', usageRows)}</div>
      <div id="config">${section('Current Configuration', configRows)}</div>
      <div id="runtime">${section('Runtime', runtimeRows)}</div>
      <div id="mcp">${section('MCPs', [{ key: 'servers', value: 'Coming soon from napd' }])}</div>
      <div id="hooks">${section('Hooks', [{ key: 'status', value: 'Coming soon' }])}</div>
      <div id="plugins">${section('Plugins', [{ key: 'status', value: 'Coming soon' }])}</div>
    </div>
  </main>
</body>
</html>`;
  }
}

function section(title: string, rows: SettingsRow[]): string {
  return `<section class="setting-section"><h2>${escapeHtml(title)}</h2><div class="code-surface">${rows.map(row).join('')}</div></section>`;
}

function accountHero(account: LocalAccountInfo): string {
  const name = account.name !== 'Unknown' ? account.name : account.email !== 'Unknown' ? account.email : 'Nap account';
  const initials = initialsFromName(name);
  const meta = account.email !== 'Unknown' ? account.email : account.accountId !== 'Unknown' ? account.accountId : account.status;
  return `<section class="account-card" aria-label="Nap account summary"><div class="avatar">${escapeHtml(initials)}</div><div class="account-main"><p class="account-name">${escapeHtml(name)}</p><div class="account-meta">${escapeHtml(meta)}</div></div></section>`;
}

function metric(label: string, value: string): string {
  return `<div class="metric"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div></div>`;
}

function initialsFromName(value: string): string {
  const parts = value
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .map(part => part.trim())
    .filter(Boolean);
  const first = parts[0]?.charAt(0) ?? 'N';
  const second = parts.length > 1 ? parts[1]?.charAt(0) : parts[0]?.charAt(1);
  return `${first}${second ?? ''}`.toUpperCase();
}

function row(item: SettingsRow): string {
  return `<div class="row"><code>${escapeHtml(item.key)}</code><span>${escapeHtml(item.value)}</span></div>`;
}

function readLocalAccountInfo(): LocalAccountInfo {
  const napHome = process.env.NAP_HOME ?? path.join(os.homedir(), '.nap');
  const auth = readJsonObject(path.join(napHome, 'auth.json'));
  const serviceAuth = readJsonObject(path.join(napHome, 'service-auth.json'));
  const vscodeAuth = readJsonObject(path.join(napHome, 'vscode-auth.json'));
  const tokens = readObject(auth?.tokens);
  const idToken = readString(tokens?.id_token)
    ?? readString(vscodeAuth?.id_token)
    ?? readString(tokens?.access_token)
    ?? readString(vscodeAuth?.access_token)
    ?? readString(serviceAuth?.accessToken);
  const claims = readJwtClaims(idToken);
  const openAiAuth = readObject(claims?.['https://api.openai.com/auth']);
  const expiresAt = readNumber(claims?.exp) ? readNumber(claims?.exp)! * 1000 : readNumber(serviceAuth?.expiresAt);
  const refreshToken = readString(tokens?.refresh_token)
    ?? readString(vscodeAuth?.refresh_token)
    ?? readString(auth?.refreshToken)
    ?? readString(auth?.refresh_token);
  const hasAuth = Boolean(auth || serviceAuth || vscodeAuth);
  const hasAccount = Boolean(readString(claims?.email) || readString(claims?.sub) || readString(tokens?.account_id) || readString(openAiAuth?.chatgpt_account_id));

  return {
    status: hasAuth && hasAccount ? 'Signed in locally' : hasAuth ? 'Credentials saved locally' : 'Not signed in',
    name: readString(claims?.name) ?? readString(claims?.preferred_username) ?? 'Unknown',
    email: readString(claims?.email) ?? 'Unknown',
    accountId: readString(tokens?.account_id)
      ?? readString(openAiAuth?.chatgpt_account_id)
      ?? readString(claims?.chatgpt_account_id)
      ?? readString(claims?.sub)
      ?? 'Unknown',
    authMode: readString(auth?.auth_mode) ?? readString(serviceAuth?.source) ?? (vscodeAuth ? 'VS Code OAuth' : 'Unknown'),
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
