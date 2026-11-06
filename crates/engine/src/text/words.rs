//! Replacements, fillers and the Casual and Formal styles, with the case rules of each language.
use super::Replacement;

// ---------- case, as the language has it: Turkish and Azerbaijani pair i with İ and ı with I ----------

pub(super) fn upper(c: char, turkish: bool) -> String {
  match c { 'i' if turkish => "İ".into(), _ => c.to_uppercase().collect() }
}
pub(super) fn lower(c: char, turkish: bool) -> String {
  // İ lowers to i and a combining dot outside Turkish; a plain i is what anyone means.
  match c { 'I' if turkish => "ı".into(), 'İ' => "i".into(), _ => c.to_lowercase().collect() }
}
/// One char standing for `c` when comparing without case.
pub(super) fn fold(c: char, turkish: bool) -> char { lower(c, turkish).chars().next().unwrap_or(c) }
pub(super) fn lowered(word: &str, turkish: bool) -> String { word.chars().map(|c| lower(c, turkish)).collect() }

/// `word` with a capital first letter when it is a plain lower-case word. A name like iPhone, an
/// address, a path or a number is left as it is.
pub(super) fn capitalize(word: &str, turkish: bool) -> String {
  let Some((at, first)) = word.char_indices().find(|(_, c)| c.is_alphanumeric()) else { return word.to_owned() };
  if !first.is_lowercase() || word.chars().any(|c| c.is_uppercase() || "@/\\:_".contains(c)) { return word.to_owned(); }
  format!("{}{}{}", &word[..at], upper(first, turkish), &word[at + first.len_utf8()..])
}

/// Whether `word` (with its punctuation) ends a sentence.
pub(super) fn ends_sentence(word: &str) -> bool {
  word.trim_end_matches(['"', '\'', '”', '’', ')', ']']).ends_with(['.', '?', '!', '…'])
}

/// The words of `text` with the whitespace before each, and the whitespace after the last.
pub(super) fn words(text: &str) -> (Vec<(&str, &str)>, &str) {
  let mut words = Vec::new();
  let mut rest = text;
  loop {
    let start = rest.find(|c: char| !c.is_whitespace()).unwrap_or(rest.len());
    if start == rest.len() { return (words, rest); }
    let end = rest[start..].find(char::is_whitespace).map_or(rest.len(), |end| start + end);
    words.push((&rest[..start], &rest[start..end]));
    rest = &rest[end..];
  }
}

/// A word's punctuation in front, the word, and its punctuation after: `“Um,` is `“`, `Um`, `,`.
pub(super) fn edges(word: &str) -> (&str, &str, &str) {
  let start = word.find(char::is_alphanumeric).unwrap_or(word.len());
  let end = word.rfind(char::is_alphanumeric).map_or(start, |end| end + word[end..].chars().next().map_or(0, char::len_utf8));
  (&word[..start], &word[start..end], &word[end..])
}

// ---------- replacements ----------

/// Whether the char at `at` carries a word on: a replacement matches only whole words, so "can" is
/// never found in "can't", "scan" or "example.can.com". A Turkish apostrophe starts a suffix of the
/// word before it, so "İstanbul'a" holds the word "İstanbul".
pub(super) fn joins(chars: &[char], at: usize, turkish: bool) -> bool {
  let c = chars[at];
  c.is_alphanumeric() || "_-@".contains(c) || (!turkish && "'’".contains(c))
    || (c == '.' && at > 0 && at + 1 < chars.len() && chars[at - 1].is_alphanumeric() && chars[at + 1].is_alphanumeric())
}

/// Where `from` (folded, one space between its words) matches `text` (folded) at `at`: any run of
/// whitespace in the text matches a space.
pub(super) fn matches_at(text: &[char], at: usize, from: &[char]) -> Option<usize> {
  let mut i = at;
  for &c in from {
    if c == ' ' {
      if !text.get(i).is_some_and(|c| c.is_whitespace()) { return None; }
      while text.get(i).is_some_and(|c| c.is_whitespace()) { i += 1; }
    } else {
      if text.get(i) != Some(&c) { return None; }
      i += 1;
    }
  }
  Some(i)
}

