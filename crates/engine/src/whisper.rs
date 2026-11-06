//! Whisper itself: loading a model, detecting the language, and a pass over a hold or a meeting piece.
use crate::{
  cleanup,
  error::{Error, Result},
  models::ModelKind,
  prompt::{self, Echo, PROMPT_TOKENS},
};
use std::{
  ffi::c_void,
  path::Path,
  time::{Duration, Instant},
};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState, WhisperSysContext, WhisperSysState};

/// What Settings asks of every pass: a pinned language (None detects it), translation to English, and
/// the words Whisper should spell right, newest first.
#[derive(Clone, Debug, Default)]
pub struct Ask {
  /// The language Settings pins, by Whisper's id; None detects it.
  pub language: Option<i32>,
  /// Whether to translate to English.
  pub translate: bool,
  /// The words Whisper should spell right, newest first.
  pub words: Vec<String>,
}

/// Words Whisper heard in a piece, `start` and `end` in samples from the piece's start.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Segment {
  /// Where the words start, in samples.
  pub start: usize,
  /// Where the words end, in samples.
  pub end: usize,
  /// The words.
  pub text: String,
}

/// The words of a pass.
#[derive(Debug)]
pub struct Transcript {
  /// What was said.
  pub text: String,
  /// Whether Whisper recited the vocabulary instead of what was said, so the audio was heard again
  /// without it. True even if the retry was discarded.
  pub retried_without_prompt: bool,
}

/// What a pass checks while it runs: `stop`, and the time it has taken.
struct Abort<'a> {
  stop: &'a (dyn Fn() -> bool + Sync),
  started: Instant,
}
/// No single decode runs longer than this, however long its audio.
const DEADLINE: Duration = Duration::from_secs(120);

fn stops(abort: &Abort) -> bool {
  (abort.stop)() || abort.started.elapsed() >= DEADLINE
}

unsafe extern "C" fn should_abort(data: *mut c_void) -> bool {
  stops(unsafe { &*(data as *const Abort) })
}

unsafe extern "C" fn stop_before_encoding(_: *mut WhisperSysContext, _: *mut WhisperSysState, _: *mut c_void) -> bool {
  false
}

fn threads() -> usize {
  std::thread::available_parallelism().map_or(4, |n| n.get().min(8))
}

/// A new decoding state for `whisper`, with GPU buffers of its own.
fn fresh_state(whisper: &WhisperContext) -> Result<WhisperState> {
  whisper.create_state().map_err(|_| Error::Other("There isn’t enough free memory. Quit an app or two and try again.".into()))
}

/// How much of Whisper's 30 s window the encoder looks at: the audio (20 ms a position) plus the 128
/// positions of room the fine-tuned model was evaluated with. A short command encodes several times faster.
fn audio_ctx(samples: usize) -> i32 {
  (samples.div_ceil(320) + 128).min(1500) as i32
}

/// The encoder's audio context for `samples` on `kind`. Only the fine-tuned Turbo keeps its accuracy on
/// less than the whole window; Small, cheap to encode anyway, always sees all of it (0).
fn encoder_ctx(kind: ModelKind, samples: usize) -> i32 {
  if kind == ModelKind::Turbo {
    audio_ctx(samples)
  } else {
    0
  }
}

/// Whisper's id for a language code, such as `en`.
pub fn lang_id(code: &str) -> Option<i32> {
  whisper_rs::get_lang_id(code)
}

/// The code of a language by Whisper's id, such as `en`.
pub fn lang_code(id: i32) -> Option<&'static str> {
  whisper_rs::get_lang_str(id)
}

/// Every language code Whisper knows. Bounded by its last id, since asking whisper.cpp for an id past
/// that logs an error.
pub fn lang_codes() -> impl Iterator<Item = &'static str> {
  (0..=whisper_rs::get_lang_max_id()).filter_map(lang_code)
}

/// The name of a language by Whisper's id, such as `english`.
pub fn lang_name(id: i32) -> Option<&'static str> {
  whisper_rs::get_lang_str_full(id)
}

