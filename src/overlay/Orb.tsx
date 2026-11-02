import { useEffect, useRef } from 'react';
import { isDark } from '../ui/theme';
import { createGlass, flatWave, paintInside, type Glass } from './glass';

// The orb, as TabTasker Business draws its own: a smoked disc under glass, with level bars that follow your
// voice while you talk, a text cursor while your words type, and the wave while what you said is
// transcribed. `words` are the live words while typing: they go into the field itself, never into the orb;
// here they only tell the cursor when to hold still (solid while words are going in, blinking once they stop).
export function Orb({ mode, level, typing, words, onClick }: { mode: string; level: { current: number }; typing: boolean; words: string; onClick: () => void }) {
  const host = useRef<HTMLSpanElement>(null);
  const glass = useRef<Glass | null>(null);
  const inside = useRef<HTMLCanvasElement | null>(null);
  const active = mode === 'listening' || mode === 'thinking';
  const thinking = useRef(false);
  thinking.current = mode === 'thinking';
  const caret = useRef(false);
  caret.current = typing;
  const heard = useRef('');
  heard.current = words;
  // One glass for every hold, freed only when the orb goes: losing a WebGL context is for good.
  useEffect(() => () => { glass.current?.dispose(); glass.current = null; }, []);
  useEffect(() => {
    const box = host.current;
    if (!active || !box) return;
    // Under reduced motion the bars still follow your voice and the wave still rises with it, but neither sways on its own.
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const styles = getComputedStyle(box);
    const colour = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    const accent = colour('--orb-wave', '#3b82f6');
    if (!glass.current) {
      const size = Math.ceil(box.clientWidth * Math.min(devicePixelRatio || 1, 2)) || 128;
      const surface = document.createElement('canvas');
      surface.width = surface.height = size;
      inside.current = document.createElement('canvas');
      inside.current.width = inside.current.height = size;
      try {
        glass.current = createGlass(surface, accent);
        surface.addEventListener('webglcontextlost', () => {
          const flat = document.createElement('canvas');
          flat.width = flat.height = size;
          glass.current = flatWave(flat, accent);
          box.replaceChildren(flat, inside.current!);
        }, { once: true });
      } catch { glass.current = flatWave(surface, accent); }
      box.replaceChildren(surface, inside.current);
    }
    let frame = 0, energy = .3, peak = .005;
    const started = performance.now();
    let said = heard.current, movedAt = started;
    const draw = (now: number) => {
      const background = isDark() ? [.09, .1, .11] : [.97, .97, .97]; // the theme can change mid-hold
      // Mic gain differs from Mac to Mac, so everything follows your voice against its own recent peak:
      // small in silence, full as you talk. Transcribing runs the wave at full strength.
      peak = Math.max(level.current, peak * .995, .005);
      const target = thinking.current ? 1 : .25 + .75 * Math.min(1, level.current / peak);
      energy += (target - energy) * (target > energy ? .35 : .1);
      const time = 1.9 + (now - started) * (still ? 0 : .0024);
      const kind = thinking.current ? null : caret.current ? 'caret' : 'bars';
      if (heard.current !== said) { said = heard.current; movedAt = now; }
      glass.current?.draw(time, background, energy, 4, kind ? 0 : 1);
      if (inside.current) paintInside(inside.current, kind, energy, time, now - movedAt, kind === 'caret' ? colour('--orb-ink', '#f4efe6') : colour('--orb-bars', accent));
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [active, level]);
  return <button type="button" className="orb" data-hit tabIndex={-1} aria-label={mode === 'thinking' ? 'Transcribing' : typing ? 'Typing' : 'Recording'} onClick={onClick}>
    <span ref={host} className="orb-glass" aria-hidden="true" />
  </button>;
}