/// `text` with each phrase of `pairs` replaced: whole words, in any case, the longest phrase first, and
/// the punctuation around it kept. What a replacement types is never replaced again.
pub(super) fn replace(text: &str, pairs: &[Replacement], turkish: bool) -> String {
  let mut patterns: Vec<(Vec<char>, &str)> = pairs.iter()
    .map(|pair| (pair.from.split_whitespace().collect::<Vec<_>>().join(" ").chars().map(|c| fold(c, turkish)).collect::<Vec<_>>(), pair.to.as_str()))
    .filter(|(from, _)| !from.is_empty()).collect();
  if patterns.is_empty() { return text.to_owned(); }
  patterns.sort_by_key(|(from, _)| std::cmp::Reverse(from.len()));
  let chars: Vec<char> = text.chars().collect();
  let folded: Vec<char> = chars.iter().map(|&c| fold(c, turkish)).collect();
  let word = |c: char| c.is_alphanumeric() || "_'’-@".contains(c);
  let mut out = String::with_capacity(text.len());
  // Where a dropped phrase began a sentence, in `out`: the word after it takes the capital.
  let mut capitals = Vec::new();
  let mut at = 0;
  'scan: while at < chars.len() {
    let open = at == 0 || !joins(&chars, at - 1, turkish);
    for (from, to) in &patterns {
      if word(from[0]) && !open { continue; }
      let Some(end) = matches_at(&folded, at, from) else { continue };
      if word(from[from.len() - 1]) && end < chars.len() && joins(&chars, end, turkish) { continue; }
      let capital = chars[at].is_uppercase();
      at = end;
      if to.is_empty() {
        at = drop_phrase(&mut out, &chars, at);
        if capital && starts_sentence(&out) { capitals.push(out.len()); }
      } else {
        out.push_str(to);
      }
      continue 'scan;
    }
    out.push(chars[at]);
    at += 1;
  }
  for &mark in capitals.iter().rev() {
    if mark > out.len() || !out.is_char_boundary(mark) { continue; }
    let start = mark + out[mark..].len() - out[mark..].trim_start().len();
    let end = out[start..].find(char::is_whitespace).map_or(out.len(), |end| start + end);
    let word = capitalize(&out[start..end], turkish);
    out.replace_range(start..end, &word);
  }
  out
}

/// Whether the next word in `out` starts a sentence: nothing before it, a line break or a full stop.
fn starts_sentence(out: &str) -> bool {
  out.is_empty() || out.ends_with('\n') || ends_sentence(out)
}

/// Mends what a phrase replaced by nothing leaves, as dropping a filler does: `at` is just past it in
/// `chars`, and the answer is where the text goes on. Its space goes with it, and the commas around it;
/// a full stop it ended stays; at the start of the text or of a line, so does the space after it.
fn drop_phrase(out: &mut String, chars: &[char], mut at: usize) -> usize {
  out.truncate(out.trim_end_matches([' ', '\t']).len());
  let close = chars[at..].iter().take_while(|c| ",;:.?!…".contains(**c)).count();
  let end: String = chars[at..at + close].iter().filter(|c| ".?!…".contains(**c)).collect();
  at += close;
  if !end.is_empty() {
    out.truncate(out.trim_end_matches([',', ';', ':']).len());
    if !starts_sentence(out) { out.push_str(&end); }
  } else if close > 0 && out.ends_with([',', ';', ':']) {
    out.pop();
  }
  if out.is_empty() { while chars.get(at).is_some_and(|c| c.is_whitespace()) { at += 1; } }
  else if out.ends_with('\n') { while chars.get(at).is_some_and(|c| *c == ' ' || *c == '\t') { at += 1; } }
  at
}

// ---------- fillers ----------

