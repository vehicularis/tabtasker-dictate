fn main() {
  cc::Build::new().file("src/dictate.m").flag("-fobjc-arc").flag("-mmacosx-version-min=13.0").compile("dictate_native");
  println!("cargo:rerun-if-changed=src/dictate.m");
  for framework in ["AppKit", "ApplicationServices", "AVFoundation", "CoreAudio", "AudioToolbox", "ServiceManagement"] {
    println!("cargo:rustc-link-lib=framework={framework}");
  }
  tauri_build::build()
}
