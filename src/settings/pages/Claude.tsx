import { useState } from 'react';
import { folderPath, tilde, useStatus, type ClaudeModel, type PageProps } from '../../store';
import { Icon, PageHeader, Section, Segmented, TextField, Tile, TileGroup, Toggle } from '../../ui';

const MODELS: { value: ClaudeModel; label: string }[] = [
  { value: 'claude-haiku-5-5', label: 'Haiku' }, { value: 'claude-sonnet-5-5', label: 'Sonnet' }, { value: 'claude-opus-5-5', label: 'Opus' },
];
const ABOUT: Record<ClaudeModel, string> = {
  'claude-haiku-5-5': 'Haiku 5.5: the fastest, best while you type.',
  'claude-sonnet-5-5': 'Sonnet 5.5: more careful, a moment slower.',
  'claude-opus-5-5': 'Opus 5.5: the most capable, for long notes and meetings.',
};

export function Claude({ settings, update }: PageProps) {
  const claude = settings.claude;
  const [status] = useStatus();
  const [problem, setProblem] = useState<string | null>(null);
  const path = (key: 'claudeCode' | 'projectFolder') => (typed: string) => {
    const value = folderPath(typed, status?.home);
    if (value === undefined) { setProblem('Use a full path, like ~/.local/bin/claude.'); return; }
    setProblem(null);
    update({ claude: { [key]: value } });
  };
  return <>
    <PageHeader icon="claude" title="Claude">Polish, commands and summaries, when you want them.</PageHeader>
    <Section title="Connection" note="Claude sees text only, never your voice. Nothing is sent until you connect.">
      <TileGroup>
        <Tile title={claude.enabled ? 'Connected' : 'Not connected'} detail={claude.enabled ? 'Your Anthropic key is in the Keychain.' : 'Claude features stay off until an Anthropic API key is saved and tested.'}>
          <span className="state" data-on={claude.enabled || undefined}><Icon name={claude.enabled ? 'check' : 'shield'} size={16} />{claude.enabled ? 'On' : 'Off'}</span>
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Model">
      <TileGroup>
        <Tile title="Model" detail={ABOUT[claude.model]}>
          <Segmented label="Model" value={claude.model} options={MODELS} onChange={model => update({ claude: { model } })} />
        </Tile>
        <Tile title="Commands" detail="Hold the command key with the dictate key and tell Claude what to do with the selected text.">
          <Toggle label="Commands" checked={claude.commands} onChange={commands => update({ claude: { commands } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Claude Code" note={problem ?? 'Send a note or meeting to Claude Code, which opens in Terminal in your project folder.'}>
      <TileGroup>
        <Tile title="Claude Code" detail={claude.claudeCode ? undefined : 'Found automatically when it is installed.'}>
          <TextField label="Claude Code path" monospace value={tilde(claude.claudeCode ?? '', status?.home)} placeholder="~/.local/bin/claude" onCommit={path('claudeCode')} />
        </Tile>
        <Tile title="Project folder" detail={claude.projectFolder ? undefined : 'Asked each time when empty.'}>
          <TextField label="Project folder" monospace value={tilde(claude.projectFolder ?? '', status?.home)} placeholder="~/Code/project" onCommit={path('projectFolder')} />
        </Tile>
      </TileGroup>
    </Section>
  </>;
}
