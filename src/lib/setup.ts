// What stands between this Mac and dictating.
import type { Status } from '../api/types';

export type StepId = 'welcome' | 'microphone' | 'accessibility' | 'key' | 'model' | 'dots' | 'try' | 'extras' | 'done';

/// Something only the person can do: a permission to give, or a model never downloaded or whose last try
/// failed. A model that is merely loading or downloading is not it: that passes on its own.
export const needsSetup = (status: Status) =>
  status.microphone !== 'allowed' || !status.accessibility || !status.enabled || (!status.modelReady && !status.modelPreparing);
export const setupDone = (status: Status | null) =>
  !!status && status.enabled && status.microphone === 'allowed' && status.accessibility && status.modelReady;

export const voiceReady = (status: Status) => status.enabled && status.modelReady;

/// What still stands between this Mac and dictating, with the step that fixes it.
export const missing = (status: Status) => ([
  ['microphone', 'allow the microphone', status.microphone !== 'allowed'],
  ['accessibility', 'turn on Accessibility', !status.accessibility],
  ['model', 'download the speech model', !voiceReady(status)],
] as [StepId, string, boolean][]).filter(([, , open]) => open);
