import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { chordOf, chordProblem, glyphs, held } from '../lib/chords';
import type { Chord } from '../api/types';
import { Icon } from './Icon';

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="ui-kbd">{children}</kbd>;

/// Records a global shortcut: click, then press it. Escape cancels; Delete clears it. A chord `taken`
/// holds already, or one the store keeps the old value over, is refused with the reason beside it.
/// `onChange` answers the chord as saved, when it knows it.
export function KeyRecorder({ value, onChange, label, taken = [] }: {
  value: Chord | null; label: string; taken?: { name: string; chord: Chord | null }[];
  onChange: (chord: Chord | null) => void | Promise<Chord | null | undefined>;
}) {
  const [recording, setRecording] = useState(false);
  const [partial, setPartial] = useState('');
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => { if (!refused) return; const timer = setTimeout(() => setRefused(null), 6000); return () => clearTimeout(timer); }, [refused]);
  const stop = () => { setRecording(false); setPartial(''); };
  const save = (chord: Chord | null) => {
    const problem = chord && chordProblem(chord, taken);
    if (problem) { setRefused(problem); return; }
    setRefused(null);
    void Promise.resolve(onChange(chord)).then(saved => {
      if (chord && saved !== undefined && (saved?.keyCode !== chord.keyCode || saved.modifiers !== chord.modifiers)) setRefused(`${chord.label} can’t be used here`);
    });
  };
  const key = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) {
      if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); if (value) save(null); }
      return;
    }
    event.preventDefault(); event.stopPropagation();
    const on = held(event);
    const bare = !on.command && !on.option && !on.control && !on.shift;
    if (event.key === 'Escape' && bare) { stop(); return; }
    if ((event.key === 'Backspace' || event.key === 'Delete') && bare) { save(null); stop(); return; }
    const chord = chordOf(event);
    if (chord) { save(chord); stop(); return; }
    setPartial(glyphs(on));
  };
  const clearable = value && !recording;
  return <span className="ui-recorder">
    {refused && <span className="ui-recorder-refused" role="alert">{refused}</span>}
    {/* Before the key, so the key's right edge lines up with every other control whether or not it holds a chord. */}
    {clearable && <button type="button" className="ui-recorder-clear" aria-label={`Clear ${label}`} onClick={() => save(null)}><Icon name="close" size={12} /></button>}
    <button type="button" className="ui-recorder-key" data-recording={recording || undefined} aria-label={`${label}: ${value?.label ?? 'none'}`}
      onClick={() => { setRefused(null); setRecording(!recording); }} onBlur={stop} onKeyDown={key} onKeyUp={event => { if (recording) setPartial(glyphs(held(event))); }}>
      {recording ? (partial ? <span className="ui-kbd-text">{partial}</span> : <span className="hint">Type shortcut</span>)
        : value ? <span className="ui-kbd-text">{value.label}</span> : <span className="hint">Record shortcut</span>}
    </button>
  </span>;
}
