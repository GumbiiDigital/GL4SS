import { MAX_YEAR, MIN_YEAR, formatYear } from '../../lib/format';
import { STYLE_PRESETS, findStyle } from '../../lib/styles';
import { DAY_PHASES, findPhase } from './daylight';
import { createWarpRenderer } from './warpRenderer';

export interface PostcardConfig {
  lat: number;
  lng: number;
  loc: string;
  a: number;
  b: number;
  phase: string;
  style: string;
}

export interface KeyedFrameUrl {
  key: string;
  url: string;
}

export function frameUrlForKey(frame: KeyedFrameUrl | undefined, key: string): string | undefined {
  return frame?.key === key ? frame.url : undefined;
}

export interface PostcardLayout {
  width: number;
  height: number;
  imageTop: number;
  imageBottom: number;
  seamX: number;
  seamWidth: number;
  textLeft: number;
}

const HASH_KEYS = ['pc', 'lat', 'lng', 'loc', 'a', 'b', 'phase', 'style'] as const;
const STYLES = new Set(STYLE_PRESETS.filter((style) => !style.isCustom).map((style) => style.id));
const PHASES = new Set(DAY_PHASES.map((phase) => phase.id));

function strictNumber(value: string | null, min: number, max: number, integer = false): number | null {
  if (value === null || value === '' || value.trim() !== value) return null;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  if (integer && !Number.isInteger(parsed)) return null;
  return parsed;
}

function validLocation(value: string | null): value is string {
  if (!value || value !== value.trim() || value.length > 80) return false;
  // These characters can turn a place label into markup, a prompt, or a payload.
  if (/[<>"'`{}]/u.test(value)) return false;
  return [...value].every((character) => {
    const code = character.codePointAt(0)!;
    return code > 31 && !(code >= 127 && code <= 159);
  });
}

/** Parse only the complete v1 postcard schema. Any extra or duplicate field fails. */
export function parsePostcardHash(hash: string): PostcardConfig | null {
  if (!hash.startsWith('#')) return null;
  const params = new URLSearchParams(hash.slice(1));
  const entries = [...params.keys()];
  if (entries.length !== HASH_KEYS.length) return null;
  if (entries.some((key) => !HASH_KEYS.includes(key as (typeof HASH_KEYS)[number]))) return null;
  if (HASH_KEYS.some((key) => params.getAll(key).length !== 1)) return null;
  if (params.get('pc') !== 'v1') return null;

  const lat = strictNumber(params.get('lat'), -90, 90);
  const lng = strictNumber(params.get('lng'), -180, 180);
  const a = strictNumber(params.get('a'), MIN_YEAR, MAX_YEAR, true);
  const b = strictNumber(params.get('b'), MIN_YEAR, MAX_YEAR, true);
  const loc = params.get('loc');
  const phase = params.get('phase');
  const style = params.get('style');
  if (lat === null || lng === null || a === null || b === null || a === b) return null;
  if (!validLocation(loc) || !phase || !PHASES.has(phase) || !style || !STYLES.has(style)) return null;
  return { lat, lng, loc, a, b, phase, style };
}

/** Write the exact v1 schema. Validation is shared with the parser. */
export function writePostcardHash(config: PostcardConfig): string {
  const params = new URLSearchParams({
    pc: 'v1',
    lat: String(config.lat),
    lng: String(config.lng),
    loc: config.loc,
    a: String(config.a),
    b: String(config.b),
    phase: config.phase,
    style: config.style,
  });
  const hash = `#${params.toString()}`;
  if (!parsePostcardHash(hash)) throw new Error('Invalid postcard configuration');
  return hash;
}

/** Pure output geometry. Kept separate so edge sizes can be tested. */
export function postcardLayout(width: number, height: number): PostcardLayout {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Postcard dimensions must be positive');
  }
  const imageTop = Math.round(height * 0.17);
  const imageBottom = Math.round(height * 0.87);
  return {
    width,
    height,
    imageTop,
    imageBottom,
    seamX: Math.round(width / 2),
    seamWidth: Math.max(24, Math.round(width * 0.065)),
    textLeft: Math.round(width * 0.055),
  };
}

interface LoadedImage {
  image: HTMLImageElement;
  dispose: () => void;
}

async function loadSafeImage(url: string): Promise<LoadedImage> {
  let objectUrl = '';
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw new Error('The frame is not an image');
    objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    return { image, dispose: () => URL.revokeObjectURL(objectUrl) };
  } catch (error) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    const detail = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`A frame cannot be exported safely. Its host blocked image access (${detail}).`);
  }
}

