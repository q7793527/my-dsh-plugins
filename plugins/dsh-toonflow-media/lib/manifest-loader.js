import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
export function loadManifests() {
    const dir = join(__dirname, '..', 'manifests');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    return files.map((f) => {
        const raw = readFileSync(join(dir, f), 'utf8');
        return JSON.parse(raw);
    });
}
export function loadProviders() {
    return loadManifests().flatMap((manifest) => {
        const providers = manifest.contributes.providers ?? [];
        if (providers.length === 0)
            throw new Error(`Manifest ${manifest.id} has no provider`);
        return providers.map((provider) => ({ manifest, provider }));
    });
}
//# sourceMappingURL=manifest-loader.js.map