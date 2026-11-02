import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { invoke } from '../../bridge';
import type { PageProps } from '../../store';
import { Button, ChipList, EmptyState, Icon, PageHeader, Section, Tile, TileGroup, Toggle } from '../../ui';
import './speech.css';

const same = (one: string, other: string) => one.toLowerCase() === other.toLowerCase();

/// How many of `words`, newest first, Whisper is given: as many as fit in its prompt.
function useFit(words: string[]) {
  const [fit, setFit] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void invoke<number>('vocabulary_fit', { words }).then(count => { if (live) setFit(count); }).catch(() => {});
    return () => { live = false; };
  }, [words]);
  return fit;
}

export function Vocabulary({ settings, update }: PageProps) {
  const vocabulary = settings.vocabulary;
  const fit = useFit(vocabulary.words);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const first = useRef<HTMLInputElement>(null);
  const addReplacement = () => {
    const said = from.trim();
    if (!said) return;
    void update({ vocabulary: { replacements: [{ from: said, to: to.trim() }, ...vocabulary.replacements.filter(pair => !same(pair.from, said))] } });
    setFrom(''); setTo('');
    first.current?.focus();
  };
  const accept = (accepted: string[]) => update({ vocabulary: {
    words: [...accepted, ...vocabulary.words.filter(known => !accepted.some(word => same(word, known)))],
    suggestions: vocabulary.suggestions.filter(word => !accepted.includes(word)),
  } });
  const count = vocabulary.words.length;
  const wordsNote = !count ? 'Names, products and terms you use. The newest are given to Whisper first.'
    : fit == null || fit >= count ? `Whisper is given ${count === 1 ? 'this word' : `all ${count}`} each time you speak.`
    : `Whisper is given your newest ${fit} of ${count}, as many as fit each time you speak. Remove the ones you no longer need.`;
  const enter = (event: KeyboardEvent) => { if (event.key === 'Enter') { event.preventDefault(); addReplacement(); } };

  return <>
    <PageHeader icon="book" title="Vocabulary">Names and terms Whisper should spell your way.</PageHeader>
    <Section title="Words" note={wordsNote}>
      <TileGroup>
        <Tile title="Your words" stack>
          <ChipList label="Your words" placeholder="Add a name or term" items={vocabulary.words} onChange={words => update({ vocabulary: { words } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Replacements" note="Whole words in any case, and the punctuation around them stays. Leave “Type” empty to drop a phrase.">
      <TileGroup>
        <Tile title="Add a replacement" stack>
          <span className="pair">
            <input ref={first} className="ui-field wide" aria-label="When you say" placeholder="When you say" value={from} spellCheck={false}
              onChange={event => setFrom(event.target.value)} onKeyDown={enter} />
            <input className="ui-field wide" aria-label="Type" placeholder="Type" value={to} spellCheck={false} onChange={event => setTo(event.target.value)} onKeyDown={enter} />
            <Button icon="plus" small disabled={!from.trim()} onClick={addReplacement}>Add</Button>
          </span>
        </Tile>
        {vocabulary.replacements.map(pair => <Tile key={pair.from} title={<span className="replacement">
          <span className="from">{pair.from}</span><Icon name="chevronRight" size={14} />{pair.to ? <span className="to">{pair.to}</span> : <span className="to" data-dropped>Dropped</span>}
        </span>}>
          <Button variant="quiet" small icon="trash" aria-label={`Remove ${pair.from}`} onClick={() => update({ vocabulary: { replacements: vocabulary.replacements.filter(other => other !== pair) } })} />
        </Tile>)}
      </TileGroup>
    </Section>
    <Section title="Learning">
      <TileGroup>
        <Tile title="Learn from your corrections" detail="When you fix a dictated word within 30 seconds, it is suggested here. Nothing is added without a yes.">
          <Toggle label="Learn from your corrections" checked={vocabulary.learn} onChange={learn => update({ vocabulary: { learn } })} />
        </Tile>
        {vocabulary.suggestions.length > 1 && <Tile title={`${vocabulary.suggestions.length} suggestions`}>
          <Button variant="quiet" small onClick={() => update({ vocabulary: { suggestions: [] } })}>Clear all</Button>
          <Button small onClick={() => accept(vocabulary.suggestions)}>Add all</Button>
        </Tile>}
        {vocabulary.suggestions.map(word => <Tile key={word} title={word} detail="From a correction">
          <Button variant="quiet" small aria-label={`Dismiss ${word}`} onClick={() => update({ vocabulary: { suggestions: vocabulary.suggestions.filter(other => other !== word) } })}>Dismiss</Button>
          <Button variant="primary" small aria-label={`Add ${word}`} onClick={() => accept([word])}>Add</Button>
        </Tile>)}
        {!vocabulary.suggestions.length && vocabulary.learn && <EmptyState icon="sparkle" title="No suggestions yet">Fix a word right after you dictate it, and it shows up here.</EmptyState>}
      </TileGroup>
    </Section>
  </>;
}
