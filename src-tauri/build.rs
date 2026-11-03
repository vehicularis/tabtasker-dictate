fn main() {
  // Every Objective-C file in src/native and the headers they share, so a new one needs no change here,
  // only a `touch build.rs` to be picked up.
  let mut native: Vec<_> = std::fs::read_dir("src/native").expect("src/native").filter_map(|entry| entry.ok().map(|entry| entry.path()))
    .filter(|path| path.extension().is_some_and(|ext| ext == "m" || ext == "h")).collect();
  native.sort();
  let sources = native.iter().filter(|path| path.extension().is_some_and(|ext| ext == "m"));
  cc::Build::new().files(sources).flag("-fobjc-arc").flag("-mmacosx-version-min=13.0").compile("dictate_native");
  for file in &native { println!("cargo:rerun-if-changed={}", file.display()); }
  // `@available` compiles to ___isPlatformVersionAtLeast from clang's runtime library, which rustc's link
  // step (-nodefaultlibs) leaves out; clang says where the library for this Xcode is.
  let runtime = std::process::Command::new("xcrun").args(["clang", "--print-libgcc-file-name", "-mmacosx-version-min=13.0"]).output().expect("xcrun clang");
  println!("cargo:rustc-link-arg={}", String::from_utf8_lossy(&runtime.stdout).trim());
  for framework in ["AppKit", "ApplicationServices", "AVFoundation", "CoreAudio", "AudioToolbox", "ServiceManagement", "Security", "CoreMedia", "ScreenCaptureKit", "Carbon"] {
    println!("cargo:rustc-link-lib=framework={framework}");
  }
  tauri_build::build()
}
