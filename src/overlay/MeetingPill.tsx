import { useCallback, useEffect, useState } from 'react';
import { invoke, listen } from '../bridge';
import { message } from '../lib/errors';
import type { Events } from '../store';
import { X } from './icons';
import { leave } from '../ui/motion';
import { PREVIEW } from './preview';
import './meeting-pill.css';

/// What the Mac's own sound is doing in a meeting: waiting for macOS, recorded, or why it is not.
type SystemSound = 'pending' | 'on' | 'off' | 'unsupported' | 'denied' | 'failed';
/// dictate-meeting, with what meeting.rs adds: which meeting, the Mac's sound, and a recording kept to retry.
export type MeetingEvent = Events['dictate-meeting'] & { id?: string; system?: SystemSound; leftover?: string };
/// A recording kept until someone chooses: a meeting that stopped before it was saved (a crash, a quit,
/// a full disk), or one `saved` with parts Whisper couldn't read.
export type Leftover = { id: string; sinceMs: number; seconds: number; saved: boolean };
export type MeetingState = {
  recording: MeetingEvent | null; saving: string[]; leftovers: Leftover[];
  systemAudio: 'unsupported' | 'notDetermined' | 'allowed' | 'denied';
};

/// meeting_state, asked again whenever a meeting changes and when the window comes back.
export function useMeetingState(): [MeetingState | null, () => void] {
  const [state, setState] = useState<MeetingState | null>(null);
  const look = useCallback(() => void invoke<MeetingState>('meeting_state').then(setState).catch(() => {}), []);
  useEffect(() => {
    look();
    const off = listen('dictate-meeting', look);
    addEventListener('focus', look);
    return () => { off(); removeEventListener('focus', look); };
  }, [look]);
  return [state, look];
}

