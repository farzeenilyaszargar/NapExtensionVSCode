import { describe, expect, it } from 'vitest';
import { parseGeminiStreamLine } from './geminiStreamParser';

describe('parseGeminiStreamLine', () => {
  it('extracts Gemini content value events', () => {
    expect(parseGeminiStreamLine(JSON.stringify({
      type: 'content',
      value: 'Hello'
    }))).toBe('Hello');
  });

  it('extracts nested candidate text parts', () => {
    expect(parseGeminiStreamLine(JSON.stringify({
      type: 'response',
      candidates: [
        {
          content: {
            parts: [
              { text: 'Hello ' },
              { text: '**world**' }
            ]
          }
        }
      ]
    }))).toBe('Hello **world**');
  });

  it('ignores metadata events', () => {
    expect(parseGeminiStreamLine(JSON.stringify({
      type: 'start',
      value: 'session-123'
    }))).toBe('');
  });
});
