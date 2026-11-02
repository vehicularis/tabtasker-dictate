import { useCallback, useEffect, useState } from 'react';
import { invoke, listen } from '../bridge';
import type { Events } from '../store';
import { X } from './icons';
import { PREVIEW } from './preview';
import './MeetingPill.css';

/// What the Mac's own sound is doing in a meeting: waiting for macOS, recorded, or why it is not.
export type SystemSound = 'pending' | 'on' | 'off' | 'unsupported' | 'denied' | 'failed';
/// dictate-meeting, with what meeting.rs adds: which meeting, the Mac's sound, and a recording kept to retry.
export type MeetingEvent = Events['dictate-meeting'] & { id?: string; system?: SystemSound; leftover?: string };
/// A meeting that stopped before it was saved (a crash, a quit, a full disk).
export type Leftover = { id: string; sinceMs: number; seconds: number };
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
/// "Under a minute", "23 min", "1 h 5 min".
export function meetingLength(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'Under a minute';
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}
const elapsed = (since: number) => {
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`;
};
const ONLY_MIC: Partial<Record<SystemSound, string>> = {
  unsupported: 'Other people need macOS 14.2 or later.',
  denied: 'System audio recording isn’t allowed.',
  failed: 'The Mac’s sound couldn’t be recorded.',
};

// `?preview=meeting`, meeting-mic, meeting-saving, meeting-saved, meeting-error and meeting-leftover.
const SAMPLE_SINCE = Date.now() - 754_000;
const PREVIEWS: Record<string, { recording?: MeetingEvent; outcome?: MeetingEvent; leftover?: Leftover }> = {
  meeting: { recording: { state: 'recording', id: '1', since: SAMPLE_SINCE, system: 'on' } },
  'meeting-mic': { recording: { state: 'recording', id: '1', since: SAMPLE_SINCE, system: 'denied' } },
  'meeting-saving': { outcome: { state: 'saving', id: '1', message: 'Writing the summary' } },
  'meeting-saved': { outcome: { state: 'saved', id: '1', path: '/Users/you/Documents/TabTasker Dictate/Meetings/2026-11-02 14.05 Planning the launch.md' } },
  'meeting-error': { outcome: { state: 'error', id: '1', leftover: '1', message: 'Couldn’t make the notes folder: permission denied.' } },
  'meeting-leftover': { leftover: { id: '1', sinceMs: Date.now() - 26 * 3600_000, seconds: 1394 } },
};
const preview = (PREVIEW && PREVIEWS[PREVIEW]) || {};

// A meeting near the dots: recording with Stop, then saving and saved. A recording that a crash or a
// quit left unsaved is offered back once the overlay loads. It listens for dictate-meeting itself.
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
    if (!outcome || PREVIEW || outcome.state === 'saving' || outcome.leftover) return;
    const timer = setTimeout(() => setOutcome(null), 8000);
    return () => clearTimeout(timer);
  }, [outcome]);

  const stop = () => void invoke('meeting', { action: 'stop' }).catch(() => {});
  const recover = (id: string, save: boolean) => {
    setDiscarding(false);
    void invoke('meeting_recover', { id, save }).then(() => { if (!save) look(later); }, (error: unknown) => {
      setOutcome({ state: 'error', id, message: typeof error === 'string' ? error : 'Couldn’t do that. Try again in Settings › Meetings.' });
    });
  };
  const putOff = (id: string) => { const next = [...later, id]; setLater(next); setOutcome(null); look(next); };

  // A meeting that just ended can still be saving while the next one records: both show.
  const live = (() => {
    if (recording) {
      const onlyMic = !!system && system !== 'on' && system !== 'pending';
      return <div className="glass meeting-pill" data-glass data-hit role="group" aria-label="Meeting recording">
        <span className="meeting-dot" aria-hidden="true" />
        <span className="meeting-text">
          <span className="meeting-line"><b>Meeting</b><time>{recording.since ? elapsed(recording.since) : '0:00'}</time>
            {onlyMic && <span className="only" title={system && ONLY_MIC[system]}>Mic only</span>}</span>
          {explain && system && ONLY_MIC[system] && <small>{ONLY_MIC[system]}{system === 'denied' && <> <button type="button" className="link" onClick={() => void invoke('meeting_privacy').catch(() => {})}>Allow it</button></>}</small>}
        </span>
        <button type="button" className="btn primary" onClick={stop}>Stop</button>
      </div>;
    }
    if (outcome || !leftover) return null;
    return <div className="glass meeting-pill" data-glass data-hit role="status">
      <span className="meeting-text"><span className="meeting-line"><b>{discarding ? 'Discard this recording?' : 'A meeting wasn’t saved'}</b></span>
        <small>{discarding ? 'It can’t be undone.' : `${meetingWhen(leftover.sinceMs)} · ${meetingLength(leftover.seconds)}`}</small></span>
      {discarding
        ? <><button type="button" className="btn" onClick={() => setDiscarding(false)}>Keep</button><button type="button" className="btn danger" onClick={() => recover(leftover.id, false)}>Discard</button></>
        : <><button type="button" className="btn" onClick={() => setDiscarding(true)}>Discard</button><button type="button" className="btn primary" onClick={() => recover(leftover.id, true)}>Save</button>
          <button type="button" className="close" aria-label="Later" title="Later" onClick={() => putOff(leftover.id)}><X /></button></>}
    </div>;
  })();
  const finished = (() => {
    if (outcome?.state === 'saving') {
      return <p className="glass meeting-pill" data-glass data-state="saving" role="status">
        <span className="meeting-dot" aria-hidden="true" />
        <span className="meeting-text"><span className="meeting-line"><b>Saving the meeting</b></span><small>{outcome.message ?? 'Finishing the transcript'}</small></span>
      </p>;
    }
    if (outcome?.state === 'saved' && outcome.path) {
      const path = outcome.path;
      return <button type="button" className="glass said saved" data-glass data-hit onClick={() => { void invoke('meeting_reveal', { path }).catch(() => {}); setOutcome(null); }}>
        <small>Meeting saved · Show in Finder</small><span>{path.split('/').pop()?.replace(/\.md$/, '')}</span>
      </button>;
    }
    if (outcome?.state === 'error') {
      const kept = outcome.leftover;
      return <div className="glass meeting-pill" data-glass data-hit role="alert">
        <span className="meeting-text"><span className="meeting-line"><b>{kept ? 'The meeting wasn’t saved' : outcome.message}</b></span>
          {kept && <small>{outcome.message} The recording is kept.</small>}</span>
        {kept
          ? <><button type="button" className="btn" onClick={() => putOff(kept)}>Later</button><button type="button" className="btn primary" onClick={() => recover(kept, true)}>Try again</button></>
          : <button type="button" className="close" aria-label="Close" onClick={() => setOutcome(null)}><X /></button>}
      </div>;
    }
    return null;
  })();
  return <>{finished}{live}</>;
}
