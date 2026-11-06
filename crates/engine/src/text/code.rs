//! The Code style: symbols and casing said by name.
use super::words::{capitalize, edges, lower, lowered, upper};

/// Whether a symbol joins the word before it, the word after it, both, or neither.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Fit {
  Spaced,
  Before,
  After,
  Both,
}

/// Symbols by what you say for them, with how each sits beside its neighbours.
const SYMBOLS: &[(&str, (&str, Fit))] = {
  use Fit::*;
  &[
    ("dot", (".", Both)),
    ("comma", (",", Before)),
    ("colon", (":", Before)),
    ("semicolon", (";", Before)),
    ("semi colon", (";", Before)),
    ("open paren", ("(", Both)),
    ("open parenthesis", ("(", Both)),
    ("open parentheses", ("(", Both)),
    ("left paren", ("(", Both)),
    ("close paren", (")", Before)),
    ("close parenthesis", (")", Before)),
    ("close parentheses", (")", Before)),
    ("right paren", (")", Before)),
    ("open bracket", ("[", Both)),
    ("open square bracket", ("[", Both)),
    ("left bracket", ("[", Both)),
    ("close bracket", ("]", Before)),
    ("close square bracket", ("]", Before)),
    ("right bracket", ("]", Before)),
    ("open brace", ("{", After)),
    ("open curly brace", ("{", After)),
    ("open curly", ("{", After)),
    ("left brace", ("{", After)),
    ("close brace", ("}", Before)),
    ("close curly brace", ("}", Before)),
    ("close curly", ("}", Before)),
    ("right brace", ("}", Before)),
    ("triple equals", ("===", Spaced)),
    ("double equals", ("==", Spaced)),
    ("not equals", ("!=", Spaced)),
    ("equals", ("=", Spaced)),
    ("equal sign", ("=", Spaced)),
    ("equals sign", ("=", Spaced)),
    ("plus", ("+", Spaced)),
    ("minus", ("-", Spaced)),
    ("fat arrow", ("=>", Spaced)),
    ("arrow", ("->", Spaced)),
    ("less than", ("<", Spaced)),
    ("greater than", (">", Spaced)),
    ("double ampersand", ("&&", Spaced)),
    ("ampersand", ("&", Spaced)),
    ("double pipe", ("||", Spaced)),
    ("pipe", ("|", Spaced)),
    ("slash", ("/", Both)),
    ("forward slash", ("/", Both)),
    ("backslash", ("\\", Both)),
    ("back slash", ("\\", Both)),
    ("underscore", ("_", Both)),
    ("hyphen", ("-", Both)),
    ("dash", ("-", After)),
    ("star", ("*", After)),
    ("asterisk", ("*", After)),
    ("at sign", ("@", Both)),
    ("hash", ("#", After)),
    ("hash sign", ("#", After)),
    ("pound sign", ("#", After)),
    ("dollar sign", ("$", After)),
    ("percent", ("%", Before)),
    ("percent sign", ("%", Before)),
    ("caret", ("^", Both)),
    ("tilde", ("~", After)),
    ("question mark", ("?", Before)),
    ("exclamation mark", ("!", Before)),
    ("exclamation point", ("!", Before)),
    ("bang", ("!", After)),
    ("new line", ("\n", Both)),
    ("newline", ("\n", Both)),
    ("new paragraph", ("\n\n", Both)),
  ]
};
/// Quotes open and close in turn.
const QUOTES: &[(&str, char)] = &[("quote", '"'), ("double quote", '"'), ("single quote", '\''), ("backtick", '`'), ("back tick", '`')];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Case {
  Camel,
  Pascal,
  Snake,
  Kebab,
  Constant,
  Upper,
  Lower,
}
/// Casing commands: the words after one, up to punctuation or a symbol, become one identifier.
const CASES: &[(&str, Case)] = &[
  ("camel case", Case::Camel),
  ("camelcase", Case::Camel),
  ("pascal case", Case::Pascal),
  ("pascalcase", Case::Pascal),
  ("snake case", Case::Snake),
  ("snakecase", Case::Snake),
  ("kebab case", Case::Kebab),
  ("kebabcase", Case::Kebab),
  ("constant case", Case::Constant),
  ("screaming snake case", Case::Constant),
  ("all caps", Case::Upper),
  ("all capitals", Case::Upper),
  ("lower case", Case::Lower),
  ("lowercase", Case::Lower),
];

/// The longest phrase of `table` said at the start of `words` (already plain), and how many words it took.
fn said<T: Copy>(words: &[String], table: &[(&str, T)]) -> Option<(T, usize)> {
  table
    .iter()
    .filter_map(|&(phrase, value)| {
      let count = phrase.split(' ').count();
      (words.len() >= count && words[..count].iter().map(String::as_str).eq(phrase.split(' '))).then_some((value, count))
    })
    .max_by_key(|&(_, count)| count)
}

/// Code built a piece at a time, spaced unless a piece joins its neighbour.
#[derive(Default)]
struct Code {
  text: String,
  glued: bool,
}
impl Code {
  fn put(&mut self, piece: &str, fit: Fit) {
    if !self.text.is_empty() && !self.glued && !matches!(fit, Fit::Before | Fit::Both) {
      self.text.push(' ');
    }
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
pub(super) fn code(text: &str, turkish: bool) -> String {
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
        if !after.is_empty() {
          close = after;
          break;
        }
      }
      if !parts.is_empty() {
        out.put(&format!("{}{close}", identifier(&parts, case, turkish)), Fit::Spaced);
      }
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
