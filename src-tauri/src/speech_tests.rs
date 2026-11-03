use super::*;

/// The engine on the models in `root`, as a launch with Turbo chosen leaves it.
fn loaded(root: &Path) -> LocalSpeech {
  let speech = LocalSpeech::new(root.to_owned());
  speech.enabled.store(true, Ordering::Relaxed);
  *speech.engine.lock().unwrap() = Some(Engine::load(root, settings::Model::Turbo).unwrap());
  *speech.vad.lock().unwrap() = Some(load_vad(root).unwrap());
  speech
}

#[test]
fn download_client_initializes_tls_in_a_fresh_process() {
  const PROBE: &str = "TABTASKER_VOICE_CLIENT_TEST";
  if std::env::var_os(PROBE).is_some() {
    assert!(rustls::crypto::CryptoProvider::get_default().is_none());
    assert!(download_client().is_ok());
    assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    return;
  }
  let output = std::process::Command::new(std::env::current_exe().unwrap())
    .args(["--exact", "speech::tests::download_client_initializes_tls_in_a_fresh_process", "--nocapture"])
    .env(PROBE, "1").output().unwrap();
  assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
}

#[test]
fn model_bytes_must_match_both_pinned_size_and_hash() {
  let dir = std::env::temp_dir().join(format!("tabtasker-speech-integrity-{}", std::process::id()));
  std::fs::create_dir_all(&dir).unwrap();
  let path = dir.join("model.bin");
  let model = Model { name: "model.bin", label: "test", url: "", bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
  std::fs::write(&path, b"abc").unwrap(); assert!(verify_model(&path, &model).is_ok());
  std::fs::write(&path, b"abd").unwrap(); assert!(verify_model(&path, &model).is_err());
  std::fs::write(&path, b"ab").unwrap(); assert!(verify_model(&path, &model).is_err());
  std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn invalid_and_silent_audio_never_reaches_the_model() {
  assert!(validate_audio(&[]).is_err());
  assert!(validate_audio(&vec![0.0; 16000]).is_err());
  assert!(validate_audio(&vec![f32::NAN; 16000]).is_err());
  assert!(validate_audio(&vec![0.5; HANDS_FREE_SAMPLES + 1]).is_err());
  assert!(validate_audio(&vec![0.25; HANDS_FREE_SAMPLES]).is_ok()); // a hands-free session reaches ten minutes
  assert!(validate_audio(&vec![0.25; 16000]).is_ok());
}

#[test]
fn the_encoder_sees_the_speech_plus_room_never_more_than_whisper_window() {
  assert_eq!(audio_ctx(16000), 50 + 128);
  assert_eq!(audio_ctx(16001), 51 + 128);
  assert_eq!(audio_ctx(MAX_SAMPLES), 1500);
}

#[test]
fn cancellation_and_deadline_abort_local_inference() {
  let flag = Arc::new(AtomicBool::new(false));
  let mut abort = Abort { cancelled: flag.clone(), started: Instant::now(), piece: None };
  assert!(!unsafe { should_abort((&mut abort as *mut Abort).cast()) });
  flag.store(true, Ordering::Relaxed);
  assert!(unsafe { should_abort((&mut abort as *mut Abort).cast()) });
  flag.store(false, Ordering::Relaxed); abort.started = Instant::now() - Duration::from_secs(121);
  assert!(unsafe { should_abort((&mut abort as *mut Abort).cast()) });
}

#[test]
fn a_meeting_piece_gives_the_engine_up_to_a_release_pause_and_quit() {
  let speech: &'static LocalSpeech = Box::leak(Box::new(LocalSpeech::new(PathBuf::new())));
  speech.enabled.store(true, Ordering::Relaxed);
  let mut abort = Abort { cancelled: Arc::default(), started: Instant::now(), piece: Some(speech) };
  let stops = |abort: &mut Abort| unsafe { should_abort((abort as *mut Abort).cast()) };
  assert!(!stops(&mut abort));
  speech.releases.fetch_add(1, Ordering::SeqCst);
  assert!(stops(&mut abort));
  speech.releases.fetch_sub(1, Ordering::SeqCst);
  speech.enabled.store(false, Ordering::Relaxed);
  assert!(stops(&mut abort));
  // A hold's own pass never yields to these.
  assert!(!stops(&mut Abort { cancelled: Arc::default(), started: Instant::now(), piece: None }));
}

#[tokio::test]
async fn cancellation_interrupts_a_stalled_download() {
  let cancel = Arc::new(AtomicBool::new(false));
  let signal = cancel.clone();
  let waiting = tokio::spawn(async move {
    cancellable(&signal, std::future::pending::<Result<(), String>>()).await
  });
  tokio::task::yield_now().await;
  cancel.store(true, Ordering::Relaxed);
  assert!(tokio::time::timeout(Duration::from_millis(500), waiting).await.unwrap().unwrap().is_err());
}

#[test]
#[ignore = "Downloads are explicit; set TABTASKER_SPEECH_FIXTURE_DIR to verified models and 16 kHz mono fixture.f32"]
fn real_local_model_transcribes_fixture_and_rejects_silence() {
  let root = PathBuf::from(std::env::var("TABTASKER_SPEECH_FIXTURE_DIR").unwrap());
  for model in WITH_TURBO { verify_model(&root.join(model.name), model).unwrap(); }
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
fn a_note_is_cut_where_a_pause_closes_a_long_enough_piece() {
  use note::{cut, PIECE};
  let ms = |m: usize| m * 16;
  let said = |a: usize, b: usize| (ms(a), ms(b));
  assert_eq!(cut(&[said(0, 4000)], ms(4100)), None); // still talking
  assert_eq!(cut(&[said(0, 7000), said(7600, 9000)], ms(9000)), Some(ms(7300))); // in the middle of the pause
  assert_eq!(cut(&[said(0, 2000), said(2600, 5000)], ms(5000)), None); // a piece is a sentence, not a word
  assert_eq!(cut(&[said(0, 8000)], ms(9000)), Some(ms(8500))); // the speech stopped
  // Past Whisper's window: its last pause, or the window itself when the speech never paused.
  assert_eq!(cut(&[said(0, 3000), said(3500, 26000)], ms(26000)), Some(ms(3250)));
  assert_eq!(cut(&[said(0, 26000)], ms(26000)), Some(PIECE));
  assert_eq!(cut(&[], ms(7000)), Some(ms(6600))); // silence goes, keeping a moment for a word starting
  assert_eq!(cut(&[], ms(3000)), None);
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
fn each_model_choice_downloads_its_whisper_and_the_speech_detection() {
  for (choice, name) in [(settings::Model::Turbo, "ggml-acft-large-v3-turbo-q8_0.bin"), (settings::Model::Small, "ggml-small-q8_0.bin")] {
    let names: Vec<&str> = files(choice).iter().map(|model| model.name).collect();
    assert_eq!(names, [name, SILERO.name]);
    for model in files(choice) {
      assert!(model.url.starts_with("https://") && model.url.ends_with(model.name), "{}", model.url);
      assert_eq!(model.sha256.len(), 64);
      assert!(model.sha256.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    }
  }
  // whisper.cpp's own small model, as published.
  assert_eq!((SMALL.bytes, SMALL.sha256), (264464607, "49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f"));
  assert!(SMALL.url.starts_with("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/"));
}

#[test]
fn the_vocabulary_prompt_is_newest_first_and_stays_under_its_budget() {
  let words: Vec<String> = ["Kubernetes", " ", "TabTasker", "İstanbul", "Can Turgut", "a\0b", "Vehicularis"].map(String::from).to_vec();
  assert_eq!(prompt_text(&words, |_| true), (" Kubernetes, TabTasker, İstanbul, Can Turgut, Vehicularis".into(), 5));
  // A budget keeps the newest words that fit, and never a part of one.
  assert_eq!(prompt_text(&words, |text| text.chars().count() <= 40), (" Kubernetes, TabTasker, İstanbul".into(), 3));
  assert_eq!(prompt_text(&words, |text| text.len() < 5), (String::new(), 0));
  assert_eq!(prompt_text(&[], |_| true), (String::new(), 0));
}

#[test]
fn a_pinned_language_skips_detection_and_auto_keeps_it() {
  assert_eq!(pinned("auto"), None);
  assert_eq!(pinned("tr"), whisper_rs::get_lang_id("tr"));
  assert!(pinned("tr").is_some());
  assert_eq!(pinned("xx"), None);
  // With no hold and the default settings, the language is whatever the passes hear.
  assert_eq!(language("nobody"), None);
}

#[test]
fn small_sees_the_whole_window_and_turbo_only_the_speech() {
  assert_eq!(encoder_ctx(settings::Model::Turbo, 16000), 178);
  assert_eq!(encoder_ctx(settings::Model::Small, 16000), 0);
  assert_eq!(encoder_ctx(settings::Model::Small, MAX_SAMPLES), 0);
}

#[test]
fn a_hands_free_session_may_send_ten_minutes_and_a_hold_one() {
  context::remember(context::HoldContext::new("free", context::Mode::HandsFree, "", ""));
  context::remember(context::HoldContext::new("held", context::Mode::Dictate, "", ""));
  assert_eq!(max_samples("free"), HANDS_FREE_SAMPLES);
  assert!(max_samples("free") > MAX_SAMPLES);
  assert_eq!(max_samples("held"), MAX_SAMPLES);
  assert_eq!(max_samples("never announced"), MAX_SAMPLES);
  context::forget("free"); context::forget("held");
}

#[test]
fn a_hands_free_session_is_heard_past_its_words_and_finished_piece_by_piece() {
  context::remember(context::HoldContext::new("long", context::Mode::HandsFree, "", ""));
  let speech = LocalSpeech::new(PathBuf::new());
  // Nothing in yet: a draft hears it all, and a short session finishes like a hold.
  assert_eq!(speech.unheard("long", 16000), 0);
  assert!(!speech.long("long", note::PIECE));
  assert!(speech.long("long", note::PIECE + 1));
  // With words in, only the audio past them, never past its end; and it finishes piece by piece.
  speech.note("long", |note| note.committed = 6 * 16000);
  assert_eq!(speech.unheard("long", 10 * 16000), 6 * 16000);
  assert_eq!(speech.unheard("long", 6 * 16000), 6 * 16000);
  assert_eq!(speech.unheard("long", 4 * 16000), 4 * 16000);
  assert!(speech.long("long", 16000));
  // A plain hold is always heard whole and finished at once.
  speech.note("held", |note| note.committed = 6 * 16000);
  assert_eq!(speech.unheard("held", 10 * 16000), 0);
  assert!(!speech.long("held", MAX_SAMPLES));
  context::forget("long");
}

#[test]
fn with_no_model_loaded_one_on_this_mac_answers_while_the_chosen_one_downloads() {
  let root = std::env::temp_dir().join(format!("tabtasker-speech-fallback-{}", std::process::id()));
  std::fs::create_dir_all(&root).unwrap();
  // Sparse files of the pinned sizes: what Settings counts as downloaded.
  let put = |model: settings::Model| for file in files(model) { File::create(root.join(file.name)).unwrap().set_len(file.bytes).unwrap(); };
  use settings::Model::{Small, Turbo};
  assert_eq!(first_load(&root, Small, false), Small); // nothing here: the chosen one downloads
  put(Turbo);
  assert_eq!(first_load(&root, Small, false), Turbo);
  assert_eq!(first_load(&root, Small, true), Small); // a model in use answers while Small comes as a swap
  assert_eq!(first_load(&root, Turbo, false), Turbo);
  put(Small);
  assert_eq!(first_load(&root, Small, false), Small);
  std::fs::remove_file(root.join(TURBO.name)).unwrap();
  assert_eq!(first_load(&root, Turbo, false), Small);
  std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_window_is_silence_only_when_whisper_is_unsure_of_its_words_too() {
  assert!(super::silent(0.9, -1.6), "no speech, and the words a guess");
  assert!(!super::silent(0.9, -0.3), "clear words after a pause are kept");
  assert!(!super::silent(0.4, -1.6), "unsure words where someone spoke are kept");
  assert!(super::silent(0.7, f32::NEG_INFINITY), "a window with no words at all");
}

#[test]
fn a_recited_vocabulary_is_told_from_a_sentence_that_uses_it() {
  let words: Vec<String> = ["Kubernetes", "Vercel", "TabTasker", "Maria Lopez"].iter().map(|word| word.to_string()).collect();
  assert!(super::echoes_prompt("Kubernetes, Vercel, TabTasker.", &words), "the list, in its order");
  assert!(super::echoes_prompt("Vercel Vercel Vercel", &words), "one word over and over");
  assert!(super::echoes_prompt("TabTasker,", &words), "a short run ending in a comma");
  assert!(!super::echoes_prompt("Deploy it to Vercel before Maria Lopez gets in.", &words), "a sentence using two of them");
  assert!(!super::echoes_prompt("Vercel", &words), "one vocabulary word said alone is a word");
  assert!(!super::echoes_prompt("Kubernetes, Vercel", &[]), "nothing to echo without a vocabulary");
}

#[test]
fn audio_quieter_than_a_breath_is_silence() {
  assert!(super::silent_audio(&vec![0.0005; 16_000]));
  let mut said = vec![0.0005; 16_000];
  for (i, sample) in said[4_000..6_000].iter_mut().enumerate() { *sample = 0.02 * (i as f32 * 0.3).sin(); } // a quiet word on the built-in mic
  assert!(!super::silent_audio(&said));
}
