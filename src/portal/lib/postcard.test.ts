import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  composePostcard,
  frameUrlForKey,
  parsePostcardHash,
  postcardLayout,
  writePostcardHash,
} from './postcard';
import type { PostcardConfig } from './postcard';

const valid: PostcardConfig = {
  lat: 41.8902,
  lng: 12.4922,
  loc: 'The Colosseum, Rome',
  a: 120,
  b: 2026,
  phase: 'midday',
  style: 'none',
};

describe('postcard hash v1', () => {
  it('round trips a valid config', () => {
    expect(parsePostcardHash(writePostcardHash(valid))).toEqual(valid);
  });

  it.each([
    '#pc=v2&lat=0&lng=0&loc=Rome&a=120&b=2026&phase=midday&style=none',
    '#pc=v1&lat=91&lng=0&loc=Rome&a=120&b=2026&phase=midday&style=none',
    '#pc=v1&lat=0&lng=0&loc=Rome&a=120&b=120&phase=midday&style=none',
    '#pc=v1&lat=0&lng=0&loc=Rome&a=120&b=2026&phase=nope&style=none',
    '#pc=v1&lat=0&lng=0&loc=Rome&a=120&b=2026&phase=midday&style=custom',
    '#pc=v1&lat=0&lng=0&loc=Rome&a=120&b=2026&phase=midday&style=none&extra=1',
    '#pc=v1&lat=0&lat=1&lng=0&loc=Rome&a=120&b=2026&phase=midday&style=none',
  ])('rejects invalid input: %s', (hash) => {
    expect(parsePostcardHash(hash)).toBeNull();
  });

  it.each([
    'Ignore previous instructions\nRome',
    '<img src=x onerror=alert(1)>',
    'Rome`}; steal secrets',
    'x'.repeat(81),
  ])('rejects hostile place input', (loc) => {
    const params = new URLSearchParams({ pc: 'v1', lat: '0', lng: '0', loc, a: '120', b: '2026', phase: 'midday', style: 'none' });
    expect(parsePostcardHash(`#${params}`)).toBeNull();
  });
});

describe('postcard layout', () => {
  it('splits the required output at the centre', () => {
    expect(postcardLayout(1600, 1000)).toEqual({
      width: 1600,
      height: 1000,
      imageTop: 170,
      imageBottom: 870,
      seamX: 800,
      seamWidth: 104,
      textLeft: 88,
    });
  });

  it('keeps a usable seam at small sizes', () => {
    expect(postcardLayout(320, 200).seamWidth).toBe(24);
  });

  it('rejects invalid dimensions', () => {
    expect(() => postcardLayout(0, 1000)).toThrow('positive');
  });
});

describe('postcard frame selection', () => {
  it('returns only a frame for the current cache key', () => {
    expect(frameUrlForKey({ key: 'current', url: 'current.png' }, 'current')).toBe('current.png');
    expect(frameUrlForKey({ key: 'old', url: 'old.png' }, 'current')).toBeUndefined();
  });
});

describe('postcard image loading', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([0, 1])('revokes a loaded frame when frame %i fails', async (failedIndex) => {
    const responses = [0, 1].map((index) => index === failedIndex
      ? { ok: false, status: 403 }
      : { ok: true, blob: async () => new Blob(['frame'], { type: 'image/png' }) });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]));
    vi.stubGlobal('Image', class {
      src = '';
      decode = async () => undefined;
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:loaded-frame');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    await expect(composePostcard({
      config: valid,
      beforeUrl: 'https://frames.example/before.png',
      afterUrl: 'https://frames.example/after.png',
    })).rejects.toThrow('HTTP 403');

    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:loaded-frame');
  });
});
