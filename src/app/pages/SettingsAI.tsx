import type { PageProps } from '../../store';
import { PageHeader } from '../../ui';
import { Agents } from './Agents';
import { Claude } from './Claude';

/// The model behind polish, commands, titles and summaries, and what Claude Code and Claude Desktop may read.
export function SettingsAI(props: PageProps) {
  return <>
    <PageHeader icon="agents" title="Agents">Choose the model that writes titles, summaries and polish, and answers spoken commands.</PageHeader>
    <Claude {...props} />
    <Agents {...props} />
  </>;
}
