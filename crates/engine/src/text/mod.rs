//! The words after Whisper and before they are typed: vocabulary replacements, fillers and the app's
//! style. Drafts run through it too, so every rule keeps the words in their order: a draft is retyped
//! by the prefix it shares with the one before. Everything here is local and deterministic.
use serde::{Deserialize, Serialize};

mod code;
mod spoken;
mod typing;
mod words;

pub use spoken::{sticky_words, without_send};
pub use typing::{chars_at, correction, live_next, typing};

/// A vocabulary replacement: `from`, said, is typed as `to`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Replacement {
  /// What Whisper hears.
  pub from: String,
  /// What is typed instead.
  pub to: String,
}

/// How an app wants its words written.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Style {
  /// Whisper's words after the person's own rules.
  #[default]
  Default,
  /// Chat: one sentence loses its full stop.
  Casual,
  /// Mail: a capital to start and a full stop to end.
  Formal,
  /// Spoken symbols and casing commands.
  Code,
  /// Whisper as it heard you.
  Raw,
}

/// What the pipeline does to one hold's words. `language` is Whisper's code for them.
#[derive(Debug)]
pub struct Rules<'a> {
  /// The app's style.
  pub style: Style,
  /// Whether fillers ("um", "uh") are dropped.
  pub fillers: bool,
  /// The person's replacements.
  pub replacements: &'a [Replacement],
  /// Whisper's code for the hold's language, when known.
  pub language: Option<&'a str>,
  /// A draft while the key is still held.
  pub live: bool,
}

/// The text to type for `raw` under `rules`.
pub fn finish(raw: &str, rules: &Rules) -> String {
  // Raw is Whisper as it heard you: none of your rules apply.
  if rules.style == Style::Raw { return raw.to_owned(); }
  let turkish = matches!(rules.language, Some("tr" | "az"));
  let mut text = words::replace(raw, rules.replacements, turkish);
  if rules.fillers { text = words::drop_fillers(&text, words::fillers(rules.language), turkish); }
  match rules.style {
    Style::Casual => words::casual(&text),
    Style::Formal => words::formal(&text, turkish, rules.live),
    Style::Code => code::code(&text, turkish),
    Style::Default | Style::Raw => text,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn pair(from: &str, to: &str) -> Replacement { Replacement { from: from.into(), to: to.into() } }
  fn run(raw: &str, style: Style, language: &str, replacements: &[Replacement]) -> String {
    finish(raw, &Rules { style, fillers: true, replacements, language: Some(language), live: false })
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
    assert_eq!(finish("Um, hi", &Rules { style: Style::Default, fillers: false, replacements: &[], language: Some("en"), live: false }), "Um, hi");
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
    assert_eq!(finish("thanks for", &Rules { style: Style::Formal, fillers: true, replacements: &[], language: Some("en"), live: true }), "Thanks for");
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
      let (one, two) = (finish("um so we", &rules), finish("um so we should go", &rules));
      assert!(two.starts_with(&one), "{style:?}: {one:?} then {two:?}");
    }
  }

}