/// A language Settings pins, by Whisper's id; None for `auto`.
pub fn pinned(code: &str) -> Option<i32> {
  if code == "auto" {
    None
  } else {
    lang_id(code)
  }
}

/// The words of a pass whose `first` decode recited the vocabulary (`echo`), once `retry` heard the audio
/// again without it: the retry if [`Echo::keeps`] it, else cancelled if the pass was `stopped`, else
/// unheard for a strict echo, else `first`. `words` are the vocabulary Whisper was given, over `samples`.
pub fn retry_outcome(first: String, echo: &Echo, retry: Result<String>, stopped: bool, words: &[String], samples: usize) -> Result<String> {
  match retry {
    Ok(again) if echo.keeps(&again, words, samples) => Ok(again),
    _ if stopped => Err(Error::Cancelled),
    // The whole vocabulary that no retry replaces was never said.
    _ if echo.strict => Err(Error::Unheard),
    _ => Ok(first),
  }
}

/// Whisper, its state and the vocabulary it was last given. Passes reuse the state: whisper.cpp clears
/// its results, spectrogram and prompt at the start of each full() (no_context is on for all of ours),
/// and `&mut self` keeps passes from sharing it.
///
/// That clearing is not the whole of it: a pass's words can still depend on what the same state decoded
/// before. The lab's 39 s note reads "mockups" on a fresh state and "mock-ups" after another recording,
/// and a bare "Send." comes out "sand" after eight others. So [`Whisper::reset`] gives a fresh state: the
/// app's once a hold, before its first pass, and the lab's once a recording. A meeting's pieces never reset it.
pub struct Whisper {
  whisper: WhisperContext,
  state: WhisperState,
  kind: ModelKind,
  prompt: Prompt,
}

impl std::fmt::Debug for Whisper {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("Whisper").field("kind", &self.kind).finish_non_exhaustive()
  }
}

/// The vocabulary as Whisper was last given it: the words, those of them that fit in its prompt, and the
/// prompt's tokens.
#[derive(Default)]
struct Prompt {
  words: Vec<String>,
  sent: Vec<String>,
  tokens: Vec<i32>,
}

/// What none of our passes prints.
fn quiet(params: &mut FullParams) {
  params.set_print_special(false);
  params.set_print_progress(false);
  params.set_print_realtime(false);
  params.set_print_timestamps(false);
}

/// The mean log probability of a segment's words, special tokens left out (they sort from end-of-text up).
fn avg_logprob(segment: &whisper_rs::WhisperSegment<'_>, eot: i32) -> f32 {
  let logs: Vec<f32> =
    (0..segment.n_tokens()).filter_map(|i| segment.get_token(i)).filter(|token| token.token_id() < eot).map(|token| token.token_data().plog).collect();
  if logs.is_empty() {
    f32::NEG_INFINITY
  } else {
    logs.iter().sum::<f32>() / logs.len() as f32
  }
}

impl Whisper {
  /// The Whisper model file at `path`, which is a `kind`, loaded on the GPU (else the CPU) and warmed up.
  pub fn load(path: &Path, kind: ModelKind) -> Result<Self> {
    // Native debug logs can contain recognized tokens; keep speech out of app logs.
    whisper_rs::install_logging_hooks();
    let path = path.to_str().ok_or_else(|| Error::Other("Voice model path is not valid Unicode.".into()))?;
    let mut parameters = WhisperContextParameters::default();
    parameters.use_gpu(true).flash_attn(true);
    let whisper = WhisperContext::new_with_params(path, parameters)
      .or_else(|_| {
        let mut cpu = WhisperContextParameters::default();
        cpu.use_gpu(false);
        WhisperContext::new_with_params(path, cpu)
      })
      .map_err(|_| Error::Other("Couldn’t load the speech model. Quit an app or two to free up memory, then try again.".into()))?;
    let state = fresh_state(&whisper)?;
    let mut engine = Self { whisper, state, kind, prompt: Prompt::default() };
    engine.warm_up();
    Ok(engine)
  }

