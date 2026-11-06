// Every type that crosses the bridge, defined once: what the Mac side (src-tauri) takes, answers and emits.
// Nothing here imports a page, a hook or the DOM, so the contract and its tests stay plain TypeScript.

// ---------- the settings, as settings.rs keeps them (settings.json in the app data folder) ----------
export type Chord = { keyCode: number; modifiers: number; label: string };
export type Style = 'default' | 'casual' | 'formal' | 'code' | 'raw';
export type DictateKey = 'fn' | 'rightCommand' | 'rightOption' | 'rightControl' | 'rightShift';
export type CommandKey = 'control' | 'option' | 'command' | 'shift' | 'off';
export type ClaudeModel = 'claude-haiku-5-5' | 'claude-sonnet-5-5' | 'claude-opus-5-5';
/// Anthropic's API with your own key, the Claude Code on this Mac with your Claude account, or a model on this Mac behind Ollama.
export type ClaudeVia = 'api' | 'claudeCode' | 'local' | 'openAi';
export type Keep = 'off' | 'day' | 'week' | 'month' | 'forever';
export type Theme = 'system' | 'light' | 'dark';
export type Edge = 'bottom' | 'left' | 'right';
export type Size = 'small' | 'medium' | 'large';
/// The buttons the dots' pill can hold, in the pill's order (settings.rs PillButton).
export type PillButton = 'note' | 'write' | 'sticky' | 'meeting' | 'library' | 'settings';
export type AppStyle = { bundleId: string; name: string; style: Style; polish: boolean; send?: boolean | null };
/// The speech models (speech.rs Model).
export type Model = 'turbo' | 'small';
export type Settings = {
  version: 1;
  general: { menuBarIcon: boolean; showInDock: boolean; checkForUpdates: boolean };
  shortcuts: { dictate: DictateKey; handsFree: boolean; command: CommandKey; note: Chord | null; meeting: Chord | null; pasteLast: Chord | null; writeNote: Chord | null; sticky: Chord | null; ask: Chord | null };
  dictation: { language: string; translateToEnglish: boolean; removeFillers: boolean; sounds: boolean; soundVolume: number; startSound: string; stopSound: string; model: Model };
  vocabulary: { words: string[]; replacements: { from: string; to: string }[]; learn: boolean; suggestions: string[] };
  apps: { styles: AppStyle[]; defaultStyle: Style };
  notes: { folder: string | null; fileName: string; frontmatter: boolean; dailyNote: boolean; tags: string[]; claudeTitle: boolean; claudeActions: boolean };
  meetings: { folder: string | null; systemAudio: boolean; summarize: boolean; you: string; others: string; speakers: boolean; decisions: boolean; actionItems: boolean };
  claude: { enabled: boolean; via: ClaudeVia; model: ClaudeModel; effort: 'low' | 'medium' | 'high'; commands: boolean; claudeCode: string | null; localEndpoint: string; localModel: string; openAiEndpoint: string; openAiModel: string };
  agents: { mcp: boolean; shareHistory: boolean; shareNotes: boolean; shareMeetings: boolean; allowWrite: boolean };
  history: { keep: Keep };
  appearance: { theme: Theme; edge: Edge; size: Size; idle: 'dots' | 'hidden'; hint: boolean; pill: PillButton[]; margin: number; avoidDock: boolean };
};
type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
/// Any part of the settings: objects merge, lists and values replace.
export type Patch = DeepPartial<Settings>;

// ---------- what the native side reports ----------
/// Permissions, the model, the microphones.
export type Status = {
  enabled: boolean; microphone: 'allowed' | 'notDetermined' | 'denied'; accessibility: boolean;
  modelReady: boolean; modelPreparing: boolean; modelMessage: string; notes: string; openAtLogin: boolean;
  // What "Press 🌐 key to" does instead of nothing: it competes with holding fn.
  globeKey: '' | 'inputSource' | 'emoji' | 'dictation';
  inputs: { id: string; name: string }[]; input: string | null; inputInUse: string;
  /// The shortcuts macOS has on, as key code and modifier flags; any the person added in System Settings too.
  systemShortcuts: [number, number][];
  home?: string; // the home folder, for paths written with ~
  firstRun?: boolean; // this launch is the first and opened the full setup in Settings
};
/// Where updates stand (updates.rs): checking or downloading while `busy`, a newer `version` there to install once `ready`.
export type UpdateState = { current: string; busy: boolean; version: string | null; ready: boolean; latest: boolean; problem: string | null };
/// What speech.rs says about the models: the one in use, each one's size and whether it is on this
/// Mac, and the newest download or load, under way or failed.
export type Models = {
  active: Model | null; enabled: boolean;
  step: { model: Model; message: string; percent: number | null; failed: boolean } | null;
  models: { model: Model; bytes: number; downloaded: boolean }[];
};

