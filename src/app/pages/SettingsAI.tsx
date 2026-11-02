import type { PageProps } from '../../store';
import { PageHeader } from '../../ui';
import { Agents } from './Agents';
import { Claude } from './Claude';

/// The model behind polish, commands, titles and summaries, and what Claude Code and Claude Desktop may read.
export function SettingsAI(props: PageProps) {
  return <>
    <PageHeader icon="agents" title="Agents">The model behind titles, summaries, polish and spoken commands. Pick Claude, through Claude Code or your own key, with its model and effort, or a model running on this Mac. It then works under the hood.</PageHeader>
    <Claude {...props} />
    <Agents {...props} />
  </>;
}
