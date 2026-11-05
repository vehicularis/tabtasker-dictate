//! The words after Whisper and before they are typed: vocabulary replacements, fillers and the app's
//! style. Drafts run through it too, so every rule keeps the words in their order: a draft is retyped
//! by the prefix it shares with the one before. Everything here is local and deterministic.
use crate::dictation::context::HoldContext;
use crate::settings::{self, Replacement, Style};
use std::ffi::{c_char, CStr, CString};

/// The text to type for `raw`, in the hold `ctx`; `live` for a draft while the key is still held.
pub fn finish(raw: &str, ctx: &HoldContext, live: bool) -> String {
  let settings = settings::get();
  let language = crate::dictation::speech::language(&ctx.request);
  let rules = Rules {
    style: settings.apps.style_for(&ctx.bundle_id).0, fillers: settings.dictation.remove_fillers,
    replacements: &settings.vocabulary.replacements, language: language.as_deref(), live,
  };
  rules.apply(raw)
}

/// `text` without a spoken "send" at its end ("send", "send it", "send message", with or without a stop),
/// and whether there was one: the person's way to send this one message, whatever the app's setting.
pub fn without_send(text: &str) -> (String, bool) {
  let trimmed = text.trim_end();
  let body = trimmed.trim_end_matches(['.', '!', '?', ',', '…']).trim_end();
  for phrase in ["send message", "send it", "send"] {
    let at = body.len().saturating_sub(phrase.len());
    // "send" alone is a word to type, not an order; a cut inside a letter ("Kapıyı kapat") can't be one
    if at == 0 || !body.is_char_boundary(at) { continue; }
    let (head, tail) = body.split_at(at);
    if tail.eq_ignore_ascii_case(phrase) && head.ends_with(|c: char| c.is_whitespace() || c == ',' || c == '.') {
      let kept = head.trim_end().trim_end_matches([',', ';', ':']).trim_end();
      if kept.is_empty() { continue; }
      // The sentence keeps its own stop, as it was said: "Thanks, Maria. Send." → "Thanks, Maria."
      return (kept.to_owned(), true);
    }
  }
  (text.to_owned(), false)
}

/// The words of a sticky said aloud instead of typed: "Sticky: call Thomas", "new sticky, buy milk" or
/// "make a sticky note call Thomas" answer "Call Thomas"; "sticky" alone an empty one. None when the text
/// isn't one (a word that merely starts with "sticky" is text).
pub fn sticky_words(text: &str) -> Option<String> {
  let text = text.trim();
  let lower = text.to_lowercase();
  let (lead, after) = ["make a sticky note", "make a sticky", "new sticky note", "new sticky", "sticky note", "sticky"].iter()
    .find_map(|lead| lower.strip_prefix(lead).map(|after| (lead.len(), after)))?;
  if after.chars().next().is_some_and(char::is_alphanumeric) || !text.is_char_boundary(lead) { return None; }
  let words = text[lead..].trim_start_matches(|c: char| c.is_whitespace() || matches!(c, ',' | ':' | '.' | '-' | '—' | '!')).trim();
  let mut chars = words.chars();
  Some(match chars.next() { Some(first) => first.to_uppercase().chain(chars).collect(), None => String::new() })
}

/// What the pipeline does to one hold's words. `language` is Whisper's code for them.
struct Rules<'a> { style: Style, fillers: bool, replacements: &'a [Replacement], language: Option<&'a str>, live: bool }

impl Rules<'_> {
  fn apply(&self, raw: &str) -> String {
    // Raw is Whisper as it heard you: none of your rules apply.
    if self.style == Style::Raw { return raw.to_owned(); }
    let turkish = matches!(self.language, Some("tr" | "az"));
    let mut text = replace(raw, self.replacements, turkish);
    if self.fillers { text = drop_fillers(&text, fillers(self.language), turkish); }
    match self.style {
      Style::Casual => casual(&text),
      Style::Formal => formal(&text, turkish, self.live),
      Style::Code => code(&text, turkish),
      Style::Default | Style::Raw => text,
    }
  }
}

// ---------- case, as the language has it: Turkish and Azerbaijani pair i with İ and ı with I ----------

fn upper(c: char, turkish: bool) -> String {
  match c { 'i' if turkish => "İ".into(), _ => c.to_uppercase().collect() }
}
fn lower(c: char, turkish: bool) -> String {
  // İ lowers to i and a combining dot outside Turkish; a plain i is what anyone means.
  match c { 'I' if turkish => "ı".into(), 'İ' => "i".into(), _ => c.to_lowercase().collect() }
}
/// One char standing for `c` when comparing without case.
fn fold(c: char, turkish: bool) -> char { lower(c, turkish).chars().next().unwrap_or(c) }
fn lowered(word: &str, turkish: bool) -> String { word.chars().map(|c| lower(c, turkish)).collect() }

/// `word` with a capital first letter when it is a plain lower-case word. A name like iPhone, an
/// address, a path or a number is left as it is.
fn capitalize(word: &str, turkish: bool) -> String {
  let Some((at, first)) = word.char_indices().find(|(_, c)| c.is_alphanumeric()) else { return word.to_owned() };
  if !first.is_lowercase() || word.chars().any(|c| c.is_uppercase() || "@/\\:_".contains(c)) { return word.to_owned(); }
  format!("{}{}{}", &word[..at], upper(first, turkish), &word[at + first.len_utf8()..])
}

/// Whether `word` (with its punctuation) ends a sentence.
fn ends_sentence(word: &str) -> bool {
  word.trim_end_matches(['"', '\'', '”', '’', ')', ']']).ends_with(['.', '?', '!', '…'])
}