// ---------- history ----------
export type HoldMode = 'dictate' | 'note' | 'command' | 'handsfree';
export type HistoryEntry = { atMs: number; mode: HoldMode; bundleId: string; appName: string; words: number; seconds: number; text: string };
/// history.rs's stats: `today` is a local day number (days since 1970-01-01 on this Mac) and `days`
/// the words on each of the last 30, ending on it.
export type HistoryStats = {
  dictations: number; wordsToday: number; wordsTotal: number; wpm: number; savedSeconds: number; streak: number;
  today: number; days: number[]; apps: { bundleId: string; name: string; words: number }[];
};

// ---------- stickies, notes and apps ----------
export type StickyHue = 'amber' | 'coral' | 'sage' | 'sky' | 'violet' | 'slate' | 'teal' | 'plum';
export type StickyTilt = 'none' | 'slight' | 'random';
export type StickyWeight = 'regular' | 'bold';
/// A sticky on the screen (stickies.rs), in one of the whiteboard's hues (boardColor.ts in TabTasker Business).
export type Sticky = {
  id: string; text: string; hue: StickyHue; x: number; y: number; width: number; height: number;
  /// The clear strip above the sheet that `y` includes, in points.
  gutter: number;
  pinned: boolean; folded: boolean; closed: boolean; archived: boolean; title: string; titled: boolean; tilt: StickyTilt; weight: StickyWeight; createdMs: number; updatedMs: number;
};
/// A note or meeting file as the Library lists it (notes.rs LibraryItem).
export type LibraryItem = { path: string; title: string; kind: 'note' | 'meeting'; modifiedMs: number; words: number; excerpt: string; archived: boolean };
/// A note or meeting in the editor (notes.rs NoteDoc): its title apart, its body as Markdown with no front matter or heading.
export type NoteDoc = { path: string; title: string; body: string; kind: 'note' | 'meeting'; modifiedMs: number };
/// The folder notes are saved in, and the Obsidian vault around it when there is one (notes.rs Folder).
export type Folder = { path: string; vault: string | null };
/// A note as the file name and text the settings would make from a sample (notes.rs Preview).
export type Preview = { fileName: string; text: string };
/// An app as list_apps finds it.
export type AppInfo = { bundleId: string; name: string; icon: string | null; running: boolean; recent: boolean };

// ---------- agents ----------
export type Added = 'no' | 'yes' | 'elsewhere';
export type Install = { found: boolean; added: Added };
export type Call = { atMs: number; tool: string; client: string; clientTitle?: string | null; ok: boolean };
/// What mcp.rs's agents_status reports.
export type AgentsStatus = { command: string[]; claudeCode: Install; claudeDesktop: Install; lastCall: Call | null; problem: string | null };

// ---------- meetings ----------
/// What the Mac's own sound is doing in a meeting: waiting for macOS, recorded, or why it is not.
export type SystemSound = 'pending' | 'on' | 'off' | 'unsupported' | 'denied' | 'failed';
/// dictate-meeting (meetings/mod.rs): which meeting, when it began, the Mac's sound, the saved file, and a recording kept to retry.
export type MeetingEvent = { state: 'recording' | 'saving' | 'saved' | 'error'; id?: string; since?: number; system?: SystemSound; path?: string; message?: string; leftover?: string };
/// A recording kept until someone chooses: a meeting that stopped before it was saved (a crash, a quit,
/// a full disk), or one `saved` with parts Whisper couldn't read.
export type Leftover = { id: string; sinceMs: number; seconds: number; saved: boolean };
export type MeetingState = {
  recording: MeetingEvent | null; saving: string[]; leftovers: Leftover[];
  systemAudio: 'unsupported' | 'notDetermined' | 'allowed' | 'denied';
};

// ---------- what the overlay hears ----------
export type Phase = 'idle' | 'listening' | 'transcribing' | 'sending';
/// Claude's answer to a spoken command (ai/mod.rs emit_command).
export type Command = { request: string; phase: 'thinking' | 'answer' | 'done' | 'error'; text?: string; instruction?: string; typed?: boolean };
/// What the menu bar's File and Window items ask the tabs to do (menu.rs); `select:N` is the Nth tab.
export type TabAction = 'new' | 'close' | 'close-others' | 'close-right' | 'reopen' | 'duplicate' | 'next' | 'prev' | 'left' | 'right' | 'window' | `select:${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
