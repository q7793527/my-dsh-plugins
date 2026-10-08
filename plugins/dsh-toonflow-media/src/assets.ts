import type { ManifestProvider, MediaAsset, TemplateContext, TemplateNode } from "./types.js";
import { interpret } from "./template.js";

/** Read one or more dotted paths, returning the first non-empty hit. */
export function readPath(obj: unknown, paths: string | string[]): unknown {
  if (obj == null) return undefined;
  const candidates = Array.isArray(paths) ? paths : [paths];
  for (const path of candidates) {
    let value: unknown = obj;
    for (const part of path.split(".")) {
      if (value == null) break;
      value = (value as Record<string, unknown>)[part];
    }
    if (value != null && value !== "") return value;
  }
  return undefined;
}

/**
 * Last-resort location table: used only when the manifest declares nothing.
 * Asset shape stays { mediaType, type: "url" | "base64" | "binary", url | data | mimeType }.
 */
export const ASSET_URL_PATHS = [
  "url",
  "dataUrl",
  "data.url",
  "result.url",
  "output.url",
  "image_url.url",
  "image_url",
  "imageUrl",
  "image",
  "video_url",
  "videoUrl",
  "result_url",
  "audio_url",
  "audioUrl",
];
export const ASSET_BASE64_PATHS = ["b64_json", "data.b64_json", "inlineData.data", "inline_data.data"];
export const ASSET_MIME_PATHS = ["inlineData.mimeType", "inline_data.mime_type", "mimeType", "mime_type"];

function toMediaAsset(mediaType: "image" | "video" | "audio", value: unknown): MediaAsset | undefined {
  if (typeof value === "string" && value) return { mediaType, type: "url", url: value };
  if (!value || typeof value !== "object") return undefined;
  const url = readPath(value, ASSET_URL_PATHS);
  if (typeof url === "string" && url) return { mediaType, type: "url", url };
  const data = readPath(value, ASSET_BASE64_PATHS);
  if (typeof data === "string" && data) {
    const mimeType = readPath(value, ASSET_MIME_PATHS);
    return { mediaType, type: "base64", data, mimeType: typeof mimeType === "string" ? mimeType : undefined };
  }
  return undefined;
}

/** A descriptor may produce a URL string, a single object, or a provider array. */
export function normalizeAssets(mediaType: "image" | "video" | "audio", value: unknown): MediaAsset[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    const assets: MediaAsset[] = [];
    for (const item of value) assets.push(...normalizeAssets(mediaType, item));
    return assets;
  }
  const asset = toMediaAsset(mediaType, value);
  return asset ? [asset] : [];
}

export function descriptorKeyFor(mediaType: "image" | "video" | "audio"): "images" | "videos" | "audios" {
  return mediaType === "video" ? "videos" : mediaType === "audio" ? "audios" : "images";
}

/**
 * Read a `response.*` field declared by a manifest. Manifests express these
 * fields either as dotted path strings or as template descriptors (`$coalesce`
 * / `$ref`), and a descriptor must go through `interpret` with the HTTP payload
 * bound to `response` — handing it to `readPath` crashes on `path.split`.
 */
export function readResponseField(
  field: unknown,
  payload: unknown,
  fallback: string[],
  ctx: TemplateContext,
): unknown {
  if (typeof field === "string" || Array.isArray(field)) {
    return readPath(payload, field as string | string[]);
  }
  if (field && typeof field === "object") {
    return interpret(field as TemplateNode, { ...ctx, response: payload });
  }
  return readPath(payload, fallback);
}

/**
 * Extract media from a payload. Manifest-declared locations win: first the
 * `response.images|videos|audios` descriptor (same interpret path as taskId and
 * status), then the declared `response.resultPaths`. The hardcoded URL table is
 * only the last resort — it is what made providers whose media lives elsewhere
 * throw "No generation result returned" even after a successful poll.
 */
export function extractAssets(
  mediaType: "image" | "video" | "audio",
  payload: unknown,
  provider: ManifestProvider,
  ctx: TemplateContext,
): MediaAsset[] {
  const response = provider.response;
  const key = descriptorKeyFor(mediaType);
  const declared = readResponseField(
    response?.[key] ?? (mediaType === "audio" ? response?.audio : undefined),
    payload,
    [],
    ctx,
  );
  const assets = normalizeAssets(mediaType, declared);
  if (assets.length > 0) return assets;
  if (response?.resultPaths && response.resultPaths.length > 0) {
    const viaResultPaths = normalizeAssets(mediaType, readPath(payload, response.resultPaths));
    if (viaResultPaths.length > 0) return viaResultPaths;
  }
  return normalizeAssets(mediaType, payload);
}
