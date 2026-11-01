use super::*;

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
  assert!(validate_audio(&vec![0.5; MAX_SAMPLES + 1]).is_err());
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
  let mut abort = Abort { cancelled: flag.clone(), started: Instant::now() };
  assert!(!unsafe { should_abort((&mut abort as *mut Abort).cast()) });
  flag.store(true, Ordering::Relaxed);
  assert!(unsafe { should_abort((&mut abort as *mut Abort).cast()) });
  flag.store(false, Ordering::Relaxed); abort.started = Instant::now() - Duration::from_secs(121);
  assert!(unsafe { should_abort((&mut abort as *mut Abort).cast()) });
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
  for model in MODELS { verify_model(&root.join(model.name), model).unwrap(); }
  let bytes = std::fs::read(root.join("fixture.f32")).unwrap();
  let pcm: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
  let started = Instant::now();
  let speech = LocalSpeech {
    root: root.clone(), enabled: AtomicBool::new(true), preparing: Mutex::default(), job: Mutex::default(),
    engine: Mutex::new(Some(Engine::load(&root).unwrap())), vad: Mutex::new(Some(load_vad(&root).unwrap())), draft: Mutex::default(), hold: Mutex::default(), note: Mutex::default(),
  };
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
    bytes[at..].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
  };
  // The English clips twice over with the pauses of someone thinking: well past the one-minute hold.
  let english: Vec<(&str, &str)> = manifest.lines().filter_map(|line| { let mut cols = line.split('\t'); Some((cols.next()?, cols.nth(1)?)).filter(|_| line.contains("\ten\t")) }).collect();
  let mut stream = Vec::new();
  for _ in 0..2 { for (name, _) in &english { stream.extend(wav(name)); stream.extend(vec![0.0f32; 12_800]); } }
  assert!(stream.len() > 90 * 16000, "{} s", stream.len() / 16000);
  let speech = LocalSpeech {
    root: root.clone(), enabled: AtomicBool::new(true), preparing: Mutex::default(), job: Mutex::default(),
    engine: Mutex::new(Some(Engine::load(&root).unwrap())), vad: Mutex::new(Some(load_vad(&root).unwrap())), draft: Mutex::default(), hold: Mutex::default(), note: Mutex::default(),
  };
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
