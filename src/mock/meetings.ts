import type { Mock } from '.';
import type { Leftover, MeetingEvent, MeetingState } from '../overlay/MeetingPill';

// In a browser: recording, the pill and the meetings folder.
// `?meetings=leftover` starts with recordings a crash left unsaved; `?meetings=denied|allowed|unsupported`
// is what macOS says about recording the Mac's sound (unasked by default, and a meeting then asks).
export function register(mock: Mock) {
  const asked = new URLSearchParams(location.search).get('meetings');
  let permission: MeetingState['systemAudio'] = asked === 'denied' || asked === 'allowed' || asked === 'unsupported' ? asked : 'notDetermined';
  let recording: MeetingEvent | null = null;
  const saving = new Set<string>();
  const hours = (n: number) => Date.now() - n * 3600_000;
  let leftovers: Leftover[] = asked === 'leftover' ? [{ id: '2', sinceMs: hours(2), seconds: 1394 }, { id: '1', sinceMs: hours(50), seconds: 3925 }] : [];

  const stamp = (at: number) => {
    const date = new Date(at), two = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}.${two(date.getMinutes())}`;
  };
  const finish = (id: string, since: number) => {
    const settings = mock.settings();
    saving.add(id);
    mock.emit('dictate-meeting', { state: 'saving', id, since, message: 'Finishing the transcript' });
    const claude = settings.claude.enabled && settings.meetings.summarize;
    if (claude) setTimeout(() => mock.emit('dictate-meeting', { state: 'saving', id, since, message: 'Writing the summary' }), 900);
    setTimeout(() => {
      saving.delete(id);
      const folder = settings.meetings.folder ?? `${mock.status.notes}/Meetings`;
      mock.emit('dictate-meeting', { state: 'saved', id, path: `${folder}/${stamp(since)} ${claude ? 'Planning the launch' : `Meeting ${stamp(since)}`}.md` });
    }, claude ? 2200 : 1200);
  };

  mock.handle('meeting', ({ action }) => {
    if (action === 'stop') {
      if (!recording) return false;
      const { id, since } = recording;
      recording = null;
      finish(id!, since!);
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
    if (save) finish(leftover.id, leftover.sinceMs);
  });
  mock.handle('meeting_reveal', () => {});
  mock.handle('meeting_privacy', () => {});
}
