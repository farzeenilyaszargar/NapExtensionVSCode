import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('Nap markdown rendering', () => {
  it('linkifies workspace file references', () => {
    const html = renderMarkdown('Open src/webview/App.tsx:42 for details.');

    expect(html).toContain('data-nap-file="src/webview/App.tsx:42"');
    expect(html).toContain('class="nap-file-link"');
  });

  it('linkifies backticked file references', () => {
    const html = renderMarkdown('See `package.json`.');

    expect(html).toContain('data-nap-file="package.json"');
    expect(html).toContain('<code>package.json</code>');
  });
});
