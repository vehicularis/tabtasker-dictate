import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { KEY_NAMES } from '../../overlay/Dock';
import { createGlass, flatWave, paintInside, type Glass } from '../../overlay/glass';
import { LibraryGlyph, MeetingGlyph, NoteGlyph, SettingsGlyph, StickyGlyph, WriteGlyph } from '../../overlay/glyphs';
import { isDark } from '../../ui/theme';
import { PILL_BUTTONS, type Edge, type PageProps, type Patch, type PillButton, type Settings, type Size, type Theme } from '../../store';
import { PageHeader, reduced, Section, Segmented, Slider, Tile, TileGroup, timing, Toggle } from '../../ui';

const THEMES: { value: Theme; label: string }[] = [{ value: 'system', label: 'Automatic' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];
const EDGES: { value: Edge; label: string }[] = [{ value: 'left', label: 'Left' }, { value: 'bottom', label: 'Bottom' }, { value: 'right', label: 'Right' }];
const SIZES: { value: Size; label: string }[] = [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }];
// The pill's buttons as Appearance names them, with their glyph for the preview.
const BUTTONS: Record<PillButton, { title: string; detail: string; glyph: ReactNode }> = {
  note: { title: 'Speak a note', detail: '', glyph: <NoteGlyph size={18} /> },
  write: { title: 'Write a note', detail: '', glyph: <WriteGlyph size={18} /> },
  sticky: { title: 'New sticky', detail: '', glyph: <StickyGlyph size={18} /> },
  meeting: { title: 'Record a meeting', detail: '', glyph: <MeetingGlyph size={18} /> },
  library: { title: 'Your notes', detail: '', glyph: <LibraryGlyph size={18} /> },
  settings: { title: 'Settings', detail: '', glyph: <SettingsGlyph size={18} /> },
};
type Moment = 'idle' | 'hover' | 'talking';
const MOMENTS: { value: Moment; label: string }[] = [{ value: 'idle', label: 'Idle' }, { value: 'hover', label: 'Pointing' }, { value: 'talking', label: 'Talking' }];

