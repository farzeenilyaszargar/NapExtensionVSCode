export function parseGeminiStreamLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) {
    return '';
  }

  try {
    return extractGeminiStreamText(JSON.parse(trimmed));
  } catch {
    return '';
  }
}

export function extractTextFromJson(raw: string): string {
  try {
    return extractAnyText(JSON.parse(raw));
  } catch {
    return '';
  }
}

function extractGeminiStreamText(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return '';
  }

  if (Array.isArray(value)) {
    return value.map(extractGeminiStreamText).join('');
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
  const event = typeof record.event === 'string' ? record.event.toLowerCase() : '';
  const kind = type || event;

  if (kind && !/(content|text|delta|message|response|candidate)/i.test(kind)) {
    return '';
  }

  const direct = getString(record, ['delta', 'text', 'output_text', 'content']);
  if (direct) {
    return direct;
  }

  if (typeof record.value === 'string' && (!kind || /(content|text|delta)/i.test(kind))) {
    return record.value;
  }

  return [
    record.data,
    record.response,
    record.candidate,
    record.candidates,
    record.message,
    record.content,
    record.parts,
    record.part,
    record.value
  ].map(extractGeminiStreamText).join('');
}

function extractAnyText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(extractAnyText).join('');
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  const direct = getString(record, ['delta', 'text', 'content', 'message', 'output']);
  if (direct) {
    return direct;
  }

  return [
    record.data,
    record.response,
    record.candidate,
    record.candidates,
    record.content,
    record.parts,
    record.part,
    record.value
  ].map(extractAnyText).join('');
}

function getString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return '';
}