/// The words of `text` with the whitespace before each, and the whitespace after the last.
fn words(text: &str) -> (Vec<(&str, &str)>, &str) {
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
fn edges(word: &str) -> (&str, &str, &str) {
  let start = word.find(char::is_alphanumeric).unwrap_or(word.len());
  let end = word.rfind(char::is_alphanumeric).map_or(start, |end| end + word[end..].chars().next().map_or(0, char::len_utf8));
  (&word[..start], &word[start..end], &word[end..])
}

// ---------- replacements ----------

/// Whether the char at `at` carries a word on: a replacement matches only whole words, so "can" is
/// never found in "can't", "scan" or "example.can.com". A Turkish apostrophe starts a suffix of the
/// word before it, so "İstanbul'a" holds the word "İstanbul".
fn joins(chars: &[char], at: usize, turkish: bool) -> bool {
  let c = chars[at];
  c.is_alphanumeric() || "_-@".contains(c) || (!turkish && "'’".contains(c))
    || (c == '.' && at > 0 && at + 1 < chars.len() && chars[at - 1].is_alphanumeric() && chars[at + 1].is_alphanumeric())
}

/// Where `from` (folded, one space between its words) matches `text` (folded) at `at`: any run of
/// whitespace in the text matches a space.
fn matches_at(text: &[char], at: usize, from: &[char]) -> Option<usize> {
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
fn replace(text: &str, pairs: &[Replacement], turkish: bool) -> String {
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
fn fillers(language: Option<&str>) -> &'static [&'static str] {
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
fn drop_fillers(text: &str, list: &[&str], turkish: bool) -> String {
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
fn casual(text: &str) -> String {
  let body = text.trim_end();
  let single = !body.char_indices().any(|(at, c)| ".?!…".contains(c) && body[at + c.len_utf8()..].starts_with(char::is_whitespace));
  if single && body.ends_with('.') && !body.ends_with("..") { format!("{}{}", &body[..body.len() - 1], &text[body.len()..]) } else { text.to_owned() }
}

/// A capital to start and a full stop to end, unless it ends a sentence already. A live draft gets no
/// full stop yet, so its last word is not retyped with each new one.
fn formal(text: &str, turkish: bool, live: bool) -> String {
  let start = text.find(|c: char| !c.is_whitespace()).unwrap_or(text.len());
  let end = text[start..].find(char::is_whitespace).map_or(text.len(), |end| start + end);
  let mut out = format!("{}{}{}", &text[..start], capitalize(&text[start..end], turkish), &text[end..]);
  if !live && out.chars().any(char::is_alphanumeric) {
    out.truncate(out.trim_end().trim_end_matches([',', ';', ':']).len());
    if !ends_sentence(&out) { out.push('.'); }
  }
  out
}

/// Whether a symbol joins the word before it, the word after it, both, or neither.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Fit { Spaced, Before, After, Both }

/// Symbols by what you say for them, with how each sits beside its neighbours.
const SYMBOLS: &[(&str, (&str, Fit))] = {
  use Fit::*;
  &[
    ("dot", (".", Both)), ("comma", (",", Before)), ("colon", (":", Before)), ("semicolon", (";", Before)), ("semi colon", (";", Before)),
    ("open paren", ("(", Both)), ("open parenthesis", ("(", Both)), ("open parentheses", ("(", Both)), ("left paren", ("(", Both)),
    ("close paren", (")", Before)), ("close parenthesis", (")", Before)), ("close parentheses", (")", Before)), ("right paren", (")", Before)),
    ("open bracket", ("[", Both)), ("open square bracket", ("[", Both)), ("left bracket", ("[", Both)),
    ("close bracket", ("]", Before)), ("close square bracket", ("]", Before)), ("right bracket", ("]", Before)),
    ("open brace", ("{", After)), ("open curly brace", ("{", After)), ("open curly", ("{", After)), ("left brace", ("{", After)),
    ("close brace", ("}", Before)), ("close curly brace", ("}", Before)), ("close curly", ("}", Before)), ("right brace", ("}", Before)),
    ("triple equals", ("===", Spaced)), ("double equals", ("==", Spaced)), ("not equals", ("!=", Spaced)),
    ("equals", ("=", Spaced)), ("equal sign", ("=", Spaced)), ("equals sign", ("=", Spaced)),
    ("plus", ("+", Spaced)), ("minus", ("-", Spaced)), ("fat arrow", ("=>", Spaced)), ("arrow", ("->", Spaced)),
    ("less than", ("<", Spaced)), ("greater than", (">", Spaced)),
    ("double ampersand", ("&&", Spaced)), ("ampersand", ("&", Spaced)), ("double pipe", ("||", Spaced)), ("pipe", ("|", Spaced)),
    ("slash", ("/", Both)), ("forward slash", ("/", Both)), ("backslash", ("\\", Both)), ("back slash", ("\\", Both)),
    ("underscore", ("_", Both)), ("hyphen", ("-", Both)), ("dash", ("-", After)),
    ("star", ("*", After)), ("asterisk", ("*", After)), ("at sign", ("@", Both)),
    ("hash", ("#", After)), ("hash sign", ("#", After)), ("pound sign", ("#", After)), ("dollar sign", ("$", After)),
    ("percent", ("%", Before)), ("percent sign", ("%", Before)), ("caret", ("^", Both)), ("tilde", ("~", After)),
    ("question mark", ("?", Before)), ("exclamation mark", ("!", Before)), ("exclamation point", ("!", Before)), ("bang", ("!", After)),
    ("new line", ("\n", Both)), ("newline", ("\n", Both)), ("new paragraph", ("\n\n", Both)),
  ]
};
/// Quotes open and close in turn.
const QUOTES: &[(&str, char)] = &[("quote", '"'), ("double quote", '"'), ("single quote", '\''), ("backtick", '`'), ("back tick", '`')];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Case { Camel, Pascal, Snake, Kebab, Constant, Upper, Lower }
/// Casing commands: the words after one, up to punctuation or a symbol, become one identifier.
const CASES: &[(&str, Case)] = &[
  ("camel case", Case::Camel), ("camelcase", Case::Camel), ("pascal case", Case::Pascal), ("pascalcase", Case::Pascal),
  ("snake case", Case::Snake), ("snakecase", Case::Snake), ("kebab case", Case::Kebab), ("kebabcase", Case::Kebab),
  ("constant case", Case::Constant), ("screaming snake case", Case::Constant),
  ("all caps", Case::Upper), ("all capitals", Case::Upper), ("lower case", Case::Lower), ("lowercase", Case::Lower),
];

/// The longest phrase of `table` said at the start of `words` (already plain), and how many words it took.
fn said<T: Copy>(words: &[String], table: &[(&str, T)]) -> Option<(T, usize)> {
  table.iter().filter_map(|&(phrase, value)| {
    let count = phrase.split(' ').count();
    (words.len() >= count && words[..count].iter().map(String::as_str).eq(phrase.split(' '))).then_some((value, count))
  }).max_by_key(|&(_, count)| count)
}

/// Code built a piece at a time, spaced unless a piece joins its neighbour.
#[derive(Default)]
struct Code { text: String, glued: bool }
impl Code {
  fn put(&mut self, piece: &str, fit: Fit) {
    if !self.text.is_empty() && !self.glued && !matches!(fit, Fit::Before | Fit::Both) { self.text.push(' '); }
    self.text.push_str(piece);
    self.glued = matches!(fit, Fit::After | Fit::Both);
  }
}

/// One identifier from `words` in `case`.
fn identifier(words: &[String], case: Case, turkish: bool) -> String {
  let lower: Vec<String> = words.iter().map(|word| lowered(word, turkish)).collect();
  let title = |word: &String| capitalize(word, turkish);
  let upper = |word: &String| word.chars().map(|c| upper(c, turkish)).collect::<String>();
  match case {
    Case::Camel => lower.iter().enumerate().map(|(i, word)| if i == 0 { word.clone() } else { title(word) }).collect(),
    Case::Pascal => lower.iter().map(title).collect(),
    Case::Snake => lower.join("_"),
    Case::Kebab => lower.join("-"),
    Case::Constant => lower.iter().map(upper).collect::<Vec<_>>().join("_"),
    Case::Upper => lower.iter().map(upper).collect::<Vec<_>>().join(" "),
    Case::Lower => lower.join(" "),
  }
}

/// Spoken code: symbols said by name and casing commands, with no capital Whisper gave the first word
/// and no full stop it put at the end. Whisper's other punctuation stays, so a question to a command
/// line assistant still reads as one.
fn code(text: &str, turkish: bool) -> String {
  let body = text.trim();
  let body = if body.ends_with('.') && !body.ends_with("..") { &body[..body.len() - 1] } else { body };
  let mut tokens: Vec<String> = body.split_whitespace().map(String::from).collect();
  if let Some(first) = tokens.first_mut() {
    let (open, core, _) = edges(first);
    let mut letters = core.chars();
    if letters.next().is_some_and(char::is_uppercase) && letters.clone().next().is_some() && letters.all(char::is_lowercase) {
      let capital = core.chars().next().unwrap_or_default();
      *first = format!("{open}{}{}", lower(capital, turkish), &first[open.len() + capital.len_utf8()..]);
    }
  }
  let plain: Vec<String> = tokens.iter().map(|token| edges(token).1.to_lowercase()).collect();
  let mut out = Code::default();
  let mut open = [false; 3];
  let mut at = 0;
  while at < tokens.len() {
    if let Some((case, used)) = said(&plain[at..], CASES) {
      at += used;
      let (mut parts, mut close) = (Vec::new(), "");
      while at < tokens.len() && said(&plain[at..], SYMBOLS).is_none() && said(&plain[at..], CASES).is_none() && said(&plain[at..], QUOTES).is_none() {
        let (_, core, after) = edges(&tokens[at]);
        parts.extend(core.split(|c: char| !c.is_alphanumeric()).filter(|part| !part.is_empty()).map(String::from));
        at += 1;
        if !after.is_empty() { close = after; break; }
      }
      if !parts.is_empty() { out.put(&format!("{}{close}", identifier(&parts, case, turkish)), Fit::Spaced); }
    } else if let Some((quote, used)) = said(&plain[at..], QUOTES) {
      let which = ['"', '\'', '`'].iter().position(|&c| c == quote).unwrap_or(0);
      out.put(&quote.to_string(), if open[which] { Fit::Before } else { Fit::After });
      open[which] = !open[which];
      at += used;
    } else if let Some(((text, fit), used)) = said(&plain[at..], SYMBOLS) {
      out.put(text, fit);
      at += used;
    } else {
      out.put(&tokens[at], Fit::Spaced);
      at += 1;
    }
  }
  out.text
}

// ---------- learning from corrections ----------

/// The word the person typed over a dictated one. `before` is the field as dictated, `after` as it is
/// now, and `dictated` the dictated words' range in `before`, in chars. One to three dictated words
/// replaced by one word is a correction; new words typed after them, a rewritten sentence or deleted
/// words are not. Answers the word and whether it reads as a name: a capital inside it, a digit, or a
/// capital where no sentence starts.
fn correction(before: &str, after: &str, dictated: std::ops::Range<usize>) -> Option<(String, bool)> {
  let (b, a): (Vec<char>, Vec<char>) = (before.chars().collect(), after.chars().collect());
  let (prefix, suffix) = unchanged(&b, &a);
  let (b_end, a_end) = (b.len() - suffix, a.len() - suffix);
  if b_end < dictated.start || prefix > dictated.end { return None; } // an edit somewhere else
  let mut start = prefix;
  while start > 0 && word(&b[start - 1]) { start -= 1; }
  let (mut b_stop, mut a_stop) = (b_end, a_end);
  while b_stop < b.len() && word(&b[b_stop]) { b_stop += 1; a_stop += 1; }
  if start < dictated.start || b_stop > dictated.end { return None; }
  let trim = |chars: &[char]| chars.iter().collect::<String>().trim_matches(|c: char| !word(&c)).to_owned();
  let (old, mut new) = (trim(&b[start..b_stop]), trim(&a[start..a_stop]));
  let words = old.split_whitespace().count();
  // Only deleting is a correction inside one word ("Kuberneetes"), never across words.
  if words == 0 || words > 3 || (a_end <= prefix && words > 1) { return None; }
  // A name's suffix after an apostrophe is not part of it: "İstanbul'a", "Kubernetes's".
  if let Some(at) = new.find(['\'', '’']).filter(|&at| new.starts_with(char::is_uppercase) && new[..at].chars().count() >= 2) { new.truncate(at); }
  if new.chars().any(|c| !word(&c)) || !(2..=64).contains(&new.chars().count()) || !new.chars().any(char::is_alphabetic) || old == new { return None; }
  let opens = a[..start].iter().rev().find(|c| **c != ' ' && **c != '\t').is_none_or(|c| ".?!…\n\r".contains(*c));
  let named = new.chars().skip(1).any(char::is_uppercase) || new.chars().any(|c| c.is_ascii_digit())
    || (new.starts_with(char::is_uppercase) && !opens);
  // A change of case alone is worth learning only as a name: "can" to "Can".
  if old.to_lowercase() == new.to_lowercase() && !named { return None; }
  Some((new, named))
}

/// A char of a word as corrections see it: a name may hold an apostrophe, a hyphen or an underscore.
fn word(c: &char) -> bool { c.is_alphanumeric() || "'’-_".contains(*c) }

/// How many chars `before` and `after` share at the start, and then at the end.
fn unchanged(b: &[char], a: &[char]) -> (usize, usize) {
  let prefix = b.iter().zip(a).take_while(|(x, y)| x == y).count();
  (prefix, b[prefix..].iter().rev().zip(a[prefix..].iter().rev()).take_while(|(x, y)| x == y).count())
}

/// Whether the caret, at char `caret` of `after`, is still in a word of the edit: the person may be
/// typing it yet, so a pause there is not the end of the correction.
fn typing(before: &str, after: &str, caret: usize) -> bool {
  let (b, a): (Vec<char>, Vec<char>) = (before.chars().collect(), after.chars().collect());
  let (prefix, suffix) = unchanged(&b, &a);
  let (mut start, mut end) = (prefix, a.len() - suffix);
  while start > 0 && word(&a[start - 1]) { start -= 1; }
  while end < a.len() && word(&a[end]) { end += 1; }
  (start + 1..=end).contains(&caret) && word(&a[caret - 1])
}

fn read(text: *const c_char) -> Option<String> {
  (!text.is_null()).then(|| unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned())
}

/// AppKit's UTF-16 offsets as char offsets in `text`.
fn chars_at(text: &str, start: usize, length: usize) -> std::ops::Range<usize> {
  let (mut units, mut from, mut to) = (0, None, None);
  for (i, c) in text.chars().enumerate() {
    if from.is_none() && units >= start { from = Some(i); }
    if to.is_none() && units >= start + length { to = Some(i); }
    units += c.len_utf16();
  }
  let count = text.chars().count();
  from.unwrap_or(count)..to.unwrap_or(count)
}

/// learn.m's question about a field that changed after a dictation (see `correction`), with the
/// dictated range in UTF-16 units: writes the word into `word` and answers 0 for none, 1 for a word,
/// 2 for one that reads as a name.
#[no_mangle]
extern "C" fn dictate_correction(before: *const c_char, after: *const c_char, start: usize, length: usize, word: *mut c_char, capacity: usize) -> i32 {
  let (Some(before), Some(after)) = (read(before), read(after)) else { return 0 };
  if word.is_null() || capacity == 0 { return 0; }
  let Some((found, named)) = correction(&before, &after, chars_at(&before, start, length)) else { return 0 };
  let bytes = found.as_bytes();
  if bytes.len() >= capacity { return 0; }
  // The word and its NUL fit in the caller's `capacity` bytes.
  unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), word.cast(), bytes.len()); *word.add(bytes.len()) = 0; }
  if named { 2 } else { 1 }
}

/// learn.m's question before it learns from a pause: whether the caret, at UTF-16 offset `caret` of
/// `after`, is still in the word being typed over the dictated ones.
#[no_mangle]
extern "C" fn dictate_learn_typing(before: *const c_char, after: *const c_char, caret: usize) -> bool {
  let (Some(before), Some(after)) = (read(before), read(after)) else { return false };
  typing(&before, &after, chars_at(&after, caret, 0).start)
}

/// Live typing types a word once two passes in a row have heard it in the same place, so the field only grows
/// while the key is held: what the passes still disagree on (the last word or two, as a rule) waits in the orb,
/// and release puts the finished words in at once. A typed word one pass hears differently stays as it is; once
/// two in a row agree on the new hearing (after a pause Whisper often hears "it is" as "it's", or drops a
/// repeat), the field is put right from that word and carries on, rather than stopping there. Given what is
/// typed, the last pass's words and this one's: the field's new words, or None to leave it. The last typed
/// word takes the punctuation it has gained once a word follows it; the last word of all goes in without the
/// stop or comma that may yet move.
pub fn live_next(typed: &str, previous: &str, now: &str) -> Option<String> {
  let key = |word: &str| word.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect::<String>();
  let common = |one: &[&str], other: &[&str]| one.iter().zip(other).take_while(|(a, b)| key(a) == key(b)).count();
  let typed: Vec<&str> = typed.split_whitespace().collect();
  let before: Vec<&str> = previous.split_whitespace().collect();
  let heard: Vec<&str> = now.split_whitespace().collect();
  let agreed = common(&before, &heard);
  let kept = common(&typed, &heard);
  if agreed <= kept { return None; } // nothing agreed past what is typed and still heard there
  let mut words: Vec<String> = typed[..kept].iter().map(|word| word.to_string()).collect();
  if let Some(last) = words.last_mut() {
    let gained = heard[kept - 1].strip_prefix(last.as_str()).unwrap_or("");
    if gained.chars().all(|c| !c.is_alphanumeric()) { last.push_str(gained); }
  }
  words.extend(heard[kept..agreed].iter().map(|word| word.to_string()));
  let mut text = words.join(" ");
  text.truncate(text.trim_end_matches(['.', ',', '!', '?', ';', ':', '…']).len());
  (text != typed.join(" ")).then_some(text)
}

/// live_next for dictate.m: the field's new words in the caller's `capacity` bytes and their length, or 0 to
/// leave the field as it is (or when they wouldn't fit).
#[no_mangle]
extern "C" fn dictate_live_next(typed: *const c_char, previous: *const c_char, now: *const c_char, out: *mut c_char, capacity: usize) -> usize {
  let (Some(typed), Some(previous), Some(now)) = (read(typed), read(previous), read(now)) else { return 0 };
  let Some(next) = live_next(&typed, &previous, &now) else { return 0 };
  if out.is_null() || next.is_empty() || next.len() >= capacity { return 0; }
  // The words and their NUL fit in the caller's `capacity` bytes.
  unsafe { std::ptr::copy_nonoverlapping(next.as_ptr(), out.cast(), next.len()); *out.add(next.len()) = 0; }
  next.len()
}

/// A word learned from a correction: it waits in Settings › Vocabulary and the overlay offers it. It is
/// only ever added to the words on a yes.
#[no_mangle]
extern "C" fn dictate_learned(word: *const c_char) {
  let (Some(app), Some(word)) = (crate::dictation::speech::app(), read(word)) else { return };
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    use tauri::Emitter;
    let vocabulary = settings::get().vocabulary;
    let same = |other: &String| other.to_lowercase() == word.to_lowercase();
    if !vocabulary.learn || vocabulary.words.iter().any(same) { return; }
    if !vocabulary.suggestions.iter().any(same) {
      let suggestions: Vec<String> = std::iter::once(word.clone()).chain(vocabulary.suggestions).collect();
      if let Err(e) = settings::update(&app, &serde_json::json!({ "vocabulary": { "suggestions": suggestions } })) { log::warn!("vocabulary: {e}"); return; }
    }
    let _ = app.emit_to("overlay", "dictate-learned", serde_json::json!({ "word": word }));
  });
}

