import { describe, it, expect } from 'vitest';
import { listProviders, renderPath } from '../src/generate.js';
import { interpret } from '../src/template.js';
import { loadManifests } from '../src/manifest-loader.js';

describe('listProviders', () => {
  it('returns all 86 providers across 85 manifests', () => {
    const providers = listProviders();
    expect(providers.length).toBe(86);
  });
  it('includes multi-provider manifests such as autodl-comfyui-audio', () => {
    const ids = listProviders().map((p) => p.id);
    expect(ids).toContain('autodl-comfyui');
    expect(ids).toContain('autodl-comfyui-audio');
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('has id, label, capabilities for each', () => {
    const p = listProviders()[0];
    expect(p.id).toBeTruthy();
    expect(p.label).toBeTruthy();
    expect(Array.isArray(p.capabilities)).toBe(true);
  });
});

describe('interpret', () => {
  const ctx = { request: { model: 'test', prompt: 'hello', imageCount: 2, images: [{ role: 'image', order: 1 }, { role: 'mask', order: 2 }] }, response: {} };
  it('resolves $ref', () => {
    expect(interpret({ $ref: 'request.model' }, ctx as any)).toBe('test');
  });
  it('resolves $omitEmpty', () => {
    expect(interpret({ $omitEmpty: { $ref: 'request.prompt' } }, ctx as any)).toBe('hello');
    expect(interpret({ $omitEmpty: { $ref: 'request.missing' } }, ctx as any)).toBeNull();
  });
  it('resolves $coalesce', () => {
    expect(interpret({ $coalesce: [{ $ref: 'request.missing' }, 'fallback'] }, ctx as any)).toBe('fallback');
  });
  it('resolves $eq', () => {
    expect(interpret({ $eq: [{ $ref: 'request.model' }, 'test'] }, ctx as any)).toBe(true);
  });
  it('resolves $gt', () => {
    expect(interpret({ $gt: [{ $ref: 'request.imageCount' }, 1] }, ctx as any)).toBe(true);
  });
  it('resolves $lower', () => {
    expect(interpret({ $lower: { $ref: 'request.model' } }, ctx as any)).toBe('test');
  });
  it('resolves $concat', () => {
    expect(interpret({ $concat: ['pre-', { $ref: 'request.model' }] }, ctx as any)).toBe('pre-test');
  });
  it('resolves $map', () => {
    const result = interpret({ $map: { from: { $ref: 'request.images' }, as: 'item', in: { role: { $ref: 'item.role' } } } }, ctx as any);
    expect(result).toEqual([{ role: 'image' }, { role: 'mask' }]);
  });
  it('resolves $filter', () => {
    const result = interpret({ $filter: { from: { $ref: 'request.images' }, as: 'media', where: { $ne: [{ $ref: 'media.role' }, 'mask'] } } }, ctx as any);
    expect(result).toHaveLength(1);
    expect((result[0] as any).role).toBe('image');
  });
  it('resolves $switch', () => {
    expect(interpret({ $switch: { cases: [{ when: { $eq: [{ $ref: 'request.model' }, 'test'] }, then: 'matched' }], default: 'default' } }, ctx as any)).toBe('matched');
  });
  it('resolves $first', () => {
    expect(interpret({ $first: { $ref: 'request.images' } }, ctx as any)).toEqual({ role: 'image', order: 1 });
  });
  it('resolves $sortByOrder', () => {
    const result = interpret({ $sortByOrder: { $ref: 'request.images' } }, ctx as any);
    expect((result[0] as any).order).toBe(1);
    expect((result[1] as any).order).toBe(2);
  });
});

describe('loadManifests', () => {
  it('loads 85 manifests', () => {
    const manifests = loadManifests();
    expect(manifests.length).toBe(85);
  });
});

describe('manifest corpus', () => {
  it('interprets every manifest create body and file source without throwing', () => {
    const ctx = {
      request: {
        model: 'test-model', prompt: 'a cat', text: 'hello',
        images: [{ role: 'image', order: 1, url: 'https://x/1.png' }, { role: 'mask', order: 2, url: 'https://x/2.png' }],
        videos: [{ role: 'video', order: 1, url: 'https://x/v.mp4' }], audios: [],
        duration: 5, ratio: '16:9', resolution: '1080p', size: '1024x1024', quality: 'high',
        imageCount: 2, generateAudio: true, watermark: false, voice: 'alloy',
        speed: 1, volume: 1, pitch: 0, language: 'zh', format: 'mp3',
        sampleRate: 24000, bitrateKbps: 128,
        firstFrame: { url: 'https://x/f.png' }, lastFrame: { url: 'https://x/l.png' },
      },
      response: {},
    };
    const failures: string[] = [];
    let providers = 0;
    for (const m of loadManifests()) {
      for (const p of m.contributes.providers) {
        providers++;
        try {
          if (p.create?.body !== undefined) interpret(p.create.body as any, ctx as any);
          for (const f of p.create?.files ?? []) {
            if (f.source !== undefined) interpret(f.source as any, ctx as any);
          }
        } catch (e) {
          failures.push(`${m.id}/${p.id}: ${(e as Error).message}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(providers).toBe(86);
  });
});

describe('renderPath', () => {
  const ctx = {
    request: { model: 'veo-3', providerOptions: { 'vertex-gemini': { project: 'proj-1', location: 'us-central1' } } },
    response: {},
    model: 'veo-3',
  };

  it('leaves a placeholder-free path untouched', () => {
    expect(renderPath('/v1/chat/completions', ctx as any)).toBe('/v1/chat/completions');
  });

  it('resolves {{model}}', () => {
    expect(renderPath('/v1/{{model}}', ctx as any)).toBe('/v1/veo-3');
  });

  it('resolves {{taskId}}', () => {
    expect(renderPath('/v1/videos/{{taskId}}', { ...ctx, taskId: 'abc123' } as any)).toBe('/v1/videos/abc123');
  });

  it('resolves a dotted nested path with a hyphenated key', () => {
    expect(
      renderPath('/v1/projects/{{request.providerOptions.vertex-gemini.project}}/locations/{{request.providerOptions.vertex-gemini.location}}/x', ctx as any),
    ).toBe('/v1/projects/proj-1/locations/us-central1/x');
  });

  it('resolves Gemini-style mixed segments', () => {
    expect(renderPath('/v1beta/models/{{model}}:generateContent', ctx as any)).toBe('/v1beta/models/veo-3:generateContent');
  });

  it('renders an unresolved placeholder as empty rather than literal braces', () => {
    expect(renderPath('/v1/{{request.missing}}/x', ctx as any)).toBe('/v1//x');
  });

  it('resolves every {{...}} path in the shipped manifests', () => {
    const unresolved: string[] = [];
    for (const m of loadManifests()) {
      for (const p of m.contributes.providers) {
        const paths = [p.create?.path, p.poll?.path, p.cancel?.path, p.result?.path];
        for (const raw of paths) {
          if (typeof raw !== 'string' || !raw.includes('{{')) continue;
          const rendered = renderPath(raw, { ...ctx, taskId: 'T' } as any);
          if (rendered.includes('{{')) unresolved.push(`${m.id}/${p.id} ${raw} -> ${rendered}`);
        }
      }
    }
    expect(unresolved).toEqual([]);
  });
});
