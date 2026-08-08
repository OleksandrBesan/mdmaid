export type TuiBackend = 'auto' | 'veol' | 'beautiful-mermaid' | 'source';

export interface TuiRenderOptions {
  width?: number;
  backend?: TuiBackend;
  veolPath?: string;
  beautifulMermaid?: boolean;
  unicode?: boolean;
}

export interface TuiRenderResult {
  output: string;
  backend: Exclude<TuiBackend, 'auto'>;
  warnings: string[];
}
