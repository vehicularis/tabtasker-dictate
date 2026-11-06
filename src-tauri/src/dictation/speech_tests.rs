use super::*;
use std::time::Duration;

/// The engine on the models in `root`, as a launch with Turbo chosen leaves it.
fn loaded(root: &Path) -> LocalSpeech {
  let speech = LocalSpeech::new(root.to_owned());
  speech.enabled.store(true, Ordering::Relaxed);
  *speech.engine.lock().unwrap() = Some(Whisper::load(&root.join(Model::Turbo.files()[0].name), Model::Turbo).unwrap());
  *speech.vad.lock().unwrap() = Some(SpeechDetector::load(&root.join(SILERO.name)).unwrap());
  speech
}

#[test]
fn a_meeting_piece_gives_the_engine_up_to_a_release_pause_and_quit() {
  let speech = LocalSpeech::new(PathBuf::new());
  speech.enabled.store(true, Ordering::Relaxed);
  assert!(!speech.piece_yields());
  speech.releases.fetch_add(1, Ordering::SeqCst);
  assert!(speech.piece_yields());
  speech.releases.fetch_sub(1, Ordering::SeqCst);
  speech.enabled.store(false, Ordering::Relaxed);
  assert!(speech.piece_yields());
}

#[test]
fn a_meeting_piece_yields_to_a_release_but_a_holds_pass_does_not() {
  let speech = LocalSpeech::new(PathBuf::new());
  let own = AtomicBool::new(false);
  speech.enabled.store(true, Ordering::Relaxed);
  assert!(!speech.piece_stopped(&own));
  speech.releases.fetch_add(1, Ordering::SeqCst);
  assert!(speech.piece_stopped(&own));
  // A hold's pass stops on its own flag only.
  assert!(!own.load(Ordering::Relaxed));
  speech.releases.fetch_sub(1, Ordering::SeqCst);
  speech.enabled.store(false, Ordering::Relaxed);
  assert!(speech.piece_stopped(&own));
  speech.enabled.store(true, Ordering::Relaxed);
  own.store(true, Ordering::Relaxed);
  assert!(speech.piece_stopped(&own));
}

#[test]
#[ignore = "Downloads are explicit; set TABTASKER_SPEECH_FIXTURE_DIR to verified models and 16 kHz mono fixture.f32"]
fn real_local_model_transcribes_fixture_and_rejects_silence() {
  let root = PathBuf::from(std::env::var("TABTASKER_SPEECH_FIXTURE_DIR").unwrap());
  for model in Model::Turbo.files() { models::verify(&root.join(model.name), model).unwrap(); }
  let bytes = std::fs::read(root.join("fixture.f32")).unwrap();
  let pcm: Vec<f32> = bytes.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect();
  let started = Instant::now();
  let speech = loaded(&root);
  let loaded = started.elapsed();
  let flag = Arc::new(AtomicBool::new(false));
  let result = speech.finish("first", &pcm, flag.clone()).unwrap();
  println!("Model load: {loaded:?}; total: {:?}; transcript: {result}", started.elapsed());
  let expected = std::env::var("TABTASKER_SPEECH_EXPECT").unwrap_or_else(|_| "ask not".into());
  assert!(result.to_lowercase().contains(&expected.to_lowercase()), "{result}");
  // A live pass that heard the speech to its end is the answer at release, with no pass of its own.
  let paused = [pcm.clone(), vec![0.0; 8000]].concat();
  let live = speech.draft(speech.engine.lock().unwrap().as_mut().unwrap(), "live", &paused, flag.clone()).unwrap();
  assert!(speech.hold("live", |hold| hold.language).is_some());
  let released = Instant::now();
  assert_eq!(speech.finish("live", &paused, flag.clone()).unwrap(), live);
  assert!(released.elapsed() < Duration::from_millis(300), "{:?}", released.elapsed());
  // A short, quiet word after a pause is speech the live pass never heard.
  let word: Vec<f32> = pcm[32_000..35_200].iter().map(|sample| sample * 0.3).collect();
  let afterthought = [paused.clone(), word, vec![0.0; 4800]].concat();
  assert!(speech.speech_end(&afterthought).unwrap() + SETTLED > paused.len());
  // One that stopped before the speech did is not.
  let early = speech.draft(speech.engine.lock().unwrap().as_mut().unwrap(), "late", &pcm[..pcm.len() / 2], flag.clone()).unwrap();
  assert_ne!(speech.finish("late", &paused, flag.clone()).unwrap(), early);
  assert!(speech.finish("silence", &vec![0.0; 16000], flag.clone()).is_err());
  let tone: Vec<f32> = (0..16000).map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / 16000.0).sin() * 0.05).collect();
  assert!(speech.finish("tone", &tone, flag.clone()).is_err());
  flag.store(true, Ordering::Relaxed);
  let cancelled = Instant::now();
  assert!(speech.finish("cancelled", &pcm, flag).is_err());
  assert!(cancelled.elapsed() < Duration::from_millis(300), "{:?}", cancelled.elapsed()); // no language detection first
}