export function Appearance({ settings, update }: PageProps) {
  const look = settings.appearance;
  const key = KEY_NAMES[settings.shortcuts.dictate];
  // The preview shows the moment a change is about: the hint while pointing, nothing while idle and hidden.
  const [moment, setMoment] = useState<Moment>('idle');
  const change = (patch: Patch['appearance'], show?: Moment) => { if (show) setMoment(show); void update({ appearance: patch }); };
  return <>
    <PageHeader icon="appearance" title="Appearance">How Dictate looks on your screen.</PageHeader>
    <Preview look={look} keyName={key} moment={moment} onMoment={setMoment} />
    <Section>
      <TileGroup>
        <Tile title="Theme">
          <Segmented label="Theme" value={look.theme} options={THEMES} onChange={theme => change({ theme })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="The dots" note="You can also drag the dots to another edge.">
      <TileGroup>
        <Tile title="Edge">
          <Segmented label="Edge" value={look.edge} options={EDGES} onChange={edge => change({ edge })} />
        </Tile>
        <Tile title="Size">
          <Segmented label="Size" value={look.size} options={SIZES} onChange={size => change({ size })} />
        </Tile>
        <Tile title="When idle" detail={`With Hidden, nothing shows until you hold ${key}.`}>
          <Segmented label="When idle" value={look.idle} options={[{ value: 'dots', label: 'Dots' }, { value: 'hidden', label: 'Hidden' }]} onChange={idle => change({ idle }, 'idle')} />
        </Tile>
        <Tile title="Hint" detail={look.pill.includes('note') ? `Reminds you to hold ${key} when you point at the dots.` : 'Turn on Speak a note below to use this.'} dim={!look.pill.includes('note')}>
          <Toggle label="Hint" checked={look.hint} disabled={!look.pill.includes('note')} onChange={hint => change({ hint }, 'hover')} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Buttons on the dots" note="Right-click the dots for everything, including what’s turned off here.">
      <TileGroup>
        {PILL_BUTTONS.map(name => {
          const on = look.pill.includes(name);
          return <Tile key={name} title={BUTTONS[name].title} detail={BUTTONS[name].detail}>
            <Toggle label={BUTTONS[name].title} checked={on} disabled={on && look.pill.length === 1} onChange={next => change({ pill: PILL_BUTTONS.filter(button => button === name ? next : look.pill.includes(button)) }, 'hover')} />
          </Tile>;
        })}
      </TileGroup>
    </Section>
    <Section title="Position">
      <TileGroup>
        <Tile title="Margin">
          <Slider label="Margin" min={0} max={120} step={2} value={look.margin} format={value => `${value} pt`} onChange={margin => change({ margin })} />
        </Tile>
        <Tile title="Stay clear of the Dock" detail={look.avoidDock ? undefined : 'The Dock can cover the dots.'}>
          <Toggle label="Stay clear of the Dock" checked={look.avoidDock} onChange={avoidDock => change({ avoidDock })} />
        </Tile>
      </TileGroup>
    </Section>
  </>;
}

// A MacBook with the dots on its screen, drawn from the settings as they are now: a reply waiting for words.
// The orb as the overlay draws it, in miniature: the same glass, writing out what a made-up voice says while
// the moment is Talking, as the real one does until you let go.
const SAID = 'Thursday works. Can we take the bigger room?';
function LiveOrb({ talking }: { talking: boolean }) {
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const box = host.current;
    if (!box) return;
    const size = Math.ceil((box.clientWidth || 38) * Math.min(devicePixelRatio || 1, 2));
    const accent = getComputedStyle(box).getPropertyValue('--accent').trim() || '#3b82f6';
    const surface = document.createElement('canvas'), inside = document.createElement('canvas');
    surface.width = surface.height = size; inside.width = inside.height = size;
    let glass: Glass;
    try { glass = createGlass(surface, accent); } catch { glass = flatWave(surface, accent); }
    box.replaceChildren(surface, inside);
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0, energy = .3;
    const started = performance.now();
    const draw = (now: number) => {
      const t = (now - started) / 1000;
      const voice = talking ? .4 + .3 * Math.sin(t * 3.1) + .2 * Math.sin(t * 7.3) + .1 * Math.sin(t * 13.7) : 0;
      const target = .25 + .75 * Math.max(0, Math.min(1, voice));
      energy += (target - energy) * .2;
      const time = 1.9 + (still ? 0 : t * 2.4);
      glass.draw(time, isDark() ? [.09, .1, .11] : [.97, .97, .97], energy, 4, 0);
      const ink = getComputedStyle(box).getPropertyValue('--orb-ink').trim() || '#f4efe6';
      paintInside(inside, talking ? 'caret' : 'bars', energy, time, 0, talking ? ink : accent, talking ? SAID.slice(0, still ? SAID.length : Math.floor(t * 30) % (SAID.length + 30)) : '');
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); glass.dispose(); };
  }, [talking]);
  return <span ref={host} className="look-orb" />;
}

