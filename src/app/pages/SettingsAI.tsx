import type { PageProps } from '../../store';
import { PageHeader } from '../../ui';
import { Agents } from './Agents';
import { Claude } from './Claude';

/// The model behind polish, commands, titles and summaries, and what Claude Code and Claude Desktop may read.
export function SettingsAI(props: PageProps) {
  return <>
    <PageHeader icon="claude" title="Claude & AI">One switch connects a model; everything it does then happens under the hood. Pick Claude Code, your own key, or a model on this Mac.</PageHeader>
    <Claude {...props} />
    <Agents {...props} />
  </>;
}
