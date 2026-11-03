//! Who said what in a meeting: speaker diarization on this Mac, with sherpa-onnx (pyannote's
//! segmentation model finds where voices start and stop, a speaker-embedding model gives each stretch a
//! voiceprint, and clustering groups the voiceprints into speakers). Two small models are downloaded the
//! first time a meeting needs them, next to the voice models.
use crate::dictation::speech::{self, Model};
use sherpa_onnx::{FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig, OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig, SpeakerEmbeddingExtractorConfig};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// pyannote/segmentation-3.0 as sherpa-onnx ships it (MIT), in its archive; the model inside is kept beside it.
const SEGMENTATION: Model = Model {
  name: "speakers/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2", label: "speaker segmentation", bytes: 6_958_444,
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
  sha256: "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488",
};
/// NVIDIA NeMo's TitaNet small (CC BY 4.0), the English-trained speaker embedding sherpa-onnx recommends.
const EMBEDDING: Model = Model {
  name: "speakers/nemo_en_titanet_small.onnx", label: "speaker voices", bytes: 40_257_283,
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx",
  sha256: "ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e",
};
const MODELS: &[Model] = &[SEGMENTATION, EMBEDDING];
const SEGMENTATION_ONNX: &str = "speakers/pyannote-segmentation-3-0.onnx";
/// The member of the archive that is the model.
const ARCHIVE_MEMBER: &str = "sherpa-onnx-pyannote-segmentation-3-0/model.onnx";
/// How far apart two voiceprints must be to count as two people: sherpa-onnx's default. Higher merges more.
const THRESHOLD: f32 = 0.5;
/// A voice heard for less than this, over the whole recording, isn't a person but a slip of the clustering (a
/// cough, the room's echo of the call, one line cut in two): its turns go to the voice heard nearest in time.
const SLIVER: f32 = 4.0;
const RATE: f32 = 16_000.0;

/// One stretch of one voice, in samples from the start of the stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Turn { pub start: u64, pub end: u64, pub speaker: u32 }

static PREPARING: AtomicBool = AtomicBool::new(false);

/// Both models on disk, ready to run.
pub fn ready(root: &Path) -> bool {
  root.join(SEGMENTATION_ONNX).is_file() && std::fs::metadata(root.join(EMBEDDING.name)).is_ok_and(|meta| meta.len() == EMBEDDING.bytes)
}

/// Downloads what is missing and unpacks the segmentation model. Errors are the downloader's words.
pub async fn prepare(root: PathBuf) -> Result<(), String> {
  let never = AtomicBool::new(false);
  speech::fetch(&root, MODELS, &never, &|line, _| log::info!("speakers: {line}")).await?;
  if root.join(SEGMENTATION_ONNX).is_file() { return Ok(()); }
  let dir = root.join("speakers");
  let (archive, into) = (root.join(SEGMENTATION.name).display().to_string(), dir.display().to_string());
  let unpacked = tauri::async_runtime::spawn_blocking(move || {
    std::process::Command::new("/usr/bin/tar").args(["-xjf", &archive, "-C", &into, "--strip-components=1", ARCHIVE_MEMBER]).output()
  }).await.map_err(|e| e.to_string())?.map_err(|e| format!("Couldn’t unpack the speaker model: {e}"))?;
  if !unpacked.status.success() { return Err(format!("Couldn’t unpack the speaker model: {}", String::from_utf8_lossy(&unpacked.stderr).trim())); }
  std::fs::rename(dir.join("model.onnx"), root.join(SEGMENTATION_ONNX)).map_err(|e| format!("Couldn’t install the speaker model: {e}"))
}

/// Starts the download in the background when Meetings wants speakers told apart and the models aren't
/// here yet: called as a meeting begins, so they are usually ready by the time it ends.
pub fn prepare_in_background() {
  if !crate::settings::get().meetings.speakers { return; }
  let Some(root) = speech::models_root() else { return };
  if ready(&root) || PREPARING.swap(true, Ordering::SeqCst) { return; }
  tauri::async_runtime::spawn(async move {
    match prepare(root).await {
      Ok(()) => log::info!("speakers: models ready"),
      Err(e) => log::warn!("speakers: {e}"),
    }
    PREPARING.store(false, Ordering::SeqCst);
  });
}

