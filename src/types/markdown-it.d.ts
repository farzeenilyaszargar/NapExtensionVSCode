declare module 'markdown-it' {
  export interface MarkdownItOptions {
    breaks?: boolean;
    html?: boolean;
    linkify?: boolean;
    typographer?: boolean;
  }

  export interface Renderer {
    rules: Record<string, (...args: unknown[]) => string>;
  }

  export default class MarkdownIt {
    renderer: Renderer;
    constructor(options?: MarkdownItOptions);
    render(source: string): string;
  }
}
