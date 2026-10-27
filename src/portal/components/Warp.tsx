import { useEffect, useRef } from 'react';
import type { JumpCharacter } from '../lib/pin';
import { createWarpRenderer } from '../lib/warpRenderer';

interface Props {
  jump: JumpCharacter;
}

/** Live wrapper for the shared warp renderer. */
export function Warp({ jump }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const jumpRef = useRef(jump);

  useEffect(() => {
    jumpRef.current = jump;
  }, [jump]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createWarpRenderer(canvas);
    if (!renderer) return;
    canvas.dataset.live = 'true';

    const resize = () => renderer.resize(canvas.clientWidth * 0.55, canvas.clientHeight * 0.55);
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      renderer.render((now - started) / 1000, jumpRef.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      delete canvas.dataset.live;
      renderer.dispose();
    };
  }, []);

  return <canvas className="warp-gl" ref={canvasRef} aria-hidden="true" />;
}
