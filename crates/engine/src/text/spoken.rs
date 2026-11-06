//! Commands said aloud at the end or start of a dictation.

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

#[cfg(test)]
mod tests {
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
}