  /// A fresh decoding state in place of the one every pass reuses, created and warmed up as [`Whisper::load`]
  /// leaves it, so the next pass hears its audio as if nothing had been decoded before. The vocabulary's
  /// prompt is kept: its tokens come from the model, not the state, so the same words still make the same prompt.
  pub fn reset(&mut self) -> Result<()> {
    self.state = fresh_state(&self.whisper)?;
    self.warm_up();
    Ok(())
  }

  /// A throw-away pass over a second of silence, with the final pass's beams, so the first dictation
  /// doesn't wait while Metal sets up what a pass needs.
  fn warm_up(&mut self) {
    let mut params = FullParams::new(SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 });
    params.set_n_threads(threads() as i32);
    params.set_language(Some("en"));
    params.set_audio_ctx(self.audio_ctx(16_000));
    params.set_temperature_inc(0.0); // once, never again warmer
    params.set_max_tokens(16); // a few steps of the decoder are enough, however it hears silence
    quiet(&mut params);
    let _ = self.state.full(params, &vec![0.0; 16_000]);
  }

  fn audio_ctx(&self, samples: usize) -> i32 {
    encoder_ctx(self.kind, samples)
  }

  fn tokens(&self, text: &str) -> Vec<i32> {
    // A token is at least a byte, so this room is always enough; too little would be undefined.
    self.whisper.tokenize(text, text.len() + 8).unwrap_or_default()
  }

  /// How many of Whisper's tokens `text` is.
  pub fn token_count(&self, text: &str) -> usize {
    self.tokens(text).len()
  }

  /// Tokenizes `words` as the prompt, once for each change of them.
  fn use_words(&mut self, words: &[String]) {
    if self.prompt.words == words {
      return;
    }
    let (text, count) = prompt::prompt_text(words, |text| self.tokens(text).len() < PROMPT_TOKENS);
    let tokens = if text.is_empty() { Vec::new() } else { self.tokens(&text) };
    self.prompt = Prompt { words: words.to_vec(), sent: prompt::entries(words).take(count).map(Into::into).collect(), tokens };
  }

  /// The language spoken in `pcm`, by Whisper's id, and how sure Whisper is of it. It runs the encoder,
  /// about half the work of a pass.
  pub fn detect_language(&mut self, pcm: &[f32]) -> Result<(i32, f32)> {
    // whisper.cpp takes a shorter audio context only from full(), and only after its own language
    // detection. A pass stopped before its encoder leaves the spectrogram and that context in place, so
    // detecting here encodes just the speech rather than all 30 s.
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(threads() as i32);
    params.set_language(Some("en"));
    params.set_audio_ctx(self.audio_ctx(pcm.len()));
    quiet(&mut params);
    unsafe {
      params.set_start_encoder_callback(Some(stop_before_encoding));
    }
    self.state.full(params, pcm).map_err(|_| Error::NotUnderstood)?;
    let (language, sure) = self.state.lang_detect(0, threads()).map_err(|_| Error::NotUnderstood)?;
    Ok((language, sure.get(language as usize).copied().unwrap_or(0.0)))
  }

  /// The words of a hold in `language`, with `ask`'s vocabulary, stopping once `stop` says so. Each decode
  /// gets its own two minutes, so a retry without the vocabulary can bring it to about four.
  /// `quick` is the live pass's greedy decoding; the final pass searches five beams, which
  /// costs about the same because the encoder dominates.
  pub fn transcribe(&mut self, pcm: &[f32], language: i32, ask: &Ask, stop: &(dyn Fn() -> bool + Sync), quick: bool) -> Result<Transcript> {
    if stop() {
      return Err(Error::Cancelled);
    }
    self.use_words(&ask.words);
    let text = self.decode(pcm, language, ask, stop, quick, true)?;
    // Over near-silence a prompted Whisper can recite the vocabulary instead of what was said (OpenWhispr
    // #1454): heard again without it, when the retry could be kept.
    let Some(echo) = Echo::of(&text, &self.prompt.sent, pcm.len()).filter(|_| !self.prompt.tokens.is_empty()) else {
      return Ok(Transcript { text, retried_without_prompt: false });
    };
    // Logged before the retry, so a retry that ends unheard or cancelled still says it ran.
    if !quick {
      log::info!("dictation pass: it recited the vocabulary, heard again without it");
    }
    let retry = self.decode(pcm, language, ask, stop, quick, false);
    retry_outcome(text, &echo, retry, stop(), &self.prompt.sent, pcm.len()).map(|text| Transcript { text, retried_without_prompt: true })
  }

  fn decode(&mut self, pcm: &[f32], language: i32, ask: &Ask, stop: &(dyn Fn() -> bool + Sync), quick: bool, prompted: bool) -> Result<String> {
    let mut params =
      FullParams::new(if quick { SamplingStrategy::Greedy { best_of: 1 } } else { SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 } });
    params.set_n_threads(threads() as i32);
    params.set_language(lang_code(language));
    params.set_audio_ctx(self.audio_ctx(pcm.len()));
    params.set_translate(ask.translate);
    params.set_no_context(true);
    // Timestamps stay on, as OpenWhispr keeps them (whisperServer.js, #2150). Without them a decode that
    // ends early, as one can at a pause, moves on a whole 30 s window, so the words after the pause are
    // lost even in a short hold; with them whisper.cpp carries on from the last timestamp.
    params.set_suppress_nst(true);
    // OpenWhispr's thresholds for dictation (whisperServer.js, #1458): a decode this unsure is tried again
    // warmer, which cut made-up endings ("Thank you for watching") from 2.25 % to 0.06 % of its dictations.
    params.set_entropy_thold(2.8);
    params.set_logprob_thold(-1.25);
    if prompted && !self.prompt.tokens.is_empty() {
      params.set_tokens(&self.prompt.tokens);
    }
    quiet(&mut params);
    let mut abort = Abort { stop, started: Instant::now() };
    // The callback borrows this stack value only for the synchronous full() call.
    unsafe {
      params.set_abort_callback(Some(should_abort));
      params.set_abort_callback_user_data((&mut abort as *mut Abort).cast());
    }
    self.state.full(params, pcm).map_err(|_| Error::NotUnderstood)?;
    if stop() {
      return Err(Error::Cancelled);
    }
    let mut text = String::new();
    let eot = self.whisper.token_eot();
    for segment in self.state.as_iter() {
      if cleanup::is_silent_segment(segment.no_speech_probability(), avg_logprob(&segment, eot)) {
        continue;
      } // that window, not the whole hold
      text.push_str(&segment.to_string());
    }
    let text = if prompted { prompt::without_recital(&text, &self.prompt.sent) } else { &text }.trim().to_owned();
    let text = cleanup::unloop(&text, pcm.len() as f32 / 16_000.0);
    if text.is_empty() {
      return Err(Error::Unheard);
    }
    if text.chars().count() > 8000 {
      return Err(Error::TooLong);
    }
    Ok(text)
  }

  /// A meeting piece with timestamps, stopping once `stop` says so; the decode gets its own two minutes. `prompt`
  /// replaces the vocabulary when the caller has its own.
  pub fn segments(
    &mut self,
    pcm: &[f32],
    language: i32,
    prompt: Option<&str>,
    ask: &Ask,
    translate: bool,
    stop: &(dyn Fn() -> bool + Sync),
  ) -> Result<Vec<Segment>> {
    let mut abort = Abort { stop, started: Instant::now() };
    let own = prompt.map(str::trim).filter(|prompt| !prompt.is_empty()).map(|prompt| self.tokens(&format!(" {}", prompt.replace('\0', ""))));
    if own.is_none() {
      self.use_words(&ask.words);
    }
    let tokens = own.as_deref().unwrap_or(&self.prompt.tokens);
    let mut params = FullParams::new(SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 });
    params.set_n_threads(threads() as i32);
    params.set_language(lang_code(language));
    params.set_audio_ctx(self.audio_ctx(pcm.len()));
    params.set_translate(translate);
    params.set_no_context(true);
    params.set_suppress_nst(true);
    if !tokens.is_empty() {
      params.set_tokens(tokens);
    }
    quiet(&mut params);
    // The callback borrows this stack value only for the synchronous full() call.
    unsafe {
      params.set_abort_callback(Some(should_abort));
      params.set_abort_callback_user_data((&mut abort as *mut Abort).cast());
    }
    self.state.full(params, pcm).map_err(|_| Error::NotUnderstood)?;
    // Timestamps are in hundredths of a second.
    let samples = |at: i64| (at.max(0) as usize * 160).min(pcm.len());
    let eot = self.whisper.token_eot();
    Ok(
      self
        .state
        .as_iter()
        .filter(|segment| !cleanup::is_silent_segment(segment.no_speech_probability(), avg_logprob(segment, eot)))
        .filter_map(|segment| {
          let text = segment.to_string().trim().to_owned();
          (!text.is_empty()).then(|| Segment { start: samples(segment.start_timestamp()), end: samples(segment.end_timestamp()), text })
        })
        .collect(),
    )
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::audio::HOLD_SAMPLES;

  #[test]
  fn abort_stops_when_asked_or_past_the_deadline() {
    assert!(!stops(&Abort { stop: &|| false, started: Instant::now() }));
    assert!(stops(&Abort { stop: &|| true, started: Instant::now() }));
    assert!(stops(&Abort { stop: &|| false, started: Instant::now() - Duration::from_secs(121) }));
  }

  #[test]
  fn the_encoder_sees_the_speech_plus_room_never_more_than_whisper_window() {
    assert_eq!(audio_ctx(16000), 50 + 128);
    assert_eq!(audio_ctx(16001), 51 + 128);
    assert_eq!(audio_ctx(HOLD_SAMPLES), 1500);
  }

  #[test]
  fn small_sees_the_whole_window_and_turbo_only_the_speech() {
    assert_eq!(encoder_ctx(ModelKind::Turbo, 16000), 178);
    assert_eq!(encoder_ctx(ModelKind::Small, 16000), 0);
    assert_eq!(encoder_ctx(ModelKind::Small, HOLD_SAMPLES), 0);
  }

  #[test]
  fn the_retry_is_kept_only_when_it_hears_more() {
    let words: Vec<String> = ["Kubernetes", "Vercel", "TabTasker", "Maria Lopez"].map(String::from).to_vec();
    let samples = 16_000;
    let (recital, looped) = ("Kubernetes, Vercel, TabTasker, Maria Lopez.", "Vercel Vercel Vercel");
    let (strict, fragment) = (Echo::of(recital, &words, samples).unwrap(), Echo::of(looped, &words, samples).unwrap());
    assert!(strict.strict && !fragment.strict);
    let outcome = |first: &str, echo: &Echo, retry: Result<String>, stopped: bool| retry_outcome(first.into(), echo, retry, stopped, &words, samples);
    // A strict echo whose retry fails was never said.
    assert_eq!(outcome(recital, &strict, Err(Error::Unheard), false), Err(Error::Unheard));
    assert_eq!(outcome(recital, &strict, Ok(recital.into()), false), Err(Error::Unheard));
    // A fragment whose retry fails, or hears no more, stays.
    assert_eq!(outcome(looped, &fragment, Err(Error::Unheard), false), Ok(looped.into()));
    assert_eq!(outcome(looped, &fragment, Ok("Vercel".into()), false), Ok(looped.into()));
    // A retry that hears more is kept, even once stopped.
    assert_eq!(outcome(recital, &strict, Ok("Ship the Vercel build".into()), false), Ok("Ship the Vercel build".into()));
    assert_eq!(outcome(looped, &fragment, Ok("Vercel works".into()), true), Ok("Vercel works".into()));
    // Otherwise a stopped pass is cancelled, whatever it echoed.
    assert_eq!(outcome(recital, &strict, Err(Error::Cancelled), true), Err(Error::Cancelled));
    assert_eq!(outcome(looped, &fragment, Err(Error::Cancelled), true), Err(Error::Cancelled));
  }

  #[test]
  fn a_pinned_language_skips_detection_and_auto_keeps_it() {
    assert_eq!(pinned("auto"), None);
    assert_eq!(pinned("tr"), lang_id("tr"));
    assert!(pinned("tr").is_some());
    assert_eq!(pinned("xx"), None);
  }
}