/// Who spoke when in `samples` (16 kHz mono), as the models hear it. Blocking, and slow on a long
/// meeting (about a tenth of its length); run it where waiting is fine.
pub fn diarize(root: &Path, samples: &[f32]) -> Result<Vec<Turn>, String> {
  if !ready(root) { return Err("The speaker models aren’t downloaded yet.".into()); }
  // Six threads: eight measured no faster, and the other stream runs alongside.
  let threads = std::thread::available_parallelism().map_or(4, |n| n.get().clamp(2, 6)) as i32;
  let config = OfflineSpeakerDiarizationConfig {
    segmentation: OfflineSpeakerSegmentationModelConfig {
      pyannote: OfflineSpeakerSegmentationPyannoteModelConfig { model: Some(root.join(SEGMENTATION_ONNX).display().to_string()), ..Default::default() },
      num_threads: threads, ..Default::default()
    },
    embedding: SpeakerEmbeddingExtractorConfig { model: Some(root.join(EMBEDDING.name).display().to_string()), num_threads: threads, ..Default::default() },
    clustering: FastClusteringConfig { num_clusters: -1, threshold: THRESHOLD, ..Default::default() },
    min_duration_on: 0.3, min_duration_off: 0.5,
  };
  let diarizer = OfflineSpeakerDiarization::create(&config).ok_or("Couldn’t load the speaker models.")?;
  if diarizer.sample_rate() != RATE as i32 { return Err(format!("The speaker model wants {} Hz audio", diarizer.sample_rate())); }
  let result = diarizer.process(samples).ok_or("Couldn’t tell the speakers apart.")?;
  let mut turns: Vec<Turn> = result.sort_by_start_time().into_iter()
    .filter(|segment| segment.speaker >= 0 && segment.end > segment.start)
    .map(|segment| Turn { start: (segment.start * RATE) as u64, end: (segment.end * RATE) as u64, speaker: segment.speaker as u32 })
    .collect();
  turns.sort_by_key(|turn| turn.start);
  Ok(settle(turns))
}

/// The voices as people: a voice with under SLIVER seconds in all gives its turns to the voice heard nearest in
/// time, before or after. The voice heard most always stands, however short the recording.
pub fn settle(mut turns: Vec<Turn>) -> Vec<Turn> {
  turns.sort_by_key(|turn| turn.start);
  let mut spoke: std::collections::HashMap<u32, u64> = std::collections::HashMap::new();
  for turn in &turns { *spoke.entry(turn.speaker).or_default() += turn.end - turn.start; }
  let longest = spoke.values().copied().max().unwrap_or(0);
  let stands = |voice: u32| spoke[&voice] >= (SLIVER * RATE) as u64 || spoke[&voice] == longest;
  let anchors: Vec<Turn> = turns.iter().copied().filter(|turn| stands(turn.speaker)).collect();
  for turn in turns.iter_mut().filter(|turn| !stands(turn.speaker)) {
    let gap = |anchor: &Turn| anchor.start.saturating_sub(turn.end).max(turn.start.saturating_sub(anchor.end));
    if let Some(nearest) = anchors.iter().min_by_key(|anchor| gap(anchor)) { turn.speaker = nearest.speaker; }
  }
  turns
}

#[cfg(test)]
mod tests {
  use super::*;

  fn turn(start: f32, end: f32, speaker: u32) -> Turn { Turn { start: (start * RATE) as u64, end: (end * RATE) as u64, speaker } }

  #[test]
  fn a_sliver_of_a_voice_goes_to_the_voice_nearest_in_time() {
    let turns = settle(vec![turn(0.0, 6.0, 0), turn(6.2, 7.0, 7), turn(9.0, 15.0, 1), turn(15.1, 16.0, 7), turn(16.5, 17.0, 3)]);
    assert_eq!(turns.iter().map(|turn| turn.speaker).collect::<Vec<_>>(), vec![0, 0, 1, 1, 1]);
  }

  #[test]
  fn the_voice_heard_most_stands_however_short() {
    let turns = settle(vec![turn(0.0, 1.0, 4), turn(1.5, 2.0, 2)]);
    assert_eq!(turns.iter().map(|turn| turn.speaker).collect::<Vec<_>>(), vec![4, 4]);
    assert!(settle(Vec::new()).is_empty());
  }

  /// Runs the real models over a recording: `DICTATE_SPEAKER_PCM` is 16-bit little-endian 16 kHz mono,
  /// `DICTATE_MODELS_ROOT` the voice-models folder with `speakers/` in it. Ignored by default, since
  /// it needs both on disk: `cargo test diarizes -- --ignored`.
  #[test]
  #[ignore]
  fn diarizes_a_recording_into_its_voices() {
    let (Ok(pcm), Ok(root)) = (std::env::var("DICTATE_SPEAKER_PCM"), std::env::var("DICTATE_MODELS_ROOT")) else { panic!("set DICTATE_SPEAKER_PCM and DICTATE_MODELS_ROOT") };
    let bytes = std::fs::read(pcm).unwrap();
    let samples: Vec<f32> = bytes.as_chunks::<2>().0.iter().map(|pair| i16::from_le_bytes(*pair) as f32 / 32768.0).collect();
    let began = std::time::Instant::now();
    let turns = diarize(Path::new(&root), &samples).unwrap();
    let voices: std::collections::BTreeSet<u32> = turns.iter().map(|turn| turn.speaker).collect();
    for turn in &turns { eprintln!("speaker {} {:6.2}s – {:6.2}s", turn.speaker, turn.start as f32 / RATE, turn.end as f32 / RATE); }
    eprintln!("{} voices, {} turns, {:.1}s of audio in {:.1}s", voices.len(), turns.len(), samples.len() as f32 / RATE, began.elapsed().as_secs_f32());
    let expected: usize = std::env::var("DICTATE_SPEAKER_COUNT").ok().and_then(|n| n.parse().ok()).unwrap_or(2);
    assert_eq!(voices.len(), expected, "voices heard");
  }
}
