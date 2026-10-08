import type { ManifestProvider, MediaAsset, TemplateContext } from './types.js';
/** Read one or more dotted paths, returning the first non-empty hit. */
export declare function readPath(obj: unknown, paths: string | string[]): unknown;
/**
 * Last-resort location table: used only when the manifest declares nothing.
 * Asset shape stays { mediaType, type: "url" | "base64" | "binary", url | data | mimeType }.
 */
export declare const ASSET_URL_PATHS: string[];
export declare const ASSET_BASE64_PATHS: string[];
export declare const ASSET_MIME_PATHS: string[];
/** A descriptor may produce a URL string, a single object, or a provider array. */
export declare function normalizeAssets(mediaType: 'image' | 'video' | 'audio', value: unknown): MediaAsset[];
export declare function descriptorKeyFor(mediaType: 'image' | 'video' | 'audio'): 'images' | 'videos' | 'audios';
/**
 * Read a `response.*` field declared by a manifest. Manifests express these
 * fields either as dotted path strings or as template descriptors (`$coalesce`
 * / `$ref`), and a descriptor must go through `interpret` with the HTTP payload
 * bound to `response` — handing it to `readPath` crashes on `path.split`.
 */
export declare function readResponseField(field: unknown, payload: unknown, fallback: string[], ctx: TemplateContext): unknown;
/**
 * Extract media from a payload. Manifest-declared locations win: first the
 * `response.images|videos|audios` descriptor (same interpret path as taskId and
 * status), then the declared `response.resultPaths`. The hardcoded URL table is
 * only the last resort — it is what made providers whose media lives elsewhere
 * throw "No generation result returned" even after a successful poll.
 */
export declare function extractAssets(mediaType: 'image' | 'video' | 'audio', payload: unknown, provider: ManifestProvider, ctx: TemplateContext): MediaAsset[];
//# sourceMappingURL=assets.d.ts.map