#[test]
#[ignore = "Needs TABTASKER_SPEECH_FIXTURE_DIR (models) and CLIPS (the eval clips with manifest.tsv)"]
fn a_long_note_is_transcribed_while_it_is_said_and_finishes_at_once() {
  let root = PathBuf::from(std::env::var("TABTASKER_SPEECH_FIXTURE_DIR").unwrap());
  let clips = PathBuf::from(std::env::var("CLIPS").unwrap());
  let manifest = std::fs::read_to_string(clips.join("manifest.tsv")).unwrap();
  let wav = |name: &str| -> Vec<f32> {
    let bytes = std::fs::read(clips.join(name)).unwrap();
    let at = bytes.windows(4).position(|w| w == b"data").unwrap() + 8;
    bytes[at..].as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect()
  };
  // The English clips twice over with the pauses of someone thinking: well past the one-minute hold.
  let english: Vec<(&str, &str)> = manifest.lines().filter_map(|line| { if !line.contains("\ten\t") { return None; } let mut cols = line.split('\t'); Some((cols.next()?, cols.nth(1)?)) }).collect();
  let mut stream = Vec::new();
  for _ in 0..2 { for (name, _) in &english { stream.extend(wav(name)); stream.extend(vec![0.0f32; 12_800]); } }
  assert!(stream.len() > 90 * 16000, "{} s", stream.len() / 16000);
  let speech = loaded(&root);
  let go = || Arc::new(AtomicBool::new(false));
  speech.note("note", |_| ()); // the first step begins it
  // What the Mac does: every half second, the audio it still holds; it drops what is transcribed.
  let (mut dropped, mut steps, mut slowest) = (0, 0, Duration::ZERO);
  for now in (8000..=stream.len()).step_by(8000) {
    let started = Instant::now();
    let (committed, _) = speech.note_step(speech.engine.lock().unwrap().as_mut().unwrap(), "note", dropped, &stream[dropped..now], go()).unwrap();
    slowest = slowest.max(started.elapsed()); steps += 1;
    dropped = committed;
  }
  let held = stream.len() - dropped;
  let started = Instant::now();
  let text = speech.note_finish(speech.engine.lock().unwrap().as_mut().unwrap(), "note", dropped, &stream[dropped..], go()).unwrap();
  let finished = started.elapsed();
  println!("{} s of note, {steps} steps (slowest {slowest:?}), {} s left at the end, finished in {finished:?}\n{text}", stream.len() / 16000, held / 16000);
  assert!(held < 30 * 16000, "{} s left untranscribed", held / 16000);
  assert!(finished < Duration::from_secs(3), "{finished:?}");
  // Every clip is in the note, both times: its longest word, in order of first appearance.
  let lower = text.to_lowercase();
  for (_, said) in &english {
    let word = said.split(|c: char| !c.is_alphanumeric()).max_by_key(|word| word.len()).unwrap().to_lowercase();
    assert!(lower.matches(&word).count() >= 2, "{word:?} missing from: {text}");
  }
  // A step of a note that was cancelled leaves the next note alone.
  speech.note("next", |_| ());
  assert!(speech.note_step(speech.engine.lock().unwrap().as_mut().unwrap(), "note", 0, &stream[..16000 * 9], go()).is_err());
  speech.forget_note("note");
  assert!(speech.note_step(speech.engine.lock().unwrap().as_mut().unwrap(), "next", 0, &stream[..16000], go()).is_ok());
}

