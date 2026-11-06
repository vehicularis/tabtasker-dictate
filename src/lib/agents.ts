// How the Agents page words what an agent last did.
import type { Call } from '../api/types';

// Each tool as "Claude Code {did}" and "Claude Code tried to {do}".
const TOOLS: Record<string, [string, string]> = {
  list_notes: ['listed your notes', 'list your notes'],
  read_note: ['read a note', 'read a note'],
  search_notes: ['searched your notes', 'search your notes'],
  list_meetings: ['listed your meetings', 'list your meetings'],
  read_meeting: ['read a meeting', 'read a meeting'],
  recent_dictations: ['read your recent dictations', 'read your recent dictations'],
  create_note: ['created a note', 'create a note'],
  append_to_note: ['added to a note', 'add to a note'],
};
const CLIENTS: Record<string, string> = { 'claude-code': 'Claude Code', 'claude-ai': 'Claude Desktop' };

/// A moment as "3 hours ago" (a day, hour or minute at the largest size that fits), or "just now".
export const ago = (ms: number, now: number) => {
  const seconds = Math.round((ms - now) / 1000);
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]] as const) {
    if (-seconds >= size) return format.format(Math.round(seconds / size), unit);
  }
  return 'just now';
};

/// The sentence for an agent's latest call, or that none has asked.
export function lastCall(call: Call | null, now: number) {
  if (!call) return 'No agent has asked yet.';
  const who = CLIENTS[call.client] ?? (call.clientTitle || 'An agent');
  const [did, doing] = TOOLS[call.tool] ?? ['asked for something', 'ask for something'];
  return call.ok ? `${who} ${did} ${ago(call.atMs, now)}.` : `${who} tried to ${doing} ${ago(call.atMs, now)}, and couldn’t.`;
}

/// The entry Claude Desktop gets, which most apps take as is: a program and its arguments, never a shell line.
export const configEntry = ([command, ...args]: string[]) => `"tabtasker-dictate": {\n  "command": ${JSON.stringify(command)},\n  "args": ${JSON.stringify(args)}\n}`;
