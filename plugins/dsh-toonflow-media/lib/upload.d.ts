import type { ManifestProvider, ProviderContext, TemplateContext } from './types.js';
/**
 * `create.files` is a manifest-declared upload contract: `name` is the multipart
 * field name, `source` is a descriptor over `request.images|videos|audios`, and
 * `filename` is the part name upstream expects. Ignoring it and always sending a
 * JSON body makes every multipart provider reject the request.
 */
export interface CreateRequestSpec {
    path: string;
    contentType: string;
    multipart: boolean;
}
/**
 * Resolve the create endpoint and content type. Manifests may spell them as
 * static strings or as templates that depend on the request (openai-images
 * switches to `/v1/images/edits` + multipart only when `request.images` is
 * non-empty; ideogram/stability declare `pathTemplate` and no `path` at all).
 */
export declare function createRequestSpec(provider: ManifestProvider, ctx: TemplateContext): CreateRequestSpec;
/** Build the multipart body: manifest body scalars plus one part per resolved media item. */
export declare function buildMultipartBody(provider: ManifestProvider, body: unknown, ctx: TemplateContext, context: ProviderContext): Promise<FormData>;
//# sourceMappingURL=upload.d.ts.map