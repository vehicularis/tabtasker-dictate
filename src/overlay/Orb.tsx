import { useEffect, useRef } from 'react';

// The orb: level bars while a note records, a still caret while typing.
export function Orb({ mode, level, typing, onClick }: { mode: string; level: { current: number }; typing: boolean; onClick: () => void }) {
  const bars = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (mode !== 'listening' || typing) return;
    let frame = 0, peak = 0.005, energy = 0.2;
    // Under reduced motion the bars still follow your voice, but stop swaying on their own.
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const draw = (now: number) => {
      peak = Math.max(level.current, peak * 0.995, 0.005);
      const target = 0.15 + 0.85 * Math.min(1, level.current / peak);
      energy += (target - energy) * (target > energy ? 0.35 : 0.1);
      bars.current?.querySelectorAll('i').forEach((bar, i) => {
        const sway = 0.5 + 0.5 * Math.sin((still ? 0 : now / 140) + i * 1.7);
        (bar as HTMLElement).style.transform = `scaleY(${0.2 + 0.8 * energy * (0.35 + 0.65 * sway)})`;
      });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [mode, typing, level]);
  return <button type="button" className="orb" data-hit tabIndex={-1} aria-label={typing ? 'Typing' : 'Recording'} onClick={onClick}>
    {typing ? <span className="caret" /> : <span className="bars" ref={bars}><i /><i /><i /><i /><i /></span>}
  </button>;
}
