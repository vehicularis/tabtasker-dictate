import type { Command, HistoryEntry, MeetingEvent, Models, Phase, Settings, TabAction, UpdateState, Edge } from './types';

/// Every event the Mac side emits, with what it carries. The native voice code's reach JS through the `dictate_ui_*`
/// functions in events.rs, which emit to the overlay alone; the rest are emitted by Rust to every window.
export interface Events {
  'dictate-state': { phase: Phase; level: number; dictating: boolean };
  'dictate-said': { text: string; dictated: boolean; live: boolean };
  'dictate-note': { text: string };
  'dictate-error': { message: string };
  'dictate-notice': { message: string };
  'dictate-fn': { down: boolean };
  'dictate-open': { what: 'writeNote' | 'ask' };
  'dictate-hands-free': { locked: boolean };
  'dictate-pointer': { x: number; y: number } | null;
  'dictate-dock': { shown: boolean; strip: number; edge: Edge };
  /// A sticky's pill rising or falling, as the Mac sees the pointer (stickies.rs, to that sticky's window).
  'dictate-sticky-hover': { id: string; up: boolean };
  'dictate-command': Command;
  'dictate-learned': { word: string };
  'dictate-meeting': MeetingEvent;
  'dictate-settings': Settings;
  'dictate-stickies': { count: number };
  'dictate-history': { entry: HistoryEntry };
  'dictate-model': Models;
  'dictate-update': UpdateState;
  'dictate-tab': TabAction;
}

// Listing a name more or less than `Events` has is a compile error, so this is exactly the set the type holds.
const listed = {
  'dictate-state': 0, 'dictate-said': 0, 'dictate-note': 0, 'dictate-error': 0, 'dictate-notice': 0, 'dictate-fn': 0, 'dictate-open': 0, 'dictate-hands-free': 0,
  'dictate-pointer': 0, 'dictate-dock': 0, 'dictate-sticky-hover': 0, 'dictate-command': 0, 'dictate-learned': 0, 'dictate-meeting': 0, 'dictate-settings': 0,
  'dictate-stickies': 0, 'dictate-history': 0, 'dictate-model': 0, 'dictate-update': 0, 'dictate-tab': 0,
} satisfies Record<keyof Events, 0>;
/// The event names at run time, for the contract test against the Rust sources.
export const EVENTS = Object.keys(listed) as (keyof Events)[];
