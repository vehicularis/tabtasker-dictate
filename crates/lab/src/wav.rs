//! A strict WAV reader and a simple writer. The lab reads 16 kHz mono and nothing else.

use std::path::Path;

const HOW: &str = "Convert it with: afconvert -f WAVE -d LEI16@16000 -c 1 in.wav out.wav";

/// The GUID of a WAVE_FORMAT_EXTENSIBLE sub-format after its first two bytes, which are the plain tag:
/// 1 for PCM, 3 for float (`0000000X-0000-0010-8000-00aa00389b71`).
const GUID_REST: [u8; 14] = [0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71];

/// Reads a 16 kHz mono WAV (16-bit PCM or 32-bit float, plain or WAVE_FORMAT_EXTENSIBLE as afconvert
/// writes it) as samples in -1..1.
pub fn read(path: &Path) -> Result<Vec<f32>, String> {
  let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
  let bytes = std::fs::read(path).map_err(|e| format!("cannot read {name}: {e}"))?;
  parse(&bytes, &name)
}

fn u16_at(b: &[u8], i: usize) -> u16 {
  u16::from_le_bytes([b[i], b[i + 1]])
}

fn u32_at(b: &[u8], i: usize) -> u32 {
  u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

fn parse(b: &[u8], name: &str) -> Result<Vec<f32>, String> {
  if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
    return Err(format!("{name} is not a WAV file; the lab reads 16 kHz mono WAV. {HOW}"));
  }
  let mut fmt: Option<(u16, u16, u32, u16)> = None;
  let mut pos = 12;
  while pos + 8 <= b.len() {
    let id = &b[pos..pos + 4];
    let size = u32_at(b, pos + 4) as usize;
    let body = pos + 8;
    if id == b"fmt " {
      if size < 16 || body + size.min(40) > b.len() {
        return Err(format!("{name} has a broken fmt chunk. {HOW}"));
      }
      let mut tag = u16_at(b, body);
      // WAVE_FORMAT_EXTENSIBLE: the plain tag is the start of the sub-format's GUID, after cbSize (22),
      // the valid bits and the channel mask.
      if tag == 0xFFFE {
        if size < 40 || u16_at(b, body + 16) < 22 {
          return Err(format!("{name} uses WAVE_FORMAT_EXTENSIBLE without its sub-format; the lab reads 16-bit PCM or 32-bit float. {HOW}"));
        }
        tag = match (u16_at(b, body + 24), &b[body + 26..body + 40]) {
          (sub @ (1 | 3), rest) if rest == GUID_REST => sub,
          _ => {
            return Err(format!("{name} uses WAVE_FORMAT_EXTENSIBLE with a sub-format the lab doesn't know; the lab reads 16-bit PCM or 32-bit float. {HOW}"))
          }
        };
      }
      fmt = Some((tag, u16_at(b, body + 2), u32_at(b, body + 4), u16_at(b, body + 14)));
    } else if id == b"data" {
      let (tag, channels, rate, bits) = fmt.ok_or_else(|| format!("{name} has its data before its fmt chunk. {HOW}"))?;
      match (tag, bits) {
        (1, 16) | (3, 32) => {}
        (1, n) => return Err(format!("{name} is {n}-bit PCM; the lab reads 16-bit PCM or 32-bit float. {HOW}")),
        (3, n) => return Err(format!("{name} is {n}-bit float; the lab reads 16-bit PCM or 32-bit float. {HOW}")),
        (t, _) => return Err(format!("{name} has format tag {t}; the lab reads 16-bit PCM or 32-bit float. {HOW}")),
      }
      if channels != 1 || rate != 16_000 {
        let layout = match channels {
          1 => "mono".to_string(),
          2 => "stereo".to_string(),
          n => format!("{n} channels"),
        };
        return Err(format!("{name} is {rate} Hz {layout}; the lab reads 16 kHz mono. {HOW}"));
      }
      let Some(data) = b.get(body..body + size) else {
        return Err(format!("{name} is cut short: its data chunk claims {size} bytes but only {} follow. {HOW}", b.len() - body));
      };
      let width = usize::from(bits / 8);
      if !size.is_multiple_of(width) {
        return Err(format!("{name} is cut short: its data chunk holds {size} bytes, not a whole number of {width}-byte samples. {HOW}"));
      }
      return Ok(if tag == 1 {
        data.as_chunks::<2>().0.iter().map(|c| f32::from(i16::from_le_bytes([c[0], c[1]])) / 32768.0).collect()
      } else {
        data.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
      });
    }
    pos = body + size + (size & 1);
  }
  Err(format!("{name} has no audio data. {HOW}"))
}

