fn main() {
  // Every Objective-C file in src, so a new one needs no change here, only a `touch build.rs` to be
  // picked up: watching all of src would rebuild the native code on every Rust edit.
  let mut sources: Vec<_> = std::fs::read_dir("src").expect("src").filter_map(|entry| entry.ok().map(|entry| entry.path()))
    .filter(|path| path.extension().is_some_and(|ext| ext == "m")).collect();
  sources.sort();
  cc::Build::new().files(&sources).flag("-fobjc-arc").flag("-mmacosx-version-min=13.0").compile("dictate_native");
  for source in &sources { println!("cargo:rerun-if-changed={}", source.display()); }
  for framework in ["AppKit", "ApplicationServices", "AVFoundation", "CoreAudio", "AudioToolbox", "ServiceManagement", "Security", "CoreMedia", "ScreenCaptureKit"] {
    println!("cargo:rustc-link-lib=framework={framework}");
  }
  tauri_build::build()
}
