import type { TemplateNode, TemplateContext } from './types.js';
export type { TemplateNode, TemplateContext } from './types.js';
/** Recursively interpret a manifest template node against a context. */
export declare function interpret(node: TemplateNode, context: TemplateContext): unknown;
/** Resolve a dotted path (e.g. "request.model" or "media.role") against context. */
export declare function extractValue(context: TemplateContext, path: string): unknown;
/** A truthy test: non-null, non-false, non-empty-string, non-zero, non-empty container. */
export declare function truthy(v: unknown): boolean;
export declare function toNumber(v: unknown): number;
export declare function toBool(v: unknown): boolean;
//# sourceMappingURL=template.d.ts.map