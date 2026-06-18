import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DaemonRuntimeInfo } from './protocol';

const APP_DIR = 'Nap';
const RUNTIME_FILE = 'napd.json';
const STATE_FILE = 'napd-state.json';
const SQLITE_FILE = 'napd.sqlite';
const LOG_FILE = 'napd.log';

export function getNapDataDir(): string {
  const base = process.env.XDG_STATE_HOME
    ?? (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.local', 'state'));
  return path.join(base, APP_DIR);
}

export function ensureNapDataDir(): string {
  const dir = getNapDataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'indexes'), { recursive: true });
  return dir;
}

export function getRuntimeInfoPath(): string {
  return path.join(getNapDataDir(), RUNTIME_FILE);
}

export function getStatePath(): string {
  return path.join(getNapDataDir(), STATE_FILE);
}

export function getSqlitePath(): string {
  return path.join(getNapDataDir(), SQLITE_FILE);
}

export function getDaemonLogPath(): string {
  return path.join(getNapDataDir(), LOG_FILE);
}

export function appendDaemonLog(message: string): void {
  try {
    ensureNapDataDir();
    fs.appendFileSync(getDaemonLogPath(), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never break daemon startup or chat streaming.
  }
}

export function readRuntimeInfo(): DaemonRuntimeInfo | undefined {
  try {
    return JSON.parse(fs.readFileSync(getRuntimeInfoPath(), 'utf8')) as DaemonRuntimeInfo;
  } catch {
    return undefined;
  }
}

export function writeRuntimeInfo(info: DaemonRuntimeInfo): void {
  ensureNapDataDir();
  fs.writeFileSync(getRuntimeInfoPath(), JSON.stringify(info, null, 2));
}

export function clearRuntimeInfo(): void {
  try {
    fs.rmSync(getRuntimeInfoPath(), { force: true });
  } catch {
    // Best-effort cleanup.
  }
}
