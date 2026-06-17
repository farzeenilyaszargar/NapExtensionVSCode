import * as fs from 'node:fs';
import {
  CacheStatus,
  NapJobRecord,
  NapSessionRecord,
  WorkspaceIndexStatus
} from '../protocol';
import { ensureNapDataDir, getSqlitePath, getStatePath } from '../runtimePaths';

interface PersistedDaemonState {
  schemaVersion: 1;
  sessions: NapSessionRecord[];
  jobs: NapJobRecord[];
  defaultModelId: string;
  workspaceIndexes: WorkspaceIndexStatus[];
  cache: CacheStatus;
}

const DEFAULT_STATE: PersistedDaemonState = {
  schemaVersion: 1,
  sessions: [],
  jobs: [],
  defaultModelId: 'auto',
  workspaceIndexes: [],
  cache: {
    entries: 0,
    bytes: 0
  }
};

export class DaemonStorage {
  private state: PersistedDaemonState;
  private sqlite: SqliteStateStore | undefined;

  constructor() {
    ensureNapDataDir();
    this.sqlite = SqliteStateStore.tryCreate();
    this.state = this.load();
  }

  listSessions(): NapSessionRecord[] {
    return [...this.state.sessions].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  getSession(sessionId: string): NapSessionRecord | undefined {
    return this.state.sessions.find(session => session.id === sessionId);
  }

  upsertSession(session: NapSessionRecord): void {
    this.state.sessions = [
      session,
      ...this.state.sessions.filter(existing => existing.id !== session.id)
    ];
    this.save();
  }

  deleteSession(sessionId: string): void {
    this.state.sessions = this.state.sessions.filter(session => session.id !== sessionId);
    this.state.jobs = this.state.jobs.filter(job => job.sessionId !== sessionId);
    this.save();
  }

  listJobs(): NapJobRecord[] {
    return [...this.state.jobs].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  getJob(jobId: string): NapJobRecord | undefined {
    return this.state.jobs.find(job => job.id === jobId);
  }

  upsertJob(job: NapJobRecord): void {
    this.state.jobs = [
      job,
      ...this.state.jobs.filter(existing => existing.id !== job.id)
    ].slice(0, 250);
    this.save();
  }

  getDefaultModelId(): string {
    return this.state.defaultModelId;
  }

  setDefaultModelId(modelId: string): void {
    this.state.defaultModelId = modelId;
    this.save();
  }

  getWorkspaceIndex(workspaceRoot?: string): WorkspaceIndexStatus {
    return this.state.workspaceIndexes.find(item => item.workspaceRoot === workspaceRoot) ?? {
      workspaceRoot,
      status: 'idle',
      indexedFiles: 0
    };
  }

  upsertWorkspaceIndex(index: WorkspaceIndexStatus): void {
    this.state.workspaceIndexes = [
      index,
      ...this.state.workspaceIndexes.filter(item => item.workspaceRoot !== index.workspaceRoot)
    ];
    this.save();
  }

  getCacheStatus(): CacheStatus {
    return this.state.cache;
  }

  clearCache(): CacheStatus {
    this.state.cache = {
      entries: 0,
      bytes: 0,
      updatedAt: Date.now()
    };
    this.save();
    return this.state.cache;
  }

  private load(): PersistedDaemonState {
    const sqliteState = this.sqlite?.read();
    if (sqliteState) {
      return sqliteState;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(getStatePath(), 'utf8')) as PersistedDaemonState;
      return {
        ...DEFAULT_STATE,
        ...parsed
      };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  private save(): void {
    if (this.sqlite) {
      this.sqlite.write(this.state);
      return;
    }

    fs.writeFileSync(getStatePath(), JSON.stringify(this.state, null, 2));
  }
}

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: unknown[]): unknown;
    run(...values: unknown[]): void;
  };
}

class SqliteStateStore {
  private constructor(private readonly db: DatabaseSyncLike) {
    this.db.exec('CREATE TABLE IF NOT EXISTS nap_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  static tryCreate(): SqliteStateStore | undefined {
    try {
      const sqlite = require('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSyncLike };
      return new SqliteStateStore(new sqlite.DatabaseSync(getSqlitePath()));
    } catch {
      return undefined;
    }
  }

  read(): PersistedDaemonState | undefined {
    const row = this.db.prepare('SELECT value FROM nap_state WHERE key = ?').get('state') as { value?: string } | undefined;
    if (!row?.value) {
      return undefined;
    }

    try {
      return {
        ...DEFAULT_STATE,
        ...JSON.parse(row.value)
      };
    } catch {
      return undefined;
    }
  }

  write(state: PersistedDaemonState): void {
    this.db
      .prepare('INSERT INTO nap_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('state', JSON.stringify(state));
  }
}
