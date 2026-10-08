import { interpret } from "./template.js";
import { ASSET_BASE64_PATHS, ASSET_MIME_PATHS, ASSET_URL_PATHS, readPath } from "./assets.js";
/**
 * Resolve the create endpoint and content type. Manifests may spell them as
 * static strings or as templates that depend on the request (openai-images
 * switches to `/v1/images/edits` + multipart only when `request.images` is
 * non-empty; ideogram/stability declare `pathTemplate` and no `path` at all).
 */
export function createRequestSpec(provider, ctx) {
    const create = provider.create;
    const path = String(interpret(create.pathTemplate ?? create.path ?? "", ctx) ?? create.path ?? "");
    const contentType = String(interpret(create.contentTypeTemplate ?? create.contentType ?? "", ctx) ?? create.contentType ?? "");
    const declaredFiles = create.files ?? [];
    return {
        path,
        contentType,
        multipart: declaredFiles.length > 0 && contentType.includes("multipart"),
    };
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function appendScalar(form, key, value) {
    if (value == null)
        return;
    if (typeof value === "string")
        form.append(key, value);
    else if (typeof value === "number" || typeof value === "boolean")
        form.append(key, String(value));
    else
        form.append(key, JSON.stringify(value));
}
function resolveItems(source, ctx) {
    if (source == null)
        return [];
    const value = interpret(source, ctx);
    if (value == null)
        return [];
    return Array.isArray(value) ? value.filter((x) => x != null) : [value];
}
function decodeBase64(payload) {
    // BlobPart 只接受挂在 ArrayBuffer 上的视图，Buffer 的 ArrayBufferLike 不够窄。
    return new Uint8Array(Buffer.from(payload, "base64"));
}
/** A media item is either a data: URL, a remote URL, or an object carrying one of them. */
function mediaSource(item) {
    if (typeof item === "string" && item)
        return { source: item };
    const url = readPath(item, ASSET_URL_PATHS);
    if (typeof url === "string" && url)
        return { source: url };
    const base64 = readPath(item, ASSET_BASE64_PATHS);
    if (typeof base64 === "string" && base64) {
        const mimeType = readPath(item, ASSET_MIME_PATHS);
        return { base64, mimeType: typeof mimeType === "string" ? mimeType : undefined };
    }
    return undefined;
}
async function downloadMedia(url, context) {
    // 媒体 URL 由调用方提供（manifest 里 requiresPublicMediaUrls 也是这个语义）：
    // 不把 provider 的 API key 发给第三方主机。
    const response = await context.tool.fetch(url, { method: "GET", signal: context.signal });
    if (!response.ok)
        throw new Error(`Upload source fetch failed: HTTP ${response.status} ${url}`);
    return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type") ?? "application/octet-stream",
    };
}
function dataUrlPart(item) {
    const mime = interpret({ $dataMime: item }, {});
    const payload = interpret({ $dataPayload: item }, {});
    if (typeof mime !== "string" || typeof payload !== "string" || !payload)
        return undefined;
    return { blob: new Blob([decodeBase64(payload)], { type: mime }) };
}
async function toFilePart(item, filename, context) {
    if (item == null)
        return undefined;
    if (typeof item === "string" && item.startsWith("data:"))
        return dataUrlPart(item);
    const media = mediaSource(item);
    if (!media)
        return undefined;
    if ("base64" in media) {
        return { blob: new Blob([decodeBase64(media.base64)], { type: media.mimeType ?? "application/octet-stream" }), filename };
    }
    // data: URL 的字节就在字符串里（媒体项常以 {url:"data:..."} 形状传进来）：
    // 把它当远程地址去 fetch 会把响应 JSON 当成文件内容上传。
    if (media.source.startsWith("data:")) {
        const inline = dataUrlPart(media.source);
        return inline ? { blob: inline.blob, filename } : undefined;
    }
    const downloaded = await downloadMedia(media.source, context);
    return { blob: new Blob([downloaded.bytes], { type: downloaded.mimeType }), filename };
}
/** Build the multipart body: manifest body scalars plus one part per resolved media item. */
export async function buildMultipartBody(provider, body, ctx, context) {
    const form = new FormData();
    for (const [key, value] of Object.entries(asRecord(body)))
        appendScalar(form, key, value);
    for (const file of provider.create.files ?? []) {
        for (const item of resolveItems(file.source, ctx)) {
            const part = await toFilePart(item, file.filename, context);
            if (!part)
                continue;
            if (part.filename)
                form.append(file.name, part.blob, part.filename);
            else
                form.append(file.name, part.blob);
        }
    }
    return form;
}
//# sourceMappingURL=upload.js.map