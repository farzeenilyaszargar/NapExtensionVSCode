const MAX_TITLE_WORDS = 5;
const MIN_TITLE_WORDS = 3;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'my',
  'of',
  'on',
  'or',
  'please',
  'right',
  'now',
  'the',
  'this',
  'that',
  'to',
  'with',
  'you',
  'your',
  'directly'
]);

export function generateSessionTitleFromPrompt(prompt: string, fallback = 'New Chat'): string {
  const cleaned = prompt
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#[\](){}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(please\s+)?(can you|could you|would you|i want you to|i need you to|help me(?:\s+to)?)\s+/i, '')
    .trim();

  if (!cleaned) {
    return fallback;
  }

  const sentence = cleaned.split(/[.!?;\n]/)[0]?.trim() || cleaned;
  const rawWords = sentence.match(/[A-Za-z0-9@._/+:-]+/g) ?? sentence.split(/\s+/);
  const meaningfulWords = rawWords
    .map(word => word.replace(/^[^\w@]+|[^\w./:@+-]+$/g, ''))
    .filter(Boolean)
    .filter(word => !STOP_WORDS.has(word.toLowerCase()));

  const sourceWords = meaningfulWords.length >= MIN_TITLE_WORDS ? meaningfulWords : rawWords.filter(Boolean);
  const title = sourceWords
    .slice(0, MAX_TITLE_WORDS)
    .map((word, index) => titleCaseWord(word, index))
    .join(' ')
    .trim();

  return title || fallback;
}

function titleCaseWord(word: string, index = 0): string {
  if (/^[A-Z0-9_.+:/-]{2,}$/.test(word) || /[./:@]/.test(word)) {
    return word;
  }
  if (index > 0 && /^(a|an|the|to|for|with|and|or|of|in|on|as)$/i.test(word)) {
    return word.toLowerCase();
  }
  return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
}
