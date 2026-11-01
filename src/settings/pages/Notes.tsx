import { useState } from 'react';
import { folderPath, tilde, useStatus, type PageProps } from '../../store';
import { Button, ChipList, PageHeader, Section, TextField, Tile, TileGroup, Toggle } from '../../ui';

export function Notes({ settings, update }: PageProps) {
  const notes = settings.notes;
  const [status] = useStatus();
  const [problem, setProblem] = useState<string | null>(null);
  const home = status?.home;
  const where = tilde(notes.folder ?? status?.notes ?? '~/Documents/TabTasker Dictate', home);
  return <>
    <PageHeader icon="note" title="Notes">Spoken notes are saved as Markdown files, one each.</PageHeader>
    <Section title="Where" note={problem ?? 'Any folder works, an Obsidian vault included.'}>
      <TileGroup>
        <Tile title="Folder" stack>
          <TextField label="Notes folder" monospace wide value={where} placeholder="~/Documents/TabTasker Dictate" onCommit={typed => {
            const folder = folderPath(typed, home);
            if (folder === undefined) { setProblem('Use a full path, like ~/Notes or /Volumes/Notes.'); return; }
            setProblem(null);
            update({ notes: { folder } });
          }} />
          {notes.folder && <Button variant="quiet" onClick={() => update({ notes: { folder: null } })}>Use default</Button>}
        </Tile>
        <Tile title="File name" detail="{date}, {time} and {title} are filled in for each note.">
          <TextField label="File name" monospace value={notes.fileName} onCommit={fileName => update({ notes: { fileName } })} />
        </Tile>
        <Tile title="Daily note" detail="Adds each note to one file per day instead of a new file.">
          <Toggle label="Daily note" checked={notes.dailyNote} onChange={dailyNote => update({ notes: { dailyNote } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Front matter">
      <TileGroup>
        <Tile title="Front matter" detail="A YAML header with when it was made, its tags and where it came from.">
          <Toggle label="Front matter" checked={notes.frontmatter} onChange={frontmatter => update({ notes: { frontmatter } })} />
        </Tile>
        <Tile title="Tags" stack dim={!notes.frontmatter}>
          <ChipList label="Tags" placeholder="Add a tag" items={notes.tags} onChange={tags => update({ notes: { tags } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="With Claude" note={settings.claude.enabled ? undefined : 'These work once Claude is connected.'}>
      <TileGroup>
        <Tile title="Claude names the note" detail="A short title from what you said.">
          <Toggle label="Claude names the note" checked={notes.claudeTitle} onChange={claudeTitle => update({ notes: { claudeTitle } })} />
        </Tile>
        <Tile title="Action items" detail="Claude adds a list of what to do at the end of the note.">
          <Toggle label="Action items" checked={notes.claudeActions} onChange={claudeActions => update({ notes: { claudeActions } })} />
        </Tile>
      </TileGroup>
    </Section>
  </>;
}
