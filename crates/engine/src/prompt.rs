//! Guards against Whisper reciting the vocabulary it was prompted with, and the prompt itself.

/// Whisper reads at most 224 tokens of prompt; the vocabulary stays under this.
pub const PROMPT_TOKENS: usize = 200;

/// Whether `text` is Whisper reciting the vocabulary it was prompted with rather than what was said, as it can
/// over near-silence (OpenWhispr dictionaryEchoFilter.js): nine in ten of its words or more are vocabulary,
/// and it is shaped like the list: one word over and over, a short run ending in a comma, or three or more
/// entries in the list's own order. A sentence that merely uses a few vocabulary words is none of these.
pub fn echoes_prompt(text: &str, words: &[String]) -> bool {
  let bare = |word: &str| word.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
  let entries: Vec<String> = words.iter().map(|word| word.trim().to_lowercase()).filter(|word| !word.is_empty()).collect();
  let known: std::collections::HashSet<String> =
    entries.iter().flat_map(|entry| entry.split_whitespace().map(bare).collect::<Vec<_>>()).filter(|word| !word.is_empty()).collect();
  let said: Vec<String> = text.split_whitespace().map(bare).filter(|word| !word.is_empty()).collect();
  let unique: std::collections::HashSet<&String> = said.iter().collect();
  if unique.is_empty() || (unique.iter().filter(|word| known.contains(**word)).count() * 10) < unique.len() * 9 {
    return false;
  }
  let repeated = unique.iter().any(|word| said.iter().filter(|other| other == word).count() >= 3);
  let fragment = text.trim().ends_with(',') && text.trim().chars().count() <= 30;
  let lower = text.to_lowercase();
  let (mut from, mut in_order) = (0, 0);
  for entry in &entries {
    if let Some(at) = lower[from..].find(entry.as_str()) {
      in_order += 1;
      from += at + entry.len();
    }
  }
  repeated || fragment || in_order >= 3
}

/// Lowercase words with their punctuation gone, one space apart, as OpenWhispr compares them.
pub fn normalize(text: &str) -> String {
  let kept: String = text.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect();
  kept.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whether `text` is the vocabulary Whisper was given recited back, whole or nearly (OpenWhispr
/// matchesDictionaryPrompt): nine in ten of its words are vocabulary, and it uses seven in ten of the vocabulary.
pub fn recites_prompt(text: &str, words: &[String]) -> bool {
  let (said, prompt) = (normalize(text), normalize(&words.join(" ")));
  if said.is_empty() || prompt.is_empty() {
    return false;
  }
  if said == prompt {
    return true;
  }
  let known: std::collections::HashSet<&str> = prompt.split(' ').collect();
  let unique: std::collections::HashSet<&str> = said.split(' ').collect();
  let matched = unique.iter().filter(|word| known.contains(*word)).count();
  matched * 10 >= unique.len() * 9 && matched * 10 >= known.len() * 7
}

/// Audio past which a fragment of the prompt may be what Whisper made of more than it heard.
pub const SPARSE: usize = 3 * 16_000;

/// A decode that may be Whisper reciting its prompt, with what its retry without the prompt is judged
/// against (OpenWhispr audioManager.js): `strict` when it recites the whole vocabulary, otherwise it is a
/// fragment shaped like it; `repeated` when a word comes twice, `unique` the different words in it.
#[derive(Debug, PartialEq)]
pub struct Echo {
  /// The decode recites the whole vocabulary.
  pub strict: bool,
  /// A word comes twice or more.
  pub repeated: bool,
  /// The different words in it.
  pub unique: usize,
}
impl Echo {
  /// `text` heard over `samples`, when it is worth a retry: a strict echo always, a fragment only when a
  /// retry could replace it, so with a word said twice or over 3 s of audio or more.
  pub fn of(text: &str, words: &[String], samples: usize) -> Option<Self> {
    let said = normalize(text);
    let all: Vec<&str> = said.split_whitespace().collect();
    let unique = all.iter().collect::<std::collections::HashSet<_>>().len();
    let echo = Self { strict: recites_prompt(text, words), repeated: all.len() > unique, unique };
    (echo.strict || (echoes_prompt(text, words) && (echo.repeated || samples >= SPARSE))).then_some(echo)
  }

  /// Whether the retry is what was said: it doesn't recite the vocabulary, and in place of a fragment it
  /// isn't one either and hears more: a word more than a fragment that repeated one, or two more over 3 s.
  pub fn keeps(&self, retry: &str, words: &[String], samples: usize) -> bool {
    let unique = normalize(retry).split_whitespace().collect::<std::collections::HashSet<_>>().len();
    if unique == 0 || recites_prompt(retry, words) {
      return false;
    }
    self.strict || (!echoes_prompt(retry, words) && ((self.repeated && unique > self.unique) || (samples >= SPARSE && unique >= self.unique + 2)))
  }
}

/// A period that doesn't end a sentence: after an abbreviation, an initial, a list number or another period.
fn no_full_stop(before: &str) -> bool {
  const SHORT: &[&str] = &[
    "etc", "vs", "mr", "mrs", "ms", "dr", "st", "jr", "sr", "sra", "prof", "incl", "esp", "approx", "ca", "cf", "al", "no", "nr", "ex", "ej", "vgl", "bzw",
    "usw",
  ];
  let word = before.rsplit(|c: char| c.is_whitespace() || c == '(').next().unwrap_or_default().to_lowercase();
  let mut last = before.chars().rev();
  let dotted = matches!((last.next(), last.next(), last.next()), (Some(a), Some('.'), Some(b)) if a.is_alphabetic() && b.is_alphabetic());
  before.ends_with('.')
    || dotted
    || SHORT.contains(&word.as_str())
    || (word.chars().count() == 1 && word.chars().all(char::is_alphabetic))
    || ((1..=2).contains(&word.len()) && word.bytes().all(|b| b.is_ascii_digit()))
}

/// `text` without the vocabulary Whisper recited after what was said (OpenWhispr stripTrailingDictionaryEcho):
/// its last sentence, when that is two or more entries in the prompt's own order from its first. A
/// sentence of real speech hardly ever is. Ours is the newest words and always fits whole, so a recital
/// opens it; OpenWhispr also strips one that closes a prompt Whisper had cut, which ours never is.
pub fn without_recital<'a>(text: &'a str, words: &[String]) -> &'a str {
  let entries: Vec<String> = words.iter().map(|word| normalize(word)).filter(|word| !word.is_empty()).collect();
  if entries.len() < 2 {
    return text;
  }
  let body = text.trim_end();
  let mut tail = None;
  let mut chars = body.char_indices().peekable();
  while let Some((at, c)) = chars.next() {
    let wide = matches!(c, '。' | '！' | '？');
    if !wide && !matches!(c, '.' | '!' | '?') {
      continue;
    }
    let mut end = at + c.len_utf8();
    while let Some(&(next, space)) = chars.peek().filter(|(_, space)| space.is_whitespace()) {
      end = next + space.len_utf8();
      chars.next();
    }
    // "Node.js" stays a word, and the break must have a sentence after it.
    if (!wide && end == at + 1) || end >= body.len() || (c == '.' && no_full_stop(&body[..at])) {
      continue;
    }
    tail = Some(end);
  }
  let Some(start) = tail else { return text };
  let said: Option<Vec<usize>> =
    body[start..].split([',', '、', '，']).map(normalize).filter(|term| !term.is_empty()).map(|term| entries.iter().position(|entry| *entry == term)).collect();
  match said {
    Some(run) if run.len() >= 2 && run[0] == 0 && run.windows(2).all(|pair| pair[1] == pair[0] + 1) => body[..start].trim_end(),
    _ => text,
  }
}

