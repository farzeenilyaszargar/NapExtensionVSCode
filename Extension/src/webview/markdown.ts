import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: true
});

markdown.renderer.rules.mark_open = () => '<mark>';
markdown.renderer.rules.mark_close = () => '</mark>';
markdown.renderer.rules.text = (tokens, index) => linkifyFileReferences(markdown.utils.escapeHtml(tokens[index].content));
markdown.renderer.rules.code_inline = (tokens, index) => {
  const content = tokens[index].content;
  if (isFileReference(content)) {
    return fileReferenceLink(content, `<code>${markdown.utils.escapeHtml(content)}</code>`);
  }
  return `<code>${markdown.utils.escapeHtml(content)}</code>`;
};

export function renderMarkdown(source: string): string {
  return markdown.render(stripNapActivityMarkers(source)).replace(/==([^=\n][\s\S]*?[^=\n])==/g, '<mark>$1</mark>');
}

const FILE_REFERENCE_PATTERN = /(^|[\s([,{])((?:(?:\.{1,2}\/|\/|[A-Za-z0-9_.-]+\/)[^\s`<>"')\]}]+?\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|yml|yaml|toml|py|rs|go|java|kt|swift|c|cpp|h|hpp|cs|rb|php|sh|bash|zsh|sql|txt|xml|svg|png|jpg|jpeg|webp|gif|lock|config)(?::\d+)?(?::\d+)?|(?:package(?:-lock)?\.json|README\.md|readme\.md|tsconfig\.json|vite\.config\.ts|vitest\.config\.ts)(?::\d+)?(?::\d+)?))(?=$|[\s.,;!?)]|\})/g;

function linkifyFileReferences(htmlEscapedText: string): string {
  return htmlEscapedText.replace(FILE_REFERENCE_PATTERN, (_match, prefix: string, filePath: string) =>
    `${prefix}${fileReferenceLink(filePath, markdown.utils.escapeHtml(filePath))}`
  );
}

function isFileReference(value: string): boolean {
  FILE_REFERENCE_PATTERN.lastIndex = 0;
  return FILE_REFERENCE_PATTERN.test(` ${value}`);
}

function fileReferenceLink(filePath: string, label: string): string {
  return `<a href="#" class="nap-file-link" data-nap-file="${escapeAttribute(filePath)}">${label}</a>`;
}

function escapeAttribute(value: string): string {
  return markdown.utils.escapeHtml(value).replace(/"/g, '&quot;');
}

function stripNapActivityMarkers(source: string): string {
  return source.replace(/(?:^|\n):::nap-activity[ \t]+[A-Za-z0-9+/_=-]+(?:\r?\n:::)?[ \t]*(?:\r?\n)?/g, '\n');
}
