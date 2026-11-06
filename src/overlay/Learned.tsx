import { useEffect, useState } from 'react';
import { listen } from '../bridge';
import { same } from '../lib/text';
import { updateSettings, useSettings } from '../store';
import { PREVIEW } from './preview';
import { leave } from '../ui/motion';

// A word learned from your corrections, near the dots: it listens for dictate-learned itself and adds
// the word only on Add. Not now leaves it waiting in Settings › Vocabulary.
export function Learned() {
  const settings = useSettings();
  const [word, setWord] = useState<string | null>(PREVIEW === 'learned' ? 'Kubernetes' : null);
  const [failed, setFailed] = useState(false);
  useEffect(() => listen('dictate-learned', ({ word }) => { setWord(word); setFailed(false); }), []);
  useEffect(() => { if (!word || PREVIEW) return; const timer = setTimeout(() => setWord(null), 12_000); return () => clearTimeout(timer); }, [word]);
  if (!word || !settings) return null;
  const add = () => {
    const { words, suggestions } = settings.vocabulary;
    void updateSettings({ vocabulary: { words: [word, ...words.filter(other => !same(other, word))], suggestions: suggestions.filter(other => !same(other, word)) } })
      .then(() => setWord(null), () => setFailed(true));
  };
  return <div ref={leave} className="glass learned" data-glass data-hit role="status">
    <span className="dots-what"><small>{failed ? 'Couldn’t add the word. Try again.' : 'Add this to your words?'}</small>{word}</span>
    <button type="button" className="btn" onClick={() => setWord(null)}>Not now</button>
    <button type="button" className="btn primary" onClick={add}>Add</button>
  </div>;
}
