import type { UpdateState } from '../api/types';

/// What the version row says under its name: the last check's answer, or the download under way.
export const updateDetail = (updates: UpdateState): string | undefined =>
  updates.problem ?? (updates.ready ? `Version ${updates.version} is downloaded and ready.`
    : updates.busy ? (updates.version ? `Downloading version ${updates.version}…` : 'Checking for a new version…')
    : updates.latest ? 'You’re up to date.' : undefined);