/// The vocabulary words Whisper can be given, newest first.
pub fn entries(words: &[String]) -> impl Iterator<Item = &str> {
  words.iter().map(|word| word.trim()).filter(|word| !word.is_empty() && !word.contains('\0'))
}

/// The vocabulary as Whisper's prompt, and how many words it holds: a comma list, newest first, with as
/// many words as `fits`. It starts with a space, as the words would inside heard text.
pub fn prompt_text(words: &[String], fits: impl Fn(&str) -> bool) -> (String, usize) {
  let (mut text, mut count) = (String::new(), 0);
  for word in entries(words) {
    let next = if text.is_empty() { format!(" {word}") } else { format!("{text}, {word}") };
    if !fits(&next) {
      break;
    }
    (text, count) = (next, count + 1);
  }
  (text, count)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_vocabulary_prompt_is_newest_first_and_stays_under_its_budget() {
    let words: Vec<String> = ["Kubernetes", " ", "TabTasker", "İstanbul", "Can Turgut", "a\0b", "Vehicularis"].map(String::from).to_vec();
    assert_eq!(prompt_text(&words, |_| true), (" Kubernetes, TabTasker, İstanbul, Can Turgut, Vehicularis".into(), 5));
    // A budget keeps the newest words that fit, and never a part of one.
    assert_eq!(prompt_text(&words, |text| text.chars().count() <= 40), (" Kubernetes, TabTasker, İstanbul".into(), 3));
    assert_eq!(prompt_text(&words, |text| text.len() < 5), (String::new(), 0));
    assert_eq!(prompt_text(&[], |_| true), (String::new(), 0));
  }

  #[test]
  fn a_recited_vocabulary_is_told_from_a_sentence_that_uses_it() {
    let words: Vec<String> = ["Kubernetes", "Vercel", "TabTasker", "Maria Lopez"].iter().map(|word| word.to_string()).collect();
    assert!(echoes_prompt("Kubernetes, Vercel, TabTasker.", &words), "the list, in its order");
    assert!(echoes_prompt("Vercel Vercel Vercel", &words), "one word over and over");
    assert!(echoes_prompt("TabTasker,", &words), "a short run ending in a comma");
    assert!(!echoes_prompt("Deploy it to Vercel before Maria Lopez gets in.", &words), "a sentence using two of them");
    assert!(!echoes_prompt("Vercel", &words), "one vocabulary word said alone is a word");
    assert!(!echoes_prompt("Kubernetes, Vercel", &[]), "nothing to echo without a vocabulary");
  }

  #[test]
  fn a_strict_echo_is_always_heard_again_and_a_fragment_only_when_its_retry_could_count() {
    let words: Vec<String> = ["Kubernetes", "Vercel", "TabTasker", "Maria Lopez"].iter().map(|word| word.to_string()).collect();
    let (short, long) = (16_000, 4 * 16_000);
    // Nine in ten of its words are vocabulary and it uses seven in ten of the vocabulary.
    assert!(recites_prompt("Kubernetes, Vercel, TabTasker, Maria Lopez.", &words));
    assert!(recites_prompt("kubernetes vercel tabtasker maria", &words));
    assert!(!recites_prompt("Kubernetes, Vercel", &words), "two of five words is a sentence spelled from it");
    assert!(!recites_prompt("Deploy Kubernetes, Vercel, TabTasker and Maria Lopez now", &words));
    assert!(!recites_prompt("Kubernetes", &[]));
    let strict = Echo::of("Kubernetes, Vercel, TabTasker, Maria Lopez.", &words, short).unwrap();
    assert!(strict.strict);
    // A fragment: tried again when a word repeats or the clip is 3 s or longer, so its retry could be kept.
    assert_eq!(Echo::of("Vercel Vercel Vercel", &words, short), Some(Echo { strict: false, repeated: true, unique: 1 }));
    assert_eq!(Echo::of("TabTasker,", &words, short), None);
    assert_eq!(Echo::of("TabTasker,", &words, long), Some(Echo { strict: false, repeated: false, unique: 1 }));
    assert_eq!(Echo::of("Deploy it to Vercel.", &words, long), None, "a sentence is never an echo");
    // The retry is kept when it doesn't look like the prompt.
    assert!(strict.keeps("Ship the Vercel build", &words, short));
    assert!(strict.keeps("Vercel", &words, short), "a strict echo's retry may be one vocabulary word");
    assert!(!strict.keeps("Kubernetes, Vercel, TabTasker, Maria Lopez", &words, short));
    assert!(!strict.keeps("  ", &words, short));
    // A fragment's retry has to hear more: a word more than one that repeated, two more over 3 s.
    let looped = Echo::of("Vercel Vercel Vercel", &words, short).unwrap();
    assert!(looped.keeps("Vercel works", &words, short));
    assert!(!looped.keeps("Vercel", &words, short));
    assert!(!looped.keeps("Vercel, TabTasker,", &words, short), "a fragment again");
    let sparse = Echo::of("TabTasker,", &words, long).unwrap();
    assert!(sparse.keeps("TabTasker is up again", &words, long));
    assert!(!sparse.keeps("TabTasker works", &words, long));
  }

  #[test]
  fn the_vocabulary_recited_after_a_sentence_is_cut_off() {
    let words: Vec<String> = ["Kubernetes", "Vercel", "TabTasker"].iter().map(|word| word.to_string()).collect();
    let strip = |text: &str| without_recital(text, &words).to_owned();
    assert_eq!(strip("Ship it on Friday. Kubernetes, Vercel."), "Ship it on Friday.");
    assert_eq!(strip("Ship it on Friday! Kubernetes, Vercel, TabTasker"), "Ship it on Friday!");
    assert_eq!(strip("我们周五发布。Kubernetes, Vercel"), "我们周五发布。");
    assert_eq!(strip("Use Node.js. Kubernetes, Vercel."), "Use Node.js.");
    // What stays: a run from the middle of the list, one entry, a list out of order, or no sentence before it.
    assert_eq!(strip("Ship it on Friday. Vercel, TabTasker."), "Ship it on Friday. Vercel, TabTasker.");
    assert_eq!(strip("Ship it on Friday. Kubernetes."), "Ship it on Friday. Kubernetes.");
    assert_eq!(strip("Ship it on Friday. Kubernetes, TabTasker."), "Ship it on Friday. Kubernetes, TabTasker.");
    assert_eq!(strip("Ship it. Kubernetes, Vercel, and more"), "Ship it. Kubernetes, Vercel, and more");
    assert_eq!(strip("Kubernetes, Vercel."), "Kubernetes, Vercel.");
    // A period that ends no sentence doesn't start one.
    assert_eq!(strip("Ask Dr. Kubernetes, Vercel"), "Ask Dr. Kubernetes, Vercel");
    assert_eq!(strip("Plans, etc. Kubernetes, Vercel"), "Plans, etc. Kubernetes, Vercel");
    assert_eq!(strip("Wait... Kubernetes, Vercel"), "Wait... Kubernetes, Vercel");
    assert_eq!(strip("Siehe z.B. Kubernetes, Vercel"), "Siehe z.B. Kubernetes, Vercel");
    assert_eq!(strip("Point 2. Kubernetes, Vercel"), "Point 2. Kubernetes, Vercel");
    assert_eq!(without_recital("Ship it. Kubernetes, Vercel.", &words[..1]), "Ship it. Kubernetes, Vercel.", "one entry is no list");
  }
}