#[test]
fn with_no_hold_and_the_default_settings_the_language_is_what_the_passes_hear() {
  assert_eq!(language("nobody"), None);
}

#[test]
fn a_hands_free_session_may_send_ten_minutes_and_a_hold_five() {
  context::remember(context::HoldContext::new("free", context::Mode::HandsFree, "", ""));
  context::remember(context::HoldContext::new("held", context::Mode::Dictate, "", ""));
  assert_eq!(max_samples("free"), HANDS_FREE_SAMPLES);
  assert!(max_samples("free") > MAX_SAMPLES);
  assert_eq!(max_samples("held"), MAX_SAMPLES);
  assert_eq!(MAX_SAMPLES, 5 * 60 * 16000);
  assert_eq!(max_samples("never announced"), MAX_SAMPLES);
  context::forget("free"); context::forget("held");
}

#[test]
fn a_hands_free_session_is_heard_past_its_words_and_finished_piece_by_piece() {
  context::remember(context::HoldContext::new("long", context::Mode::HandsFree, "", ""));
  let speech = LocalSpeech::new(PathBuf::new());
  // Nothing in yet: a draft hears it all, and a short session finishes like a hold.
  assert_eq!(speech.unheard("long", 16000), 0);
  assert!(!speech.long("long", pieces::PIECE));
  assert!(speech.long("long", pieces::PIECE + 1));
  // With words in, only the audio past them, never past its end; and it finishes piece by piece.
  speech.note("long", |note| note.committed = 6 * 16000);
  assert_eq!(speech.unheard("long", 10 * 16000), 6 * 16000);
  assert_eq!(speech.unheard("long", 6 * 16000), 6 * 16000);
  assert_eq!(speech.unheard("long", 4 * 16000), 4 * 16000);
  assert!(speech.long("long", 16000));
  // A plain hold is heard whole and finished at once until it runs past a piece; from then on its pieces
  // go into its words while the key is held, like a hands-free session's.
  context::remember(context::HoldContext::new("held", context::Mode::Dictate, "", ""));
  assert!(!pieced("held", pieces::PIECE) && pieced("held", pieces::PIECE + 1) && pieced("long", 16000));
  assert_eq!(speech.unheard("held", pieces::PIECE), 0);
  assert!(!speech.long("held", pieces::PIECE));
  assert!(speech.long("held", pieces::PIECE + 1));
  assert!(speech.long("held", MAX_SAMPLES));
  speech.note("held", |note| note.committed = 20 * 16000);
  assert_eq!(speech.unheard("held", pieces::PIECE), 0, "under a piece, nothing is in its words");
  assert_eq!(speech.unheard("held", 40 * 16000), 20 * 16000);
  context::forget("long"); context::forget("held");
}

#[test]
fn with_no_model_loaded_one_on_this_mac_answers_while_the_chosen_one_downloads() {
  let root = std::env::temp_dir().join(format!("tabtasker-speech-fallback-{}", std::process::id()));
  std::fs::create_dir_all(&root).unwrap();
  // Sparse files of the pinned sizes: what Settings counts as downloaded.
  let put = |model: Model| for file in model.files() { std::fs::File::create(root.join(file.name)).unwrap().set_len(file.bytes).unwrap(); };
  use Model::{Small, Turbo};
  assert_eq!(first_load(&root, Small, false), Small); // nothing here: the chosen one downloads
  put(Turbo);
  assert_eq!(first_load(&root, Small, false), Turbo);
  assert_eq!(first_load(&root, Small, true), Small); // a model in use answers while Small comes as a swap
  assert_eq!(first_load(&root, Turbo, false), Turbo);
  put(Small);
  assert_eq!(first_load(&root, Small, false), Small);
  std::fs::remove_file(root.join(Model::Turbo.files()[0].name)).unwrap();
  assert_eq!(first_load(&root, Turbo, false), Small);
  std::fs::remove_dir_all(root).unwrap();
}

