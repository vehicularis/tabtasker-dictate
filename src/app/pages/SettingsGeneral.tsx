import type { PageProps } from '../../store';
import { PageHeader } from '../../ui';
import { AppStyles } from './AppStyles';
import { Dictation } from './Dictation';
import { General } from './General';
import { History } from './History';
import { Shortcuts } from './Shortcuts';
import { Vocabulary } from './Vocabulary';

/// Everything about talking to your Mac, on one page: how the app starts and listens, every shortcut, how
/// speech becomes text and lands in each app (Return included), the words it should know, and what it typed.
export function SettingsGeneral(props: PageProps) {
  return <>
    <PageHeader icon="general" title="General">How TabTasker Dictate starts and listens, every shortcut, and how your words land in each app.</PageHeader>
    <General {...props} />
    <Shortcuts {...props} />
    <Dictation {...props} />
    <AppStyles {...props} />
    <Vocabulary {...props} />
    <History {...props} />
  </>;
}
