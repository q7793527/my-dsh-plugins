import type { MediaAsset, MediaRequest } from './types.js';
import { type TemplateContext } from './template.js';
export declare function listProviders(): {
    id: string;
    label: string;
    capabilities: string[];
    baseUrl: string;
    description: string;
}[];
/**
 * 单次生成的时间预算。abort 信号、轮询总时长、收尾余量必须自洽：
 * MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS + POLL_MARGIN_MS <= GENERATION_BUDGET_MS
 */
export declare const GENERATION_BUDGET_MS: number;
export declare const POLL_INTERVAL_MS = 3000;
export declare const POLL_MARGIN_MS = 30000;
export declare const MAX_POLL_ATTEMPTS: number;
/**
 * Render a manifest URL template. Manifests use `{{expr}}` placeholders where
 * `expr` is `model`, `taskId`, or a dotted path such as
 * `request.providerOptions.vertex-gemini.project`. Upstream Toonflow passes
 * these paths through raw, which produces literal `{{taskId}}` URLs; we resolve
 * them so async poll/create endpoints actually work.
 */
export declare function renderPath(path: string, ctx: TemplateContext): string;
export declare function generateMedia(providerId: string, request: MediaRequest, apiKey?: string): Promise<MediaAsset[]>;
//# sourceMappingURL=generate.d.ts.map