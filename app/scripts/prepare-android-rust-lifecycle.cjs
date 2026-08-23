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

if (!lib.includes('env_logger::try_init()')) {
  fail('idempotent logger initialization marker missing');
}
if (!lib.includes(`#[cfg(not(target_os = "android"))]\n${gracefulLine}`)) {
  fail('Android exclusion for graceful-exit state missing');
}
if (!lib.includes(`#[cfg(not(target_os = "android"))]\n${exitRequested.trimStart()}`) &&
    !lib.includes(`        #[cfg(not(target_os = "android"))]\n${exitRequested}`)) {
  fail('Android exclusion for ExitRequested missing');
}
if (!lib.includes(`        #[cfg(not(target_os = "android"))]\n${exitEvent}`)) {
  fail('Android exclusion for Exit event missing');
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
