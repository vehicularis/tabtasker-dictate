//! Learning from the typing that follows a dictation, and live typing of drafts.

/// The word the person typed over a dictated one. `before` is the field as dictated, `after` as it is
/// now, and `dictated` the dictated words' range in `before`, in chars. One to three dictated words
/// replaced by one word is a correction; new words typed after them, a rewritten sentence or deleted
/// words are not. Answers the word and whether it reads as a name: a capital inside it, a digit, or a
/// capital where no sentence starts.
pub fn correction(before: &str, after: &str, dictated: std::ops::Range<usize>) -> Option<(String, bool)> {
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
pub fn typing(before: &str, after: &str, caret: usize) -> bool {
  let (b, a): (Vec<char>, Vec<char>) = (before.chars().collect(), after.chars().collect());
  let (prefix, suffix) = unchanged(&b, &a);
  let (mut start, mut end) = (prefix, a.len() - suffix);
  while start > 0 && word(&a[start - 1]) { start -= 1; }
  while end < a.len() && word(&a[end]) { end += 1; }
  (start + 1..=end).contains(&caret) && word(&a[caret - 1])
}

/// AppKit's UTF-16 offsets as char offsets in `text`.
pub fn chars_at(text: &str, start: usize, length: usize) -> std::ops::Range<usize> {
  let (mut units, mut from, mut to) = (0, None, None);
  for (i, c) in text.chars().enumerate() {
    if from.is_none() && units >= start { from = Some(i); }
    if to.is_none() && units >= start + length { to = Some(i); }
    units += c.len_utf16();
  }
  let count = text.chars().count();
  from.unwrap_or(count)..to.unwrap_or(count)
}



/// Live typing types a word once two passes in a row have heard it in the same place, so the field only grows
/// while the key is held: what the passes still disagree on (the last word or two, as a rule) waits in the orb,
/// and release puts the finished words in at once. A typed word one pass hears differently stays as it is; once
/// two in a row agree on the new hearing (after a pause Whisper often hears "it is" as "it's", or drops a
/// repeat), the field is put right from that word and carries on, rather than stopping there. Given what is
/// typed, the last pass's words and this one's: the field's new words, or empty to leave it. The last typed
/// word takes the punctuation it has gained once a word follows it; the last word of all goes in without the
/// stop or comma that may yet move.
pub fn live_next(typed: &str, previous: &str, now: &str) -> String {
  let key = |word: &str| word.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect::<String>();
  let common = |one: &[&str], other: &[&str]| one.iter().zip(other).take_while(|(a, b)| key(a) == key(b)).count();
  let typed: Vec<&str> = typed.split_whitespace().collect();
  let before: Vec<&str> = previous.split_whitespace().collect();
  let heard: Vec<&str> = now.split_whitespace().collect();
  let agreed = common(&before, &heard);
  let kept = common(&typed, &heard);
  if agreed <= kept { return String::new(); } // nothing agreed past what is typed and still heard there
  let mut words: Vec<String> = typed[..kept].iter().map(|word| word.to_string()).collect();
  if let Some(last) = words.last_mut() {
    let gained = heard[kept - 1].strip_prefix(last.as_str()).unwrap_or("");
    if gained.chars().all(|c| !c.is_alphanumeric()) { last.push_str(gained); }
  }
  words.extend(heard[kept..agreed].iter().map(|word| word.to_string()));
  let mut text = words.join(" ");
  text.truncate(text.trim_end_matches(['.', ',', '!', '?', ';', ':', '…']).len());
  if text == typed.join(" ") { String::new() } else { text }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn live_typing_types_what_two_passes_agree_on_and_recovers_from_a_pause() {
    let next = |typed, previous, now| { let next = live_next(typed, previous, now); if next.is_empty() { "(as it is)".into() } else { next } };
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
  }

}
