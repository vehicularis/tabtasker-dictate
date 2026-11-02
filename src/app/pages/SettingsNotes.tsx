import type { PageProps } from '../../store';
import { PageHeader } from '../../ui';
import { Meetings } from './Meetings';
import { Notes } from './Notes';

/// Where notes and meetings are kept and what goes in them: the folder, file names, front matter, who is
/// heard in a meeting and what its summary holds.
export function SettingsNotes(props: PageProps) {
  return <>
    <PageHeader icon="book" title="Notes & meetings">Where your notes and meetings are kept, how they are named, who is heard, and what a summary holds.</PageHeader>
    <Notes {...props} />
    <Meetings {...props} />
  </>;
}
