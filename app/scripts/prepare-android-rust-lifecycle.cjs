const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const libPath = path.join(appRoot, 'src-tauri', 'src', 'lib.rs');
const cargoPath = path.join(appRoot, 'src-tauri', 'Cargo.toml');
const oldPackage = 'com.cameronamer.telegramdrive';
const newPackage = 'com.parallax.drive';

function fail(message) {
  console.error(`Android lifecycle preparation failed: ${message}`);
  process.exit(1);
}

function read(file) {
  if (!fs.existsSync(file)) fail(`missing ${file}`);
  return fs.readFileSync(file, 'utf8');
}

function writeIfChanged(file, before, after) {
  if (before !== after) {
    fs.writeFileSync(file, after, 'utf8');
    console.log(`Patched ${path.relative(appRoot, file)}`);
  }
}

const originalLib = read(libPath);
let lib = originalLib.split(oldPackage).join(newPackage);

// Logger setup must be idempotent on Android lifecycle/re-entry paths.
lib = lib.replace('    env_logger::init();', '    let _ = env_logger::try_init();');

// Android owns Activity/process lifecycle. The desktop graceful-exit path calls
// AppHandle::exit() after async teardown; on Android this can destroy native
// runtime/libandroidio state while Binder threads are still servicing framework
// callbacks, producing FORTIFY destroyed-mutex SIGABRT crashes.
const gracefulLine = '    let graceful_sync_exit_started = Arc::new(std::sync::atomic::AtomicBool::new(false));';
if (lib.includes(gracefulLine) && !lib.includes(`    #[cfg(not(target_os = "android"))]\n${gracefulLine}`)) {
  lib = lib.replace(
    gracefulLine,
    `    #[cfg(not(target_os = "android"))]\n${gracefulLine}`,
  );
}

const exitRequested = '        if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {';
if (lib.includes(exitRequested) && !lib.includes(`        #[cfg(not(target_os = "android"))]\n${exitRequested}`)) {
  lib = lib.replace(
    exitRequested,
    `        #[cfg(not(target_os = "android"))]\n${exitRequested}`,
  );
}

const exitEvent = '        if let tauri::RunEvent::Exit = event {';
if (lib.includes(exitEvent) && !lib.includes(`        #[cfg(not(target_os = "android"))]\n${exitEvent}`)) {
  lib = lib.replace(
    exitEvent,
    `        #[cfg(not(target_os = "android"))]\n${exitEvent}`,
  );
}

// Do not probe/spawn a desktop FFmpeg binary on Android startup. Android's
// streaming Actix server is already disabled, so this is pure background I/O.
const ffmpegSpawn = '            tauri::async_runtime::spawn(async move {\n                if let Some(ffmpeg) = transcode::detect_ffmpeg(&app_handle).await {';
if (lib.includes(ffmpegSpawn) && !lib.includes(`            #[cfg(not(target_os = "android"))]\n${ffmpegSpawn}`)) {
  lib = lib.replace(
    ffmpegSpawn,
    `            #[cfg(not(target_os = "android"))]\n${ffmpegSpawn}`,
  );
}

// Folder sync uses desktop filesystem watching. Keep its state/commands available
// but never start the watcher worker automatically on Android.
const syncStart = '            if let Err(error) = app.state::<sync_engine::SyncEngine>().start() {';
if (lib.includes(syncStart) && !lib.includes(`            #[cfg(not(target_os = "android"))]\n${syncStart}`)) {
  lib = lib.replace(
    syncStart,
    `            #[cfg(not(target_os = "android"))]\n${syncStart}`,
  );
}

// A failed Tauri setup/build must not panic across the mobile/JNI entry point.
// Return cleanly after logging instead of using expect().
const buildExpect = '        .build(tauri::generate_context!())\n        .expect("error while building tauri application");';
const buildSafe = `        .build(tauri::generate_context!());\n\n    let app = match app {\n        Ok(app) => app,\n        Err(error) => {\n            log::error!("Android/Tauri startup build failed: {error}");\n            return;\n        }\n    };`;
if (lib.includes(buildExpect)) {
  lib = lib.replace(buildExpect, buildSafe);
}

if (!lib.includes('env_logger::try_init()')) {
  fail('idempotent logger initialization marker missing');
}
if (!lib.includes(`#[cfg(not(target_os = "android"))]\n${gracefulLine}`)) {
  fail('Android exclusion for graceful-exit state missing');
}
if (!lib.includes(`        #[cfg(not(target_os = "android"))]\n${exitRequested}`)) {
  fail('Android exclusion for ExitRequested missing');
}
if (!lib.includes(`        #[cfg(not(target_os = "android"))]\n${exitEvent}`)) {
  fail('Android exclusion for Exit event missing');
}
if (!lib.includes(`            #[cfg(not(target_os = "android"))]\n${ffmpegSpawn}`)) {
  fail('Android exclusion for FFmpeg startup probe missing');
}
if (!lib.includes(`            #[cfg(not(target_os = "android"))]\n${syncStart}`)) {
  fail('Android exclusion for sync watcher startup missing');
}
if (!lib.includes('Android/Tauri startup build failed: {error}')) {
  fail('panic-free Tauri build marker missing');
}
if (lib.includes('.expect("error while building tauri application")')) {
  fail('panic-prone Tauri build expect remains');
}
if (lib.includes(oldPackage)) {
  fail('stale pre-rebrand Android package remains in Rust source');
}

writeIfChanged(libPath, originalLib, lib);

const originalCargo = read(cargoPath);
let cargo = originalCargo.replace('panic = "abort"', 'panic = "unwind"');
if (!cargo.includes('panic = "unwind"')) {
  fail('release panic strategy was not changed to unwind');
}
writeIfChanged(cargoPath, originalCargo, cargo);

console.log('Android Rust lifecycle hardening prepared.');