fn temp_dir(name: &str) -> PathBuf {
  let dir = std::env::temp_dir().join(format!("tabtasker-speech-{name}-{}", std::process::id()));
  let _ = std::fs::remove_dir_all(&dir);
  std::fs::create_dir_all(&dir).unwrap();
  dir
}

#[test]
fn a_pass_that_panics_gives_back_what_it_claimed() {
  let dir = temp_dir("claim");
  let speech = LocalSpeech::new(dir.clone());
  let flag = Arc::new(AtomicBool::new(false));
  let unsent = dir.join("1.hold");
  std::fs::write(&unsent, b"audio").unwrap();
  *speech.job.lock().unwrap() = Some(("hold".into(), flag.clone()));
  *speech.draft.lock().unwrap() = Some(Draft { id: "hold".into(), samples: 16000, cancelled: flag.clone() });
  speech.note("hold", |note| note.busy = true);
  let panicked = catch_unwind(AssertUnwindSafe(|| {
    let mut claim = Claim::new(&speech); claim.job = Some(flag.clone()); claim.draft = true; claim.step = Some("hold".into()); claim.unsent = Some(unsent.clone());
    let _poisoned = speech.job.lock().unwrap(); // let go first, poisoned by the panic
    panic!("a pass that panics");
  }));
  assert!(panicked.is_err());
  assert!(speech.job.is_poisoned());
  assert!(lock(&speech.job).is_none() && lock(&speech.draft).is_none());
  assert!(!speech.note("hold", |note| note.busy));
  assert!(!unsent.exists());
  // A job given back early leaves a newer one alone.
  let newer = Arc::new(AtomicBool::new(false));
  let mut claim = Claim::new(&speech); claim.job = Some(flag.clone());
  *lock(&speech.job) = Some(("next".into(), newer.clone()));
  claim.end_job();
  drop(claim);
  assert!(lock(&speech.job).as_ref().is_some_and(|(id, _)| id == "next"));
  assert!(try_lock(&speech.job).is_some(), "a poisoned mutex is still free to take");
  std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_hold_kept_on_disk_comes_back_whole() {
  let dir = temp_dir("unsent");
  assert_eq!(LocalSpeech::new(dir.join("voice-models")).unsent, dir.join("unsent"), "beside the models' folder");
  let said = history::Entry { at_ms: 1_793_620_800_000, mode: "handsfree".into(), bundle_id: "com.apple.Notes".into(), app_name: "Notes".into(), seconds: 2.5, ..Default::default() };
  let pcm: Vec<f32> = (0..40_000).map(|i| (i as f32 * 0.01).sin() * 0.5).chain([f32::MIN_POSITIVE, -0.0, 1.0]).collect();
  let path = keep_unsent(&dir.join("unsent"), &said, &pcm).unwrap();
  assert_eq!(path, dir.join("unsent/1793620800000.hold"));
  assert!(!path.with_extension("tmp").exists());
  let (back, samples) = read_unsent(&path).unwrap();
  assert_eq!(back, said);
  assert_eq!(samples.iter().map(|s| s.to_bits()).collect::<Vec<_>>(), pcm.iter().map(|s| s.to_bits()).collect::<Vec<_>>());
  assert_eq!(context::Mode::parse(&back.mode), Some(context::Mode::HandsFree));
  // A write a crash cut short, and anything else in the folder, isn't a hold.
  std::fs::write(dir.join("unsent/2.tmp"), b"{}").unwrap();
  assert!(read_unsent(&dir.join("unsent/2.tmp")).is_err());
  std::fs::write(dir.join("unsent/3.hold"), b"no header").unwrap();
  assert!(read_unsent(&dir.join("unsent/3.hold")).is_err());
  std::fs::remove_dir_all(dir).unwrap();
}