/// "Today at 14:05", "Yesterday at 09:30" or "2 Nov at 14:05".
export function meetingWhen(ms: number) {
  const at = new Date(ms), today = new Date();
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(at.toDateString()).getTime()) / 86_400_000);
  const day = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `${day} at ${time}`;
}
/// "Under a minute", "23 min", "1 h 5 min", never broken across lines.
export function meetingLength(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'Under a minute';
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}
const elapsed = (since: number) => {
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`;
};
const ONLY_MIC: Partial<Record<SystemSound, string>> = {
  unsupported: 'Recording the other side needs macOS 14.2 or later.',
  denied: 'Dictate isn’t allowed to record your Mac’s sound.',
  failed: 'Couldn’t record your Mac’s sound.',
};

// `?preview=meeting`, meeting-mic, meeting-saving, meeting-saved, meeting-partial, meeting-error,
// meeting-leftover and meeting-kept.
const SAMPLE_SINCE = Date.now() - 754_000;
const PREVIEWS: Record<string, { recording?: MeetingEvent; outcome?: MeetingEvent; leftover?: Leftover }> = {
  meeting: { recording: { state: 'recording', id: '1', since: SAMPLE_SINCE, system: 'on' } },
  'meeting-mic': { recording: { state: 'recording', id: '1', since: SAMPLE_SINCE, system: 'denied' } },
  'meeting-saving': { outcome: { state: 'saving', id: '1', message: 'Writing the summary' } },
  'meeting-saved': { outcome: { state: 'saved', id: '1', path: '/Users/you/Documents/TabTasker | Dictate/Meetings/2026-11-02 14.05 Planning the launch.md' } },
  'meeting-partial': { outcome: { state: 'saved', id: '1', leftover: '1', path: '/Users/you/Documents/TabTasker | Dictate/Meetings/2026-11-02 14.05 Meeting.md', message: '2 parts not transcribed. The audio is kept.' } },
  'meeting-error': { outcome: { state: 'error', id: '1', leftover: '1', message: 'Couldn’t write to the meetings folder.' } },
  'meeting-leftover': { leftover: { id: '1', sinceMs: Date.now() - 26 * 3600_000, seconds: 1394, saved: false } },
  'meeting-kept': { leftover: { id: '1', sinceMs: Date.now() - 26 * 3600_000, seconds: 1394, saved: true } },
};
const preview = (PREVIEW && PREVIEWS[PREVIEW]) || {};

// A meeting near the dots: recording with Stop, then saving and saved. A recording kept to try again is
// offered back once the overlay loads. It listens for dictate-meeting itself, and gives way to the dots'
// menu (meeting-pill.css).
export function MeetingPill() {
  const [recording, setRecording] = useState<MeetingEvent | null>(preview.recording ?? null);
  const [outcome, setOutcome] = useState<MeetingEvent | null>(preview.outcome ?? null);
  const [leftover, setLeftover] = useState<Leftover | null>(preview.leftover ?? null);
  const [later, setLater] = useState<string[]>([]); // leftovers put off until the next launch
  const [discarding, setDiscarding] = useState(false);
  const [explain, setExplain] = useState(PREVIEW === 'meeting-mic');
  const [, setClock] = useState(0);

  const look = useCallback((known: string[] = []) => {
    if (PREVIEW) return;
    void invoke<MeetingState>('meeting_state').then(state => {
      setRecording(state.recording);
      setLeftover(state.leftovers.find(one => !known.includes(one.id)) ?? null);
      if (!state.recording && state.saving.length) setOutcome(current => current ?? { state: 'saving', id: state.saving[0], message: 'Finishing the transcript' });
    }).catch(() => {});
  }, []);
  useEffect(() => look(), [look]);
  useEffect(() => listen<MeetingEvent>('dictate-meeting', event => {
    if (event.state === 'recording') { setRecording(event); return; }
    setRecording(current => current?.id === event.id ? null : current);
    setOutcome(event);
    setDiscarding(false);
    if (event.state !== 'saving') look(later);
  }), [look, later]);

  useEffect(() => { // the time, once a second
    if (!recording?.since) return;
    const timer = setInterval(() => setClock(tick => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [recording?.since]);
  const system = recording?.system;
  useEffect(() => { // why only the mic is recorded, said for a few seconds, then just "Mic only"
    if (!system || !ONLY_MIC[system] || PREVIEW) return;
    setExplain(true);
    const timer = setTimeout(() => setExplain(false), 8000);
    return () => clearTimeout(timer);
  }, [system]);
  useEffect(() => { // a saved meeting, or one that needs nothing more, goes after a while
    if (!outcome || PREVIEW || outcome.state === 'saving' || outcome.leftover || (outcome.state === 'saved' && outcome.message)) return;
    const timer = setTimeout(() => setOutcome(null), 8000);
    return () => clearTimeout(timer);
  }, [outcome]);

  const stop = () => void invoke('meeting', { action: 'stop' }).catch(() => {});
  const recover = (id: string, save: boolean) => {
    setDiscarding(false);
    void invoke('meeting_recover', { id, save }).then(() => { if (!save) look(later); }, (error: unknown) => {
      setOutcome({ state: 'error', id, message: message(error, 'Couldn’t do that. Try again in Settings › Meetings.') });
    });
  };
  const putOff = (id: string) => { const next = [...later, id]; setLater(next); setOutcome(null); look(next); };
  const reveal = (path: string) => void invoke('meeting_reveal', { path }).catch(() => setOutcome({ state: 'error', message: 'Couldn’t find the meeting. It’s been moved or deleted.' }));

  // A meeting that just ended can still be saving while the next one records: both show.
  const live = (() => {
    if (recording) {
      const onlyMic = !!system && system !== 'on' && system !== 'pending';
      return <div ref={leave} className="glass meeting-pill meeting-card" data-glass data-hit role="group" aria-label="Meeting recording">
        <span className="meeting-dot" aria-hidden="true" />
        <span className="meeting-text">
          <span className="meeting-line"><b>Meeting</b><time>{recording.since ? elapsed(recording.since) : '0:00'}</time>
            {onlyMic && <span className="only" title={system && ONLY_MIC[system]}>Mic only</span>}</span>
          {explain && system && ONLY_MIC[system] && <small>{ONLY_MIC[system]}{system === 'denied' && <> <button type="button" className="dots-link" onClick={() => void invoke('meeting_privacy').catch(() => {})}>Allow it</button></>}</small>}
        </span>
        <button type="button" className="meeting-stop" aria-label="Stop the meeting" title="Stop the meeting" onClick={stop}><i /></button>
      </div>;
    }
    if (outcome || !leftover) return null;
    const title = discarding ? 'Discard this recording?' : leftover.saved ? 'A meeting has gaps' : 'A meeting wasn’t saved';
    return <div ref={leave} className="glass meeting-pill meeting-card" data-glass data-hit role="status">
      <span className="meeting-text"><span className="meeting-line"><b>{title}</b></span>
        <small>{discarding ? (leftover.saved ? 'The saved meeting stays as it is.' : 'You can’t undo this.') : `${meetingWhen(leftover.sinceMs)} · ${meetingLength(leftover.seconds)}`}</small></span>
      {discarding
        ? <><button type="button" className="btn" onClick={() => setDiscarding(false)}>Keep</button><button type="button" className="btn dots-danger" onClick={() => recover(leftover.id, false)}>Discard</button></>
        : <><button type="button" className="btn" onClick={() => setDiscarding(true)}>Discard</button><button type="button" className="btn primary" onClick={() => recover(leftover.id, true)}>{leftover.saved ? 'Try again' : 'Save'}</button>
          <button type="button" className="close" aria-label="Later" title="Later" onClick={() => putOff(leftover.id)}><X /></button></>}
    </div>;
  })();
  const finished = (() => {
    if (outcome?.state === 'saving') {
      return <p ref={leave} className="glass meeting-pill meeting-card" data-glass data-state="saving" role="status">
        <span className="meeting-dot" aria-hidden="true" />
        <span className="meeting-text"><span className="meeting-line"><b>Saving the meeting</b></span><small>{outcome.message ?? 'Finishing the transcript'}</small></span>
      </p>;
    }
    if (outcome?.state === 'saved' && outcome.path) {
      const path = outcome.path, kept = outcome.leftover;
      if (!outcome.message && !kept) {
        return <button ref={leave} type="button" className="glass said saved meeting-card" data-glass data-hit onClick={() => { void invoke('note_open', { path }).catch(() => reveal(path)); setOutcome(null); }}>
          <small>Meeting saved · Open</small><span>{path.split('/').pop()?.replace(/\.md$/, '')}</span>
        </button>;
      }
      // Saved, with something to say: it stopped early, or parts are still audio.
      return <div ref={leave} className="glass meeting-pill meeting-card" data-glass data-hit role="status">
        <span className="meeting-text"><span className="meeting-line"><b>Meeting saved</b></span><small>{outcome.message}</small></span>
        <button type="button" className="btn" title="Show in Finder" aria-label="Show in Finder" onClick={() => reveal(path)}>Show</button>
        {kept && <button type="button" className="btn primary" onClick={() => recover(kept, true)}>Try again</button>}
        <button type="button" className="close" aria-label={kept ? 'Later' : 'Close'} title={kept ? 'Later' : undefined} onClick={() => kept ? putOff(kept) : setOutcome(null)}><X /></button>
      </div>;
    }
    if (outcome?.state === 'error') {
      const kept = outcome.leftover;
      return <div ref={leave} className="glass meeting-pill meeting-card" data-glass data-hit role="alert">
        <span className="meeting-text"><span className="meeting-line"><b>{kept ? 'The meeting wasn’t saved' : outcome.message}</b></span>
          {kept && <small>{outcome.message} The recording’s still here, so you can try again.</small>}</span>
        {kept
          ? <><button type="button" className="btn" onClick={() => putOff(kept)}>Later</button><button type="button" className="btn primary" onClick={() => recover(kept, true)}>Try again</button></>
          : <button type="button" className="close" aria-label="Close" onClick={() => setOutcome(null)}><X /></button>}
      </div>;
    }
    return null;
  })();
  return <>{finished}{live}</>;
}
