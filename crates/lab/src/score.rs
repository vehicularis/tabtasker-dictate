//! Word error rate: how far what was heard is from what was said.

use dictate_engine::prompt::normalize;

/// The words of `text` as they are compared: lowercase, punctuation gone.
pub fn words(text: &str) -> Vec<String> {
  normalize(text)
    .split_whitespace()
    .map(String::from)
    .collect()
}

/// The edits that turn what was said into what was heard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

/// What was `heard` against the `reference`: a word-level Levenshtein, with a backtrace that counts each kind of edit.
pub fn score(reference: &str, heard: &str) -> Score {
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
  let mut score = Score {
    substitutions: 0,
    deletions: 0,
    insertions: 0,
    reference: r.len(),
  };
  let (mut i, mut j) = (r.len(), h.len());
  while i > 0 || j > 0 {
    if i > 0 && j > 0 && cost[i][j] == cost[i - 1][j - 1] + usize::from(r[i - 1] != h[j - 1]) {
      score.substitutions += usize::from(r[i - 1] != h[j - 1]);
      (i, j) = (i - 1, j - 1);
    } else if i > 0 && cost[i][j] == cost[i - 1][j] + 1 {
      score.deletions += 1;
      i -= 1;
    } else {
      score.insertions += 1;
      j -= 1;
    }
  }
  score
}

#[cfg(test)]
mod tests {
  use super::*;

  fn s(sub: usize, del: usize, ins: usize, n: usize) -> Score {
    Score {
      substitutions: sub,
      deletions: del,
      insertions: ins,
      reference: n,
    }
  }

  #[test]
  fn identical_text_scores_zero() {
    let got = score(
      "The meeting moved to Thursday.",
      "The meeting moved to Thursday.",
    );
    assert_eq!(got, s(0, 0, 0, 5));
    assert_eq!(got.wer(), 0.0);
  }

  #[test]
  fn each_kind_of_error_costs_one_word() {
    let said = "ship the build on friday";
    for (heard, want) in [
      ("ship the bill on friday", s(1, 0, 0, 5)),
      ("ship the build friday", s(0, 1, 0, 5)),
      ("ship the new build on friday", s(0, 0, 1, 5)),
    ] {
      let got = score(said, heard);
      assert_eq!(got, want, "{heard}");
      assert_eq!(got.wer(), 1.0 / 5.0, "{heard}");
    }
  }

  #[test]
  fn punctuation_and_case_are_ignored() {
    assert_eq!(
      words("Hello, World!  It's  me."),
      ["hello", "world", "its", "me"]
    );
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
}