// ---------- the apps to give a style ----------

extern "C" {
  fn dictate_apps(known: *const c_char) -> *mut c_char;
  fn dictate_free(text: *mut c_char);
}

/// The apps running now and those used in the last month, and the installed apps among `known`, each
/// with its name and icon, for App styles.
#[tauri::command]
pub async fn list_apps(known: Vec<String>) -> Result<serde_json::Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let known = CString::new(serde_json::to_string(&known).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let raw = unsafe { dictate_apps(known.as_ptr()) };
    if raw.is_null() { return Err("Couldn’t get the list of your apps.".to_owned()); }
    let json = unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned();
    unsafe { dictate_free(raw) };
    serde_json::from_str(&json).map_err(|e| e.to_string())
  }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  #[test]
  fn live_typing_types_what_two_passes_agree_on_and_recovers_from_a_pause() {
    use super::live_next;
    let next = |typed, previous, now| live_next(typed, previous, now).unwrap_or_else(|| "(as it is)".into());
    // The first pass alone agrees with nothing.
    assert_eq!(next("", "", "Call the"), "(as it is)");
    // Two passes agree on "Call": typed; the word still moving waits.
    assert_eq!(next("", "Call the", "Call Maria"), "Call");
    assert_eq!(next("Call", "Call Maria at", "Call Maria at three"), "Call Maria at");
    // The last word goes in without its comma or stop, which it gains once the next word is agreed.
    assert_eq!(next("", "Hello, how", "Hello, how are"), "Hello, how");
    assert_eq!(next("Hello, how", "Hello, how are you.", "Hello, how are you. I"), "Hello, how are you");
    assert_eq!(next("Hello, how are you", "Hello, how are you. I'm", "Hello, how are you. I'm fine"), "Hello, how are you. I'm");
    // Case and punctuation don't stop words agreeing.
    assert_eq!(next("", "hello there friend", "Hello, there friend"), "Hello, there friend");
    // One pass hearing a typed word differently erases nothing.
    assert_eq!(next("Call Maria at", "Call Maria at three", "Call Maria about three"), "(as it is)");
    // Two in a row: the field is put right from that word, and carries on.
    assert_eq!(next("Call Maria at", "Call Maria about three", "Call Maria about three tomorrow"), "Call Maria about three");
    // After a pause, "it is" heard as "it's" by two passes: put right, not stuck there for the rest of the hold.
    assert_eq!(next("It is good but", "It's good, but I", "It's good, but I think"), "It's good, but I");
    // A repeat one pass drops and the next keeps: nothing moves until two agree.
    assert_eq!(next("it is good", "it is it is good", "it is good and"), "(as it is)");
    // Words in another script agree by their own letters, and go in as the newer pass has them.
    assert_eq!(next("", "Öğle yemeği", "öğle yemeği yiyelim"), "öğle yemeği");
  }

  use super::*;

  #[test]
  fn a_sticky_said_aloud_is_told_from_text() {
    assert_eq!(sticky_words("Sticky: call Thomas tomorrow."), Some("Call Thomas tomorrow.".into()));
    assert_eq!(sticky_words("new sticky, buy milk"), Some("Buy milk".into()));
    assert_eq!(sticky_words("Make a sticky note — ask Maria about the venue"), Some("Ask Maria about the venue".into()));
    assert_eq!(sticky_words("sticky"), Some(String::new()), "an empty sticky to type into");
    assert_eq!(sticky_words("Stickyback tape is on the list"), None, "a word that starts with it");
    assert_eq!(sticky_words("The sticky situation"), None);
    assert_eq!(sticky_words("Call Thomas"), None);
  }

  #[test]
  fn a_spoken_send_at_the_end_is_an_order_not_a_word() {
    assert_eq!(without_send("Thanks, Maria. Send."), ("Thanks, Maria.".into(), true));
    assert_eq!(without_send("see you at ten send it"), ("see you at ten".into(), true));
    assert_eq!(without_send("On my way, send message!"), ("On my way".into(), true));
    assert_eq!(without_send("Please send the file"), ("Please send the file".into(), false));
    assert_eq!(without_send("send"), ("send".into(), false));
    assert_eq!(without_send("Godsend"), ("Godsend".into(), false));
    assert_eq!(without_send("Thursday works."), ("Thursday works.".into(), false));
    assert_eq!(without_send("Kapıyı kapat"), ("Kapıyı kapat".into(), false));
  }

  fn pair(from: &str, to: &str) -> Replacement { Replacement { from: from.into(), to: to.into() } }
  fn run(raw: &str, style: Style, language: &str, replacements: &[Replacement]) -> String {
    Rules { style, fillers: true, replacements, language: Some(language), live: false }.apply(raw)
  }
  fn plain(raw: &str) -> String { run(raw, Style::Default, "en", &[]) }

  #[test]
  fn replacements_match_whole_words_in_any_case_and_keep_punctuation() {
    let pairs = [pair("my email", "can@example.com"), pair("tabtasker", "TabTasker"), pair("can", "Can")];
    let replace = |text: &str| run(text, Style::Default, "en", &pairs);
    assert_eq!(replace("Send it to my email."), "Send it to can@example.com.");
    assert_eq!(replace("My Email, please"), "can@example.com, please");
    assert_eq!(replace("(my email)"), "(can@example.com)");
    assert_eq!(replace("“my email”?"), "“can@example.com”?");
    assert_eq!(replace("my\temail"), "can@example.com"); // any whitespace between the words
    assert_eq!(replace("Try Tabtasker! tabtasker's fine"), "Try TabTasker! tabtasker's fine");
    // Never inside a word, a contraction, an address or a domain.
    assert_eq!(replace("I can't scan it"), "I can't scan it");
    assert_eq!(replace("see example.can.com"), "see example.can.com");
    assert_eq!(replace("can, can. can"), "Can, Can. Can");
    // What a replacement typed is not replaced again, and the longest phrase wins.
    let chain = [pair("a", "b"), pair("b", "c"), pair("a b", "x")];
    assert_eq!(run("a b a", Style::Default, "en", &chain), "x b");
    // A phrase replaced by nothing is mended like a filler: no stray space, comma or lost capital.
    let gone = [pair("you know", "")];
    let drop = |text: &str| run(text, Style::Default, "en", &gone);
    assert_eq!(drop("It is, you know, fine"), "It is fine");
    assert_eq!(drop("It is you know, fine"), "It is fine");
    assert_eq!(drop("you know it works"), "it works");
    assert_eq!(drop("it works you know."), "it works.");
    assert_eq!(drop("It works, you know."), "It works.");
    assert_eq!(drop("You know, it works."), "It works.");
    assert_eq!(drop("It works. You know, it does."), "It works. It does.");
    assert_eq!(drop("Well, you know..."), "Well...");
    assert_eq!(drop("Line one.\nyou know it works"), "Line one.\nit works");
    assert_eq!(drop("Line one.\nYou know, it works"), "Line one.\nIt works");
    assert_eq!(drop("You know."), "");
    // The word after keeps its own case when it is a name, an address or another replacement's.
    assert_eq!(run("You know, my email works", Style::Default, "en", &[pair("you know", ""), pair("my email", "can@example.com")]), "can@example.com works");
    assert_eq!(drop("You know, iPhone sales"), "iPhone sales");
  }

  #[test]
  fn replacements_fold_case_the_turkish_way_for_turkish() {
    let pairs = [pair("istanbul", "İstanbul"), pair("ığdır", "Iğdır")];
    assert_eq!(run("İSTANBUL'a gittik", Style::Default, "tr", &pairs), "İstanbul'a gittik"); // the suffix stays
    assert_eq!(run("İSTANBUL gittik", Style::Default, "tr", &pairs), "İstanbul gittik");
    // In Turkish I is the capital of ı, so ISTANBUL is not İstanbul; elsewhere it is.
    assert_eq!(run("ISTANBUL gittik", Style::Default, "tr", &pairs), "ISTANBUL gittik");
    assert_eq!(run("ISTANBUL trip", Style::Default, "en", &pairs), "İstanbul trip");
    assert_eq!(run("IĞDIR yolu", Style::Default, "tr", &pairs), "Iğdır yolu");
    assert_eq!(run("iğdir yolu", Style::Default, "tr", &pairs), "iğdir yolu"); // dotted i is another letter
  }

  #[test]
  fn fillers_go_without_breaking_capitals_commas_or_spacing() {
    assert_eq!(plain("Um, I think so."), "I think so.");
    assert_eq!(plain("Um, so we go."), "So we go.");
    assert_eq!(plain("I, uh, think so."), "I think so.");
    assert_eq!(plain("So um yeah."), "So yeah.");
    assert_eq!(plain("Er, hmm, ah, right."), "Right.");
    assert_eq!(plain("Ummm, uhh, mm okay"), "Okay");
    assert_eq!(plain("We should, um. Go now."), "We should. Go now.");
    assert_eq!(plain("Well uh..."), "Well...");
    assert_eq!(plain("Hmm."), "");
    assert_eq!(plain("Hello.\nUm, next line"), "Hello.\nNext line");
    assert_eq!(plain("“Um, hello,” she said"), "“Hello,” she said");
    assert_eq!(plain("Um, iPhone first"), "iPhone first");
    // Words that only look like fillers stay.
    assert_eq!(plain("I like it, like, a lot."), "I like it, like, a lot.");
    assert_eq!(plain("Uh-huh, err on the side of caution"), "Uh-huh, err on the side of caution");
    assert_eq!(plain("Plan A, then B"), "Plan A, then B");
    // Off, they stay.
    assert_eq!(Rules { style: Style::Default, fillers: false, replacements: &[], language: Some("en"), live: false }.apply("Um, hi"), "Um, hi");
  }

  #[test]
  fn fillers_are_the_language_s_own() {
    assert_eq!(run("Um carro, uh, bom", Style::Default, "pt", &[]), "Um carro, uh, bom"); // "um" is "a" in Portuguese
    assert_eq!(run("Er sagt, äh, nein", Style::Default, "de", &[]), "Er sagt nein"); // "er" is "he" in German
    assert_eq!(run("Äh, über alles", Style::Default, "de", &[]), "Über alles");
    assert_eq!(run("Euh, je pense", Style::Default, "fr", &[]), "Je pense");
    // Turkish: the capital of i is İ, and of ı is I.
    assert_eq!(run("Eee, istanbul'a gittik.", Style::Default, "tr", &[]), "İstanbul'a gittik.");
    assert_eq!(run("Iıı, ılık su", Style::Default, "tr", &[]), "Ilık su");
    assert_eq!(run("Ee, e mi?", Style::Default, "tr", &[]), "E mi?");
  }

  #[test]
  fn casual_drops_the_last_full_stop_of_one_sentence_only() {
    assert_eq!(run("See you soon.", Style::Casual, "en", &[]), "See you soon");
    assert_eq!(run("See you soon. Bye.", Style::Casual, "en", &[]), "See you soon. Bye.");
    assert_eq!(run("Really?", Style::Casual, "en", &[]), "Really?");
    assert_eq!(run("Well...", Style::Casual, "en", &[]), "Well...");
    assert_eq!(run("OK then", Style::Casual, "en", &[]), "OK then");
  }

  #[test]
  fn formal_starts_with_a_capital_and_ends_with_a_full_stop() {
    assert_eq!(run("thanks for the update", Style::Formal, "en", &[]), "Thanks for the update.");
    assert_eq!(run("Is it ready?", Style::Formal, "en", &[]), "Is it ready?");
    assert_eq!(run("see the notes (attached)", Style::Formal, "en", &[]), "See the notes (attached).");
    assert_eq!(run("and then,", Style::Formal, "en", &[]), "And then.");
    assert_eq!(run("iPhone sales are up", Style::Formal, "en", &[]), "iPhone sales are up.");
    assert_eq!(run("istanbul'dan selamlar", Style::Formal, "tr", &[]), "İstanbul'dan selamlar.");
    assert_eq!(run("ılık bir gün", Style::Formal, "tr", &[]), "Ilık bir gün.");
    assert_eq!(run("istanbul trip", Style::Formal, "en", &[]), "Istanbul trip.");
    assert_eq!(run("über den Fluss", Style::Formal, "de", &[]), "Über den Fluss.");
    assert_eq!(run("", Style::Formal, "en", &[]), "");
    // A live draft gets its capital but not yet its full stop.
    assert_eq!(Rules { style: Style::Formal, fillers: true, replacements: &[], language: Some("en"), live: true }.apply("thanks for"), "Thanks for");
    // An address a replacement typed is never capitalized.
    assert_eq!(run("my email is mine", Style::Formal, "en", &[pair("my email", "can@example.com")]), "can@example.com is mine.");
  }

  #[test]
  fn code_turns_spoken_symbols_and_casing_into_code() {
    let code = |text: &str| run(text, Style::Code, "en", &[]);
    assert_eq!(code("Camel case user name"), "userName");
    assert_eq!(code("Snake case get user name open paren close paren."), "get_user_name()");
    assert_eq!(code("kebab case main nav bar"), "main-nav-bar");
    assert_eq!(code("pascal case user profile dot tsx"), "UserProfile.tsx");
    assert_eq!(code("constant case max retries equals five"), "MAX_RETRIES = five");
    assert_eq!(code("all caps readme dot md"), "README.md");
    assert_eq!(code("Git commit dash m quote fix the build quote."), "git commit -m \"fix the build\"");
    assert_eq!(code("npm install dash dash save dev"), "npm install --save dev");
    assert_eq!(code("if x double equals y open brace new line return true new line close brace"), "if x == y {\nreturn true\n}");
    assert_eq!(code("cd tilde slash projects"), "cd ~/projects");
    assert_eq!(code("ls star dot ts"), "ls *.ts");
    assert_eq!(code("user at sign example dot com"), "user@example.com");
    assert_eq!(code("print open paren x comma y close paren"), "print(x, y)");
    assert_eq!(code("camel case user-name, then"), "userName, then");
    // No capital Whisper gave the first word, but names and acronyms keep theirs.
    assert_eq!(code("Run the tests"), "run the tests");
    assert_eq!(code("README first"), "README first");
    assert_eq!(code("Can you fix the bug?"), "can you fix the bug?");
    // Turkish casing in an identifier.
    assert_eq!(run("camel case kullanıcı isim", Style::Code, "tr", &[]), "kullanıcıİsim");
    assert_eq!(run("all caps istanbul", Style::Code, "tr", &[]), "İSTANBUL");
  }

  #[test]
  fn raw_is_whisper_as_it_heard_you() {
    assert_eq!(run("Um, my email.", Style::Raw, "en", &[pair("my email", "x@y.z")]), "Um, my email.");
  }

  #[test]
  fn drafts_keep_the_words_in_their_order() {
    for style in [Style::Default, Style::Casual, Style::Formal, Style::Code] {
      let rules = Rules { style, fillers: true, replacements: &[], language: Some("en"), live: true };
      let (one, two) = (rules.apply("um so we"), rules.apply("um so we should go"));
      assert!(two.starts_with(&one), "{style:?}: {one:?} then {two:?}");
    }
  }

  #[test]
  fn a_correction_is_one_dictated_word_typed_over() {
    let field = "Notes: deploy to Cooper Nettis today";
    let dictated = 7..field.chars().count();
    let fix = |after: &str| correction(field, after, dictated.clone());
    assert_eq!(fix("Notes: deploy to Kubernetes today"), Some(("Kubernetes".into(), true)));
    assert_eq!(fix("Notes: deploy to kubernetes today"), Some(("kubernetes".into(), false)));
    // A word changed only in case is learned as a name, not where a sentence starts.
    assert_eq!(correction("we met can today", "we met Can today", 0..16), Some(("Can".into(), true)));
    assert_eq!(correction("can we go", "Can we go", 0..9), None);
    // Letters added to or taken from one word.
    assert_eq!(correction("ask Kubernete", "ask Kubernetes", 0..13), Some(("Kubernetes".into(), true)));
    assert_eq!(correction("ask Kuberneetes", "ask Kubernetes", 0..15), Some(("Kubernetes".into(), true)));
    // Not corrections: words typed after, a full stop, deleted words, a sentence rewritten, an edit outside.
    assert_eq!(fix("Notes: deploy to Cooper Nettis today and tomorrow"), None);
    assert_eq!(fix("Notes: deploy to Cooper Nettis today."), None);
    assert_eq!(fix("Notes: deploy to today"), None);
    assert_eq!(fix("Notes: ship it now"), None);
    assert_eq!(fix("Draft: deploy to Cooper Nettis today"), None);
    assert_eq!(fix(field), None);
    // Unicode: AppKit's UTF-16 offsets, and a Turkish name without its suffix.
    let field = "🙂 gittik istanbul'a";
    let range = chars_at(field, 3, 17);
    assert_eq!(range, 2..19);
    assert_eq!(correction(field, "🙂 gittik İstanbul'a", range), Some(("İstanbul".into(), true)));
  }

  #[test]
  fn a_pause_inside_the_word_being_typed_is_not_the_end_of_it() {
    let field = "deploy to Cooper Nettis today";
    // Typing over the last words: half a word, then all of it, with the caret after it.
    assert!(typing("deploy to Cooper Nettis", "deploy to Kube", 14));
    assert!(typing("deploy to Cooper Nettis", "deploy to Kubernetes", 20));
    // Typed over a word in the middle, the caret still in or after it, even where the new word ends
    // like the old one did.
    assert!(typing(field, "deploy to Kubernetes today", 20));
    assert!(typing(field, "deploy to Kubernetes today", 15));
    // The caret moved on: to the end, to the start, or past a space typed after the word.
    assert!(!typing(field, "deploy to Kubernetes today", 26));
    assert!(!typing(field, "deploy to Kubernetes today", 0));
    assert!(!typing("deploy to Cooper Nettis", "deploy to Kubernetes ", 21));
    // Out of range, or no edit at all.
    assert!(!typing(field, "deploy to Kubernetes today", 99));
    assert!(!typing(field, field, 20));
    // The native side counts in UTF-16.
    let (before, after) = (CString::new("🙂 to Cooper").unwrap(), CString::new("🙂 to Kube").unwrap());
    assert!(dictate_learn_typing(before.as_ptr(), after.as_ptr(), 10));
    assert!(!dictate_learn_typing(before.as_ptr(), after.as_ptr(), 2));
  }

  #[test]
  fn the_native_side_gets_the_word_in_its_buffer() {
    let (before, after) = (CString::new("deploy to Cooper Nettis").unwrap(), CString::new("deploy to kubernetes").unwrap());
    let mut word = [0 as c_char; 64];
    assert_eq!(dictate_correction(before.as_ptr(), after.as_ptr(), 0, 23, word.as_mut_ptr(), word.len()), 1);
    assert_eq!(unsafe { CStr::from_ptr(word.as_ptr()) }.to_str().unwrap(), "kubernetes");
    let named = CString::new("deploy to Kubernetes").unwrap();
    assert_eq!(dictate_correction(before.as_ptr(), named.as_ptr(), 0, 23, word.as_mut_ptr(), word.len()), 2);
    let mut small = [0 as c_char; 4];
    assert_eq!(dictate_correction(before.as_ptr(), after.as_ptr(), 0, 23, small.as_mut_ptr(), small.len()), 0);
    assert_eq!(dictate_correction(std::ptr::null(), after.as_ptr(), 0, 23, word.as_mut_ptr(), word.len()), 0);
  }

  #[test]
  fn apps_come_with_names_and_icons() {
    let known = CString::new(r#"["com.apple.Terminal", "com.example.not-installed"]"#).unwrap();
    let started = std::time::Instant::now();
    let raw = unsafe { dictate_apps(known.as_ptr()) };
    assert!(!raw.is_null());
    let json = unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned();
    unsafe { dictate_free(raw) };
    let apps: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();
    println!("{} apps, {} bytes, in {:?}", apps.len(), json.len(), started.elapsed());
    let terminal = apps.iter().find(|app| app["bundleId"] == "com.apple.Terminal").expect("Terminal is on every Mac");
    assert_eq!(terminal["name"], "Terminal");
    assert!(terminal["icon"].as_str().is_some_and(|icon| icon.starts_with("data:image/png;base64,")));
    assert!(apps.iter().all(|app| app["bundleId"] != "com.example.not-installed" && app["name"].as_str().is_some_and(|name| !name.is_empty())));
  }
}
