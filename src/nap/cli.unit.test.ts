import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Nap CLI architecture', () => {
  it('uses the daemon JSON-RPC client instead of direct provider subprocesses', () => {
    const source = readFileSync(join(__dirname, 'cli.ts'), 'utf8');

    expect(source).toContain("import { NapDaemonClient } from './client'");
    expect(source).not.toContain("spawn(");
    expect(source).not.toContain("exec(");
  });
});