function Preview({ look, keyName, moment, onMoment }: { look: Settings['appearance']; keyName: string; moment: Moment; onMoment: (moment: Moment) => void }) {
  const hidden = look.idle === 'hidden' && moment === 'idle';
  const said = { idle: hidden ? `Nothing shows until you hold ${keyName}` : 'The dots wait at the edge', hover: look.hint ? 'Pointing at the dots opens their buttons and a hint' : 'Pointing at the dots opens their buttons', talking: `As you talk, the orb shows your words. When you let go of ${keyName}, they’re typed at your cursor` }[moment];
  // A new edge or size: the dots travel there from where they are, on the spring the real ones land on when dropped.
  const dock = useRef<HTMLSpanElement>(null), at = useRef<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = dock.current;
    if (!el) return;
    const moving = el.getAnimations().find(running => running.id === 'edge');
    const [tx = 0, ty = 0] = moving ? getComputedStyle(el).translate.split(' ').map(value => parseFloat(value) || 0) : [];
    const was = at.current && { x: at.current.x + tx, y: at.current.y + ty }; // mid-way, from where it is on the screen
    moving?.cancel();
    at.current = { x: el.offsetLeft, y: el.offsetTop };
    const dx = was ? was.x - at.current.x : 0, dy = was ? was.y - at.current.y : 0;
    if (reduced() || Math.abs(dx) + Math.abs(dy) < 1) return;
    el.animate({ translate: [`${dx}px ${dy}px`, '0 0'] }, { ...timing('--pop', '--spring'), id: 'edge' });
  }, [look.edge, look.size]);
  return <figure className="look" style={{ '--buttons': look.pill.length } as CSSProperties} data-edge={look.edge} data-size={look.size} data-moment={moment} data-quiet={look.idle === 'hidden' || undefined}>
    <div className="look-mac" role="img" aria-label={`The dots at the ${look.edge} edge, ${look.size}. ${said}.`}>
      <div className="look-screen" aria-hidden="true">
        <div className="look-menubar">
          <svg className="apple" viewBox="0 0 14 17"><path d="M11.6 9c0-2 1.6-2.9 1.7-3a3.7 3.7 0 0 0-2.9-1.6c-1.2-.1-2.4.7-3 .7s-1.6-.7-2.6-.7A3.9 3.9 0 0 0 1.5 6.4c-1.4 2.4-.4 6 1 8 .7 1 1.5 2 2.5 2s1.4-.6 2.6-.6 1.5.6 2.6.6 1.7-1 2.4-2a8.4 8.4 0 0 0 1-2.2A3.4 3.4 0 0 1 11.6 9zM9.6 3.1A3.3 3.3 0 0 0 10.4.7a3.5 3.5 0 0 0-2.3 1.2 3.2 3.2 0 0 0-.8 2.3 2.9 2.9 0 0 0 2.3-1.1z" /></svg>
          <b>Mail</b><span>File</span><span>Edit</span><span>View</span><span>Message</span>
          <span className="tray">
            <svg viewBox="0 0 36 36"><path d="M2 14a2 2 0 0 1 4 0v8a2 2 0 0 1-4 0zM9 10a2 2 0 0 1 4 0v16a2 2 0 0 1-4 0zM23 10a2 2 0 0 1 4 0v16a2 2 0 0 1-4 0zM30 14a2 2 0 0 1 4 0v8a2 2 0 0 1-4 0zM17 4a1 1 0 0 1 2 0v28a1 1 0 0 1-2 0zM15 4h6v2h-6zM15 30h6v2h-6z" /></svg>
            <svg viewBox="0 0 20 14"><path d="M10 13.2 7.6 10.4a3.4 3.4 0 0 1 4.8 0zM4.8 7.6a7.4 7.4 0 0 1 10.4 0l-1.5 1.5a5.2 5.2 0 0 0-7.4 0zM2 4.8a11.3 11.3 0 0 1 16 0l-1.5 1.5a9.2 9.2 0 0 0-13 0z" /></svg>
            <svg viewBox="0 0 26 12"><rect x=".5" y=".5" width="22" height="11" rx="3" fill="none" stroke="currentColor" /><rect x="2.5" y="2.5" width="14" height="7" rx="1.5" /><path d="M24 4v4a2 2 0 0 0 0-4z" /></svg>
            <time>Mon 2 Nov 09:41</time>
          </span>
        </div>
        <div className="look-window">
          <div className="look-titlebar"><i /><i /><i /><b>Re: Thursday’s review</b></div>
          <div className="look-field"><span>To:</span>Maria Lopez</div>
          <div className="look-field"><span>Subject:</span>Re: Thursday’s review</div>
          <div className="look-body">
            <p>Hi Maria,</p>
            <p><i className="look-caret" /></p>
            <blockquote><span>On 1 Nov 2026, Maria Lopez wrote:</span>Does Thursday at 10 still work for the design review? I can book a room.</blockquote>
          </div>
        </div>
        <span ref={dock} className="look-dock">
          <span className="look-dots"><i /><i /><i /></span>
          <span className="look-pill">{look.pill.map(name => <i key={name}>{BUTTONS[name].glyph}</i>)}</span>
          <LiveOrb talking={moment === 'talking'} />
          {look.hint && <span className="look-hint"><kbd>{keyName}</kbd>hold to type</span>}
          <svg className="look-pointer" viewBox="0 0 12 18"><path d="M1 1v14l3.6-3.4 2.3 5.4 2.3-1-2.3-5.3H12z" /></svg>
        </span>
      </div>
      <span className="look-notch" aria-hidden="true" />
    </div>
    <span className="look-base" aria-hidden="true" />
    <figcaption>
      <span>{said}</span>
      <Segmented label="Preview" value={moment} options={MOMENTS} onChange={onMoment} />
    </figcaption>
  </figure>;
}
