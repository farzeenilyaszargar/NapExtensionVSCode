import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: true
});

markdown.renderer.rules.mark_open = () => '<mark>';
markdown.renderer.rules.mark_close = () => '</mark>';

export function renderMarkdown(source: string): string {
  return markdown.render(source).replace(/==([^=\n][\s\S]*?[^=\n])==/g, '<mark>$1</mark>');
}
