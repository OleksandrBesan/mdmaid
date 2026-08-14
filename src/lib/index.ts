/**
 * mdmaid - Markdown + Mermaid made simple
 *
 * A powerful markdown renderer with first-class Mermaid diagram support
 */

export { renderMarkdown, extractMermaidBlocks, type RenderOptions } from '../core/renderer.js';
export {
  validateMarkdown,
  validateMermaid,
  type MarkdownValidationResult,
  type MermaidValidationResult,
  type ValidateMarkdownOptions,
  type ValidationDiagnostic,
  type ValidationKind,
  type ValidationLocation,
  type ValidationMode,
  type ValidationPoint,
  type ValidationSeverity,
  type ValidationStage,
} from '../core/validation.js';

// Re-export for convenience
export { remark } from 'remark';
