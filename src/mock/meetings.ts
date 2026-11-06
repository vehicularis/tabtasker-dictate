import type { Mock } from '.';
import { stamp } from '../lib/dates';
import type { Leftover, MeetingEvent, MeetingState } from '../api/types';
import { fileStem } from './notes';

// In a browser: recording, the pill and the meetings folder.
// `?meetings=leftover` starts with two recordings kept: one a crash left unsaved, one saved with parts not
// transcribed. `?meetings=gaps` saves every meeting with parts Whisper couldn't read, and `?meetings=fail`
// can't write any. `?meetings=denied|allowed|unsupported` is what macOS says about recording the Mac's
// sound (unasked by default, and a meeting then asks).
export function register(mock: Mock) {
  const asked = new URLSearchParams(location.search).get('meetings');
  let permission: MeetingState['systemAudio'] = asked === 'denied' || asked === 'allowed' || asked === 'unsupported' ? asked : 'notDetermined';
  let recording: MeetingEvent | null = null;
  const saving = new Set<string>();
  const hours = (n: number) => Date.now() - n * 3600_000;
  let leftovers: Leftover[] = asked === 'leftover' ? [{ id: '2', sinceMs: hours(2), seconds: 1394, saved: false }, { id: '1', sinceMs: hours(50), seconds: 3925, saved: true }] : [];

  const keep = (leftover: Leftover) => { leftovers = [...leftovers.filter(one => one.id !== leftover.id), leftover].sort((a, b) => b.sinceMs - a.sinceMs); };
  const finish = (id: string, since: number, seconds: number) => {
    const settings = mock.settings();
    saving.add(id);
    mock.emit('dictate-meeting', { state: 'saving', id, since, message: 'Finishing the transcript' });
    const claude = settings.claude.enabled && settings.meetings.summarize;
    if (claude) setTimeout(() => mock.emit('dictate-meeting', { state: 'saving', id, since, message: 'Writing the summary' }), 900);
    setTimeout(() => {
      saving.delete(id);
      if (asked === 'fail') {
        keep({ id, sinceMs: since, seconds, saved: false });
        mock.emit('dictate-meeting', { state: 'error', id, message: 'Couldn’t write to the meetings folder.', leftover: id });
        return;
      }
      const folder = settings.meetings.folder ?? `${mock.status.notes}/Meetings`;
      const [date, time] = stamp(new Date(since)).split(' ');
      const path = `${folder}/${fileStem(settings.notes.fileName, claude ? 'Planning the launch' : `Meeting ${date} ${time}`, date, time)}.md`;
      if (asked === 'gaps') {
        keep({ id, sinceMs: since, seconds, saved: true });
        mock.emit('dictate-meeting', { state: 'saved', id, path, message: '2 parts not transcribed. The audio is kept.', leftover: id });
        return;
      }
      mock.emit('dictate-meeting', { state: 'saved', id, path });
    }, claude ? 2200 : 1200);
  };

  mock.handle('meeting', ({ action }) => {
    if (action === 'stop') {
      if (!recording) return false;
      const { id, since } = recording;
      recording = null;
      finish(id!, since!, Math.round((Date.now() - since!) / 1000));
      return true;
    }
    if (recording) return true;
    if (mock.status.microphone !== 'allowed') { mock.emit('dictate-error', { message: 'microphone' }); return false; }
    const since = Date.now();
    const id = String(since);
    recording = { state: 'recording', id, since, system: 'pending' };
    mock.emit('dictate-meeting', recording);
    setTimeout(() => {
      if (recording?.id !== id) return;
      if (permission === 'notDetermined') permission = 'allowed'; // the prompt, answered yes
      const system = !mock.settings().meetings.systemAudio ? 'off' : permission === 'allowed' ? 'on' : permission;
      recording = { ...recording, system };
      mock.emit('dictate-meeting', recording);
    }, 700);
    return true;
  });
  mock.handle('meeting_state', () => ({ recording, saving: [...saving], leftovers, systemAudio: permission }));
  mock.handle('meeting_recover', ({ id, save }) => {
    const leftover = leftovers.find(one => one.id === id);
    if (!leftover) throw 'That recording is gone';
    leftovers = leftovers.filter(one => one !== leftover);
    if (save) finish(leftover.id, leftover.sinceMs, leftover.seconds);
  });
  mock.handle('meeting_reveal', () => {});
  mock.handle('meeting_privacy', () => {});
}
