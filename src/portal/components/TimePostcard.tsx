import { useEffect, useMemo, useState } from 'react';
import { formatYear } from '../../lib/format';
import { getFrame } from '../lib/frameStore';
import { sceneKey } from '../lib/engine';
import {
  canvasToPng,
  composePostcard,
  downloadPng,
  frameUrlForKey,
  sharePng,
  writePostcardHash,
} from '../lib/postcard';
import type { KeyedFrameUrl, PostcardConfig } from '../lib/postcard';

type FrameSlot = 'a' | 'b';

type FrameUrls = Partial<Record<FrameSlot, KeyedFrameUrl>>;

interface Props {
  config: PostcardConfig;
  dialYear: number;
  liveUrls: FrameUrls;
  onChange: (config: PostcardConfig) => void;
  onGenerate: (year: number) => void;
  onClose: () => void;
}

export function TimePostcard({ config, dialYear, liveUrls, onChange, onGenerate, onClose }: Props) {
  const [storedFrames, setStoredFrames] = useState<FrameUrls>({});
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const keys = useMemo(() => ({
    a: sceneKey({ year: config.a, coordinates: config, location: config.loc, styleId: config.style, phaseId: config.phase }),
    b: sceneKey({ year: config.b, coordinates: config, location: config.loc, styleId: config.style, phaseId: config.phase }),
  }), [config]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getFrame(keys.a), getFrame(keys.b)]).then(([a, b]) => {
      if (!cancelled) {
        setStoredFrames({
          a: a ? { key: a.key, url: a.heroUrl } : undefined,
          b: b ? { key: b.key, url: b.heroUrl } : undefined,
        });
      }
    });
    return () => { cancelled = true; };
  }, [keys.a, keys.b]);

  const urls = {
    a: frameUrlForKey(liveUrls.a, keys.a) ?? frameUrlForKey(storedFrames.a, keys.a),
    b: frameUrlForKey(liveUrls.b, keys.b) ?? frameUrlForKey(storedFrames.b, keys.b),
  };
  const ready = Boolean(urls.a && urls.b);

  const makePng = async (): Promise<Blob> => {
    if (!urls.a || !urls.b) throw new Error('Generate both frames before export.');
    const canvas = await composePostcard({ config, beforeUrl: urls.a, afterUrl: urls.b });
    return canvasToPng(canvas);
  };

  const run = async (action: 'download' | 'share') => {
    setWorking(true);
    setNotice('');
    try {
      const blob = await makePng();
      if (action === 'download') {
        downloadPng(blob);
        setNotice('PNG downloaded.');
      } else if (await sharePng(blob, `${config.loc}: ${formatYear(config.a)} to ${formatYear(config.b)}`)) {
        setNotice('Share sheet opened.');
      } else {
        setNotice('File sharing is not available in this browser.');
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The postcard could not be exported.');
    } finally {
      setWorking(false);
    }
  };

  const copyLink = async () => {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = writePostcardHash(config);
    window.history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url.toString());
      setNotice('Link copied.');
    } catch {
      setNotice('Clipboard access failed. Copy the address bar URL.');
    }
  };

  return (
    <section className="postcard-panel" role="dialog" aria-modal="false" aria-label="Time postcard">
      <div className="postcard-head">
        <div>
          <span className="postcard-kicker">TIME POSTCARD</span>
          <strong>{config.loc}</strong>
        </div>
        <button className="ghost-btn" onClick={onClose} aria-label="Close postcard">close</button>
      </div>

      <div className="postcard-picker" aria-label="Postcard times">
        {(['a', 'b'] as const).map((slot) => (
          <div className="postcard-time" key={slot}>
            <span>{slot.toUpperCase()}</span>
            <strong>{formatYear(config[slot])}</strong>
            <button
              className="ghost-btn"
              onClick={() => onChange({ ...config, [slot]: dialYear })}
              disabled={config[slot === 'a' ? 'b' : 'a'] === dialYear}
            >
              use dial
            </button>
          </div>
        ))}
      </div>

      <div className="postcard-preview" aria-label="Live postcard preview">
        {(['a', 'b'] as const).map((slot) => (
          <div className="postcard-preview-frame" key={slot}>
            {urls[slot] ? (
              <img src={urls[slot]} alt={`${config.loc} in ${formatYear(config[slot])}`} />
            ) : (
              <div className="postcard-missing">
                <span>{formatYear(config[slot])}</span>
                <button className="solid-btn" onClick={() => onGenerate(config[slot])}>Generate</button>
              </div>
            )}
          </div>
        ))}
        <span className="postcard-preview-seam" aria-hidden="true" />
        <span className="postcard-preview-mark" aria-hidden="true">GL4SS</span>
      </div>

      <div className="postcard-actions">
        <button className="solid-btn" disabled={!ready || working} onClick={() => void run('download')}>
          {working ? 'working…' : 'Download PNG'}
        </button>
        <button className="ghost-btn" onClick={() => void copyLink()}>Copy link</button>
        {typeof navigator.share === 'function' && (
          <button className="ghost-btn" disabled={!ready || working} onClick={() => void run('share')}>Share</button>
        )}
      </div>
      {notice && <p className="postcard-notice" role="status">{notice}</p>}
    </section>
  );
}