/// Sounds that fill a pause, by language, with repeated letters squeezed ("ummm" is "um"). Each language
/// has its own because a filler in one is a word in another: "um" is "a" in Portuguese, "er" is "he" in
/// German. "Like" is never one: it is a word everywhere.
pub(super) fn fillers(language: Option<&str>) -> &'static [&'static str] {
  match language.unwrap_or("en") {
    "en" => &["um", "uh", "uhm", "er", "erm", "ah", "hm", "m"],
    "de" => &["äh", "ähm", "öh", "öhm", "hm", "m"],
    "fr" => &["euh", "heu", "hm", "m"],
    "es" => &["eh", "em", "ehm", "hm", "m"],
    "it" => &["eh", "ehm", "hm", "m"],
    "nl" => &["eh", "ehm", "uh", "uhm", "hm", "m"],
    "tr" | "az" => &["ı", "ıh", "ıhm", "e", "hm", "m"],
    _ => &["hm", "m"],
  }
}

fn squeeze(word: &str) -> String {
  let mut out = String::with_capacity(word.len());
  for c in word.chars() { if !out.ends_with(c) { out.push(c); } }
  out
}

/// A single letter is always a word ("e" is "and" in Italian), and "err" is the verb.
fn is_filler(core: &str, list: &[&str], turkish: bool) -> bool {
  let word = lowered(core, turkish);
  word.chars().count() >= 2 && word != "err" && list.contains(&squeeze(&word).as_str())
}

/// `text` without its filler sounds, mending what they leave: the commas around one, the full stop it
/// ended, the capital of a sentence it began, and the line break before it.
pub(super) fn drop_fillers(text: &str, list: &[&str], turkish: bool) -> String {
  let (all, trailing) = words(text);
  let lead = all.first().map_or("", |(space, _)| *space);
  let mut kept: Vec<(&str, String)> = Vec::new();
  let mut capital = false;
  let mut carried = String::new(); // punctuation that opened a dropped filler, such as a quote
  let mut gap = None;
  for (space, word) in all {
    let (open, core, close) = edges(word);
    if !core.is_empty() && is_filler(core, list, turkish) {
      let starts = kept.last().is_none_or(|(_, before)| ends_sentence(before));
      if let Some((_, before)) = kept.last_mut() {
        let end: String = close.chars().filter(|c| ".?!…".contains(*c)).collect();
        if !end.is_empty() {
          before.truncate(before.trim_end_matches([',', ';', ':']).len());
          if !ends_sentence(before) { before.push_str(&end); }
        } else if close.contains(',') && before.ends_with(',') {
          before.pop();
        }
      }
      capital |= starts && core.starts_with(char::is_uppercase);
      carried.push_str(open);
      if space.contains('\n') { gap = Some(space); }
      continue;
    }
    let mut word = format!("{carried}{word}");
    carried.clear();
    if std::mem::take(&mut capital) { word = capitalize(&word, turkish); }
    let space = if kept.is_empty() { lead } else { gap.unwrap_or(space) };
    gap = None;
    kept.push((space, word));
  }
  if kept.is_empty() { return String::new(); }
  kept.into_iter().map(|(space, word)| format!("{space}{word}")).collect::<String>() + trailing
}

// ---------- styles ----------

/// One sentence without its full stop, as in a chat; more than one keep theirs. An ellipsis stays.
pub(super) fn casual(text: &str) -> String {
  let body = text.trim_end();
  let single = !body.char_indices().any(|(at, c)| ".?!…".contains(c) && body[at + c.len_utf8()..].starts_with(char::is_whitespace));
  if single && body.ends_with('.') && !body.ends_with("..") { format!("{}{}", &body[..body.len() - 1], &text[body.len()..]) } else { text.to_owned() }
}

/// A capital to start and a full stop to end, unless it ends a sentence already. A live draft gets no
/// full stop yet, so its last word is not retyped with each new one.
pub(super) fn formal(text: &str, turkish: bool, live: bool) -> String {
  let start = text.find(|c: char| !c.is_whitespace()).unwrap_or(text.len());
  let end = text[start..].find(char::is_whitespace).map_or(text.len(), |end| start + end);
  let mut out = format!("{}{}{}", &text[..start], capitalize(&text[start..end], turkish), &text[end..]);
  if !live && out.chars().any(char::is_alphanumeric) {
    out.truncate(out.trim_end().trim_end_matches([',', ';', ':']).len());
    if !ends_sentence(&out) { out.push('.'); }
  }
  out
}
