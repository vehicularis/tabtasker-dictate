//! Word error rate: how far what was heard is from what was said.

use dictate_engine::prompt::normalize;
use serde::Serialize;

/// The words of `text` as they are compared: lowercase, punctuation gone.
pub fn words(text: &str) -> Vec<String> {
  normalize(text).split_whitespace().map(String::from).collect()
}

/// The edits that turn what was said into what was heard.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Score {
  /// Words heard as other words.
  pub substitutions: usize,
  /// Words said and not heard.
  pub deletions: usize,
  /// Words heard and not said.
  pub insertions: usize,
  /// How many words were said.
  pub reference: usize,
}

impl Score {
  /// (S + D + I) / N. With nothing said, 0 when nothing was heard either, else 1.
  pub fn wer(&self) -> f64 {
    let edits = self.substitutions + self.deletions + self.insertions;
    match self.reference {
      0 if edits > 0 => 1.0,
      0 => 0.0,
      n => edits as f64 / n as f64,
    }
  }
}

/// One word of what was said lined up with what was heard.
#[derive(Debug, PartialEq, Eq)]
enum Edit {
  /// Said and heard.
  Same(String),
  /// Said as the first, heard as the second.
  Swapped(String, String),
  /// Said and not heard.
  Dropped(String),
  /// Heard and not said.
  Added(String),
}

/// What was `heard` lined up word by word with the `reference`: a word-level Levenshtein, with a
/// backtrace that names each edit.
fn align(reference: &str, heard: &str) -> Vec<Edit> {
  let (r, h) = (words(reference), words(heard));
  // cost[i][j]: the fewest edits turning the first i words said into the first j heard.
  let mut cost = vec![vec![0; h.len() + 1]; r.len() + 1];
  for (i, row) in cost.iter_mut().enumerate() {
    row[0] = i;
  }
  cost[0] = (0..=h.len()).collect();
  for i in 1..=r.len() {
    for j in 1..=h.len() {
      let swap = cost[i - 1][j - 1] + usize::from(r[i - 1] != h[j - 1]);
      cost[i][j] = swap.min(cost[i - 1][j] + 1).min(cost[i][j - 1] + 1);
    }
  }
  let mut edits = Vec::new();
  let (mut i, mut j) = (r.len(), h.len());
  while i > 0 || j > 0 {
    if i > 0 && j > 0 && cost[i][j] == cost[i - 1][j - 1] + usize::from(r[i - 1] != h[j - 1]) {
      edits.push(match r[i - 1] == h[j - 1] {
        true => Edit::Same(r[i - 1].clone()),
        false => Edit::Swapped(r[i - 1].clone(), h[j - 1].clone()),
      });
      (i, j) = (i - 1, j - 1);
    } else if i > 0 && cost[i][j] == cost[i - 1][j] + 1 {
      edits.push(Edit::Dropped(r[i - 1].clone()));
      i -= 1;
    } else {
      edits.push(Edit::Added(h[j - 1].clone()));
      j -= 1;
    }
  }
  edits.reverse();
  edits
}

/// What was `heard` against the `reference`, each kind of edit counted.
pub fn score(reference: &str, heard: &str) -> Score {
  let mut score = Score { substitutions: 0, deletions: 0, insertions: 0, reference: words(reference).len() };
  for edit in align(reference, heard) {
    match edit {
      Edit::Same(_) => {}
      Edit::Swapped(..) => score.substitutions += 1,
      Edit::Dropped(_) => score.deletions += 1,
      Edit::Added(_) => score.insertions += 1,
    }
  }
  score
}

/// The words said, as they are compared, with what was heard instead marked in them: `[-dropped-]`
/// for a word not heard, `{+added+}` for one heard and not said, both for a word heard as another.
pub fn diff(reference: &str, heard: &str) -> String {
  let marked: Vec<String> = align(reference, heard)
    .into_iter()
    .map(|edit| match edit {
      Edit::Same(word) => word,
      Edit::Swapped(said, heard) => format!("[-{said}-] {{+{heard}+}}"),
      Edit::Dropped(said) => format!("[-{said}-]"),
      Edit::Added(heard) => format!("{{+{heard}+}}"),
    })
    .collect();
  marked.join(" ")
}

#[cfg(test)]
mod tests {
  use super::*;

  fn s(sub: usize, del: usize, ins: usize, n: usize) -> Score {
    Score { substitutions: sub, deletions: del, insertions: ins, reference: n }
  }

  #[test]
  fn identical_text_scores_zero() {
    let got = score("The meeting moved to Thursday.", "The meeting moved to Thursday.");
    assert_eq!(got, s(0, 0, 0, 5));
    assert_eq!(got.wer(), 0.0);
  }

  #[test]
  fn each_kind_of_error_costs_one_word() {
    let said = "ship the build on friday";
    for (heard, want) in [("ship the bill on friday", s(1, 0, 0, 5)), ("ship the build friday", s(0, 1, 0, 5)), ("ship the new build on friday", s(0, 0, 1, 5))]
    {
      let got = score(said, heard);
      assert_eq!(got, want, "{heard}");
      assert_eq!(got.wer(), 1.0 / 5.0, "{heard}");
    }
  }

  #[test]
  fn punctuation_and_case_are_ignored() {
    assert_eq!(words("Hello, World!  It's  me."), ["hello", "world", "its", "me"]);
    assert_eq!(score("Hello, world.", "hello world").wer(), 0.0);
  }

  #[test]
  fn an_empty_reference_is_all_or_nothing() {
    assert_eq!(score("", "").wer(), 0.0);
    assert_eq!(score("...", " ").wer(), 0.0);
    assert_eq!(score("", "thank you for watching").wer(), 1.0);
    assert_eq!(score("", "you").wer(), 1.0);
  }

  #[test]
  fn the_backtrace_counts_each_edit() {
    let got = score("the cat sat", "the bat sat on");
    assert_eq!(got, s(1, 0, 1, 3));
    assert_eq!(got.wer(), 2.0 / 3.0);
    // Nothing heard is every word deleted.
    assert_eq!(score("the cat sat", ""), s(0, 3, 0, 3));
  }

  #[test]
  fn the_diff_marks_each_word_dropped_and_added() {
    assert_eq!(diff("The cat sat on the mat.", "the bat sat the mat, too"), "the [-cat-] {+bat+} sat [-on-] the mat {+too+}");
    assert_eq!(diff("Hello, world.", "hello world"), "hello world");
    assert_eq!(diff("", "thank you"), "{+thank+} {+you+}");
  }
}
