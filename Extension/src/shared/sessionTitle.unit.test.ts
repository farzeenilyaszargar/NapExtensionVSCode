import { describe, expect, it } from 'vitest';
import { generateSessionTitleFromPrompt } from './sessionTitle';

describe('session title generation', () => {
  it('creates compact 3-5 word titles from verbose prompts', () => {
    expect(generateSessionTitleFromPrompt('please fix the session naming system; right now it names the session after the first chat directly')).toBe('Fix Session Naming System');
    expect(generateSessionTitleFromPrompt('I want you to build a VS Code sidebar chat extension with streaming responses')).toBe('Build VS Code Sidebar Chat');
  });

  it('falls back for empty prompts', () => {
    expect(generateSessionTitleFromPrompt('   ')).toBe('New Chat');
  });
});
