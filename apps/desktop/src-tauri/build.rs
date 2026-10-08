fn main() {
    let mut attributes = tauri_build::Attributes::new();
    // tauri-build puts the app manifest only into binaries, so Windows `cargo test` executables
    // load without Common Controls v6 and exit with STATUS_ENTRYPOINT_NOT_FOUND (the dialog
    // plugin imports TaskDialogIndirect). The linker embeds the same manifest everywhere instead;
    // tauri's own build script does this for its tests.
    let target = |key: &str| std::env::var(key).unwrap_or_default();
    if target("CARGO_CFG_TARGET_OS") == "windows" && target("CARGO_CFG_TARGET_ENV") == "msvc" {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest =
            std::path::Path::new(&target("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
