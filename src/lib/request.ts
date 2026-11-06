import type { RequestKind } from '../api/commands';
import { invoke } from '../bridge';

/// Asks the native side for what only it can do (`request`): a permission, a System Settings pane, the end of a
/// hands-free session. A failure is ignored.
export const ask = (kind: RequestKind) => void invoke('request', { kind }).catch(() => {});