function drawCover(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = (image.naturalWidth - sourceWidth) / 2;
  const sourceY = (image.naturalHeight - sourceHeight) / 2;
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

export interface ComposePostcardInput {
  config: PostcardConfig;
  beforeUrl: string;
  afterUrl: string;
}

/** Build the deterministic 1600 x 1000 PNG source canvas. */
export async function composePostcard(input: ComposePostcardInput): Promise<HTMLCanvasElement> {
  const [beforeResult, afterResult] = await Promise.allSettled([
    loadSafeImage(input.beforeUrl),
    loadSafeImage(input.afterUrl),
  ]);
  if (beforeResult.status === 'rejected') {
    if (afterResult.status === 'fulfilled') afterResult.value.dispose();
    throw beforeResult.reason;
  }
  if (afterResult.status === 'rejected') {
    beforeResult.value.dispose();
    throw afterResult.reason;
  }
  const before = beforeResult.value;
  const after = afterResult.value;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 1000;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is not available');
    const layout = postcardLayout(canvas.width, canvas.height);

    context.fillStyle = '#07090e';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const imageHeight = layout.imageBottom - layout.imageTop;
    drawCover(context, before.image, 0, layout.imageTop, layout.seamX, imageHeight);
    drawCover(context, after.image, layout.seamX, layout.imageTop, layout.width - layout.seamX, imageHeight);

    const seam = document.createElement('canvas');
    const renderer = createWarpRenderer(seam);
    if (renderer) {
      renderer.resize(layout.seamWidth * 2, imageHeight);
      renderer.render(2.75, { direction: input.config.a < input.config.b ? 'forward' : 'back', reach: 'far', distance: Math.abs(input.config.b - input.config.a) });
      context.drawImage(seam, layout.seamX - layout.seamWidth, layout.imageTop, layout.seamWidth * 2, imageHeight);
      renderer.dispose();
    } else {
      const glow = context.createLinearGradient(layout.seamX - layout.seamWidth, 0, layout.seamX + layout.seamWidth, 0);
      glow.addColorStop(0, 'rgba(30,120,255,0)');
      glow.addColorStop(0.5, 'rgba(160,240,255,0.9)');
      glow.addColorStop(1, 'rgba(30,120,255,0)');
      context.fillStyle = glow;
      context.fillRect(layout.seamX - layout.seamWidth, layout.imageTop, layout.seamWidth * 2, imageHeight);
    }

    context.fillStyle = '#f4f1e8';
    context.font = '700 50px system-ui, sans-serif';
    context.fillText(input.config.loc, layout.textLeft, 74, 1180);
    context.fillStyle = '#aeb8c8';
    context.font = '500 24px ui-monospace, monospace';
    context.fillText(`${findPhase(input.config.phase).label.toUpperCase()} · ${findStyle(input.config.style).label.toUpperCase()}`, layout.textLeft, 118);

    context.fillStyle = 'rgba(4,6,10,0.78)';
    context.fillRect(0, layout.imageBottom, canvas.width, canvas.height - layout.imageBottom);
    context.fillStyle = '#f4f1e8';
    context.font = '700 42px system-ui, sans-serif';
    context.textAlign = 'left';
    context.fillText(formatYear(input.config.a), layout.textLeft, 944);
    context.textAlign = 'right';
    context.fillText(formatYear(input.config.b), canvas.width - layout.textLeft, 944);
    context.textAlign = 'center';
    context.fillStyle = '#9ce8ff';
    context.font = '700 22px ui-monospace, monospace';
    context.fillText('GL4SS', layout.seamX, 944);
    context.textAlign = 'left';
    return canvas;
  } finally {
    before.dispose();
    after.dispose();
  }
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('The browser could not create the PNG.'));
      }, 'image/png');
    } catch {
      reject(new Error('The frame host blocked PNG export. No unsafe canvas was downloaded.'));
    }
  });
}

export function downloadPng(blob: Blob, filename = 'gl4ss-time-postcard.png'): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function sharePng(blob: Blob, title: string): Promise<boolean> {
  if (!navigator.share) return false;
  const file = new File([blob], 'gl4ss-time-postcard.png', { type: 'image/png' });
  if (navigator.canShare && !navigator.canShare({ files: [file] })) return false;
  await navigator.share({ title, files: [file] });
  return true;
}