/// Writes 16-bit PCM, 16 kHz mono, for synthesized fixtures.
pub fn write(path: &Path, pcm: &[f32]) -> std::io::Result<()> {
  let data_len = (pcm.len() * 2) as u32;
  let mut out = Vec::with_capacity(44 + pcm.len() * 2);
  out.extend_from_slice(b"RIFF");
  out.extend_from_slice(&(36 + data_len).to_le_bytes());
  out.extend_from_slice(b"WAVEfmt ");
  out.extend_from_slice(&16u32.to_le_bytes());
  out.extend_from_slice(&1u16.to_le_bytes());
  out.extend_from_slice(&1u16.to_le_bytes());
  out.extend_from_slice(&16_000u32.to_le_bytes());
  out.extend_from_slice(&32_000u32.to_le_bytes());
  out.extend_from_slice(&2u16.to_le_bytes());
  out.extend_from_slice(&16u16.to_le_bytes());
  out.extend_from_slice(b"data");
  out.extend_from_slice(&data_len.to_le_bytes());
  for s in pcm {
    // The reader's scale, so 16-bit values come back exactly.
    out.extend_from_slice(&((s * 32768.0).round().clamp(-32768.0, 32767.0) as i16).to_le_bytes());
  }
  std::fs::write(path, out)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn chunk(id: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut v = id.to_vec();
    v.extend_from_slice(&(body.len() as u32).to_le_bytes());
    v.extend_from_slice(body);
    if body.len() % 2 == 1 {
      v.push(0);
    }
    v
  }

  fn fmt(tag: u16, channels: u16, rate: u32, bits: u16) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&tag.to_le_bytes());
    b.extend_from_slice(&channels.to_le_bytes());
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * u32::from(channels) * u32::from(bits) / 8).to_le_bytes());
    b.extend_from_slice(&(channels * bits / 8).to_le_bytes());
    b.extend_from_slice(&bits.to_le_bytes());
    chunk(b"fmt ", &b)
  }

  fn riff(chunks: &[Vec<u8>]) -> Vec<u8> {
    let body: Vec<u8> = chunks.concat();
    let mut v = b"RIFF".to_vec();
    v.extend_from_slice(&(body.len() as u32 + 4).to_le_bytes());
    v.extend_from_slice(b"WAVE");
    v.extend(body);
    v
  }

  fn floats(s: &[f32]) -> Vec<u8> {
    s.iter().flat_map(|x| x.to_le_bytes()).collect()
  }

  /// A folder of its own for each test, which the test removes.
  fn scratch(test: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("dictate-lab-wav-{test}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  /// `bytes` read back as a WAV named `bad.wav`.
  fn read_bytes(test: &str, bytes: &[u8]) -> Result<Vec<f32>, String> {
    let dir = scratch(test);
    std::fs::write(dir.join("bad.wav"), bytes).unwrap();
    let got = read(&dir.join("bad.wav"));
    std::fs::remove_dir_all(dir).unwrap();
    got
  }

  #[test]
  fn reads_16_bit_and_float_mono_at_16_khz() {
    // Every 16-bit value comes back exactly; past full scale is clamped.
    let exact: Vec<f32> = [0, 1, -1, 16384, -16384, 32767, -32768].map(|v: i16| f32::from(v) / 32768.0).to_vec();
    let dir = scratch("reads");
    let path = dir.join("int.wav");
    write(&path, &exact).unwrap();
    assert_eq!(read(&path).unwrap(), exact);
    write(&path, &[1.0, -1.0, 2.0, -2.0]).unwrap();
    assert_eq!(read(&path).unwrap(), vec![32767.0 / 32768.0, -1.0, 32767.0 / 32768.0, -1.0]);

    let float = riff(&[fmt(3, 1, 16_000, 32), chunk(b"data", &floats(&[0.25, -0.75]))]);
    std::fs::remove_dir_all(dir).unwrap();
    assert_eq!(read_bytes("float", &float).unwrap(), vec![0.25, -0.75]);
  }

  #[test]
  fn reads_a_fmt_chunk_longer_than_16_bytes() {
    // WAVEFORMATEX: the 16 bytes, then cbSize = 0.
    let mut long = fmt(1, 1, 16_000, 16);
    long[4] = 18;
    long.extend_from_slice(&[0, 0]);
    let bytes = riff(&[long, chunk(b"data", &16384i16.to_le_bytes())]);
    assert_eq!(read_bytes("long-fmt", &bytes).unwrap(), vec![0.5]);
  }

  #[test]
  fn refuses_what_it_cannot_read_and_says_how_to_convert() {
    let data = chunk(b"data", &[0, 0, 0, 0]);
    let cases: Vec<(Vec<u8>, &str)> = vec![
      (riff(&[fmt(1, 2, 16_000, 16), data.clone()]), "bad.wav is 16000 Hz stereo; the lab reads 16 kHz mono."),
      (riff(&[fmt(1, 1, 44_100, 16), data.clone()]), "bad.wav is 44100 Hz mono; the lab reads 16 kHz mono."),
      (riff(&[fmt(1, 1, 16_000, 8), data.clone()]), "bad.wav is 8-bit PCM;"),
      (riff(&[fmt(0xFFFE, 1, 16_000, 16), data.clone()]), "bad.wav uses WAVE_FORMAT_EXTENSIBLE without its sub-format;"),
      (
        {
          let mut v = riff(&[fmt(1, 1, 16_000, 16), data.clone()]);
          v.truncate(v.len() - 2);
          v
        },
        "bad.wav is cut short: its data chunk claims 4 bytes but only 2 follow.",
      ),
      (riff(&[fmt(1, 1, 16_000, 16), chunk(b"data", &[0, 0, 0])]), "bad.wav is cut short: its data chunk holds 3 bytes, not a whole number of 2-byte samples."),
      (riff(&[fmt(3, 1, 16_000, 32), chunk(b"data", &[0; 6])]), "bad.wav is cut short: its data chunk holds 6 bytes, not a whole number of 4-byte samples."),
      (riff(&[data.clone(), fmt(1, 1, 16_000, 16)]), "bad.wav has its data before its fmt chunk."),
      (b"not a wav file at all".to_vec(), "bad.wav is not a WAV file;"),
    ];
    for (bytes, want) in cases {
      let err = read_bytes("refuses", &bytes).unwrap_err();
      assert!(err.starts_with(want), "{err}");
      assert!(err.ends_with("afconvert -f WAVE -d LEI16@16000 -c 1 in.wav out.wav"), "{err}");
    }
  }

  /// WAVE_FORMAT_EXTENSIBLE as afconvert writes it, 40 bytes: the 16, cbSize 22, the valid bits, the
  /// channel mask, then the GUID of the sub-format, whose first two bytes are `sub`.
  fn extensible(sub: u16, bits: u16) -> Vec<u8> {
    let mut f = fmt(0xFFFE, 1, 16_000, bits);
    f[4] = 40;
    f.extend_from_slice(&22u16.to_le_bytes());
    f.extend_from_slice(&bits.to_le_bytes());
    f.extend_from_slice(&4u32.to_le_bytes());
    f.extend_from_slice(&sub.to_le_bytes());
    f.extend_from_slice(&[0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71]);
    f
  }

  #[test]
  fn reads_wave_format_extensible_pcm_and_float() {
    let pcm = riff(&[extensible(1, 16), chunk(b"data", &16384i16.to_le_bytes())]);
    assert_eq!(read_bytes("ext-pcm", &pcm).unwrap(), vec![0.5]);
    let float = riff(&[extensible(3, 32), chunk(b"data", &floats(&[0.25, -0.75]))]);
    assert_eq!(read_bytes("ext-float", &float).unwrap(), vec![0.25, -0.75]);
  }

  #[test]
  fn refuses_wave_format_extensible_it_cannot_read() {
    let data = chunk(b"data", &[0, 0, 0, 0]);
    let mut short = extensible(1, 16);
    short[24] = 0; // cbSize, 8 bytes into the chunk and 16 into its body: 0, so no sub-format follows
    let mut stereo = extensible(1, 16);
    stereo[10] = 2;
    for (fmt, want) in [
      (extensible(2, 16), "bad.wav uses WAVE_FORMAT_EXTENSIBLE with a sub-format the lab doesn't know;"),
      (short, "bad.wav uses WAVE_FORMAT_EXTENSIBLE without its sub-format;"),
      (extensible(1, 24), "bad.wav is 24-bit PCM;"),
      (extensible(3, 64), "bad.wav is 64-bit float;"),
      (stereo, "bad.wav is 16000 Hz stereo;"),
    ] {
      let err = read_bytes("ext-refused", &riff(&[fmt, data.clone()])).unwrap_err();
      assert!(err.starts_with(want), "{err}");
      assert!(err.ends_with(HOW), "{err}");
    }
  }

  #[test]
  fn skips_chunks_it_does_not_know() {
    let bytes = riff(&[fmt(1, 1, 16_000, 16), chunk(b"LIST", b"odd"), chunk(b"data", &16384i16.to_le_bytes())]);
    assert_eq!(read_bytes("list", &bytes).unwrap(), vec![0.5]);
  }
}
