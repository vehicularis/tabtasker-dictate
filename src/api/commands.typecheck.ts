import { invoke } from '../bridge';

// Never imported: `tsc` (npm run build) checks that the right calls compile and the wrong ones don't.
void invoke('quit');
void invoke('status');
void invoke('open_app');
void invoke('open_app', { route: 'setup' });
void invoke('set_enabled', { enabled: true });
void invoke('sticky_update', { id: 'a', text: 'hi' });
// @ts-expect-error a command with no arguments takes no second argument
void invoke('quit', {});
// @ts-expect-error required arguments cannot be left out
void invoke('set_enabled');
// @ts-expect-error a missing required argument
void invoke('sticky_size', { id: 'a', width: 1 });
// @ts-expect-error an argument the command does not take
void invoke('set_enabled', { enabled: true, loud: true });
// @ts-expect-error a command the Mac side does not have
void invoke('set_enable', { enabled: true });
// @ts-expect-error the wrong kind of argument
void invoke('request', { kind: 'telepathy' });
export const answer: Promise<boolean> = invoke('set_open_at_login', { enabled: true });
