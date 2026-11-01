import { useState } from 'react';
import type { PageProps } from '../../store';
import { Button, ChipList, EmptyState, PageHeader, Section, Tile, TileGroup, Toggle } from '../../ui';

export function Vocabulary({ settings, update }: PageProps) {
  const vocabulary = settings.vocabulary;
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const addReplacement = () => {
    if (!from.trim()) return;
    update({ vocabulary: { replacements: [{ from: from.trim(), to: to.trim() }, ...vocabulary.replacements.filter(pair => pair.from.toLowerCase() !== from.trim().toLowerCase())] } });
    setFrom(''); setTo('');
  };
  const accept = (word: string) => update({ vocabulary: { words: [word, ...vocabulary.words.filter(known => known.toLowerCase() !== word.toLowerCase())], suggestions: vocabulary.suggestions.filter(other => other !== word) } });
  return <>
    <PageHeader icon="book" title="Vocabulary">Names and terms Whisper should spell your way.</PageHeader>
    <Section title="Words" note="Up to 500. The newest are used first.">
      <TileGroup>
        <Tile title="Your words" stack>
          <ChipList label="Your words" placeholder="Add a name or term" items={vocabulary.words} onChange={words => update({ vocabulary: { words } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Replacements" note="Whole words, in any case. Say “my email” and your address is typed.">
      <TileGroup>
        <Tile title="Add a replacement" stack>
          <span className="pair">
            <input className="ui-field wide" aria-label="When you say" placeholder="When you say" value={from} onChange={event => setFrom(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') addReplacement(); }} />
            <input className="ui-field wide" aria-label="Type" placeholder="Type" value={to} onChange={event => setTo(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') addReplacement(); }} />
            <Button icon="plus" small disabled={!from.trim()} onClick={addReplacement}>Add</Button>
          </span>
        </Tile>
        {vocabulary.replacements.map(pair => <Tile key={pair.from} title={pair.from} detail={pair.to ? `Types “${pair.to}”` : 'Types nothing'}>
          <Button variant="quiet" small icon="trash" aria-label={`Remove ${pair.from}`} onClick={() => update({ vocabulary: { replacements: vocabulary.replacements.filter(other => other !== pair) } })} />
        </Tile>)}
      </TileGroup>
    </Section>
    <Section title="Learning">
      <TileGroup>
        <Tile title="Learn from your corrections" detail="When you fix a word right after dictating it, it is suggested here. Nothing is added without a yes.">
          <Toggle label="Learn from your corrections" checked={vocabulary.learn} onChange={learn => update({ vocabulary: { learn } })} />
        </Tile>
        {vocabulary.suggestions.map(word => <Tile key={word} title={word} detail="Suggested from a correction">
          <Button variant="quiet" small onClick={() => update({ vocabulary: { suggestions: vocabulary.suggestions.filter(other => other !== word) } })}>Not now</Button>
          <Button variant="primary" small onClick={() => accept(word)}>Add</Button>
        </Tile>)}
        {!vocabulary.suggestions.length && vocabulary.learn && <EmptyState icon="sparkle" title="No suggestions yet">Words you correct after dictating show up here.</EmptyState>}
      </TileGroup>
    </Section>
  </>;
}
