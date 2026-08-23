const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const libPath = path.join(appRoot, 'src-tauri', 'src', 'lib.rs');
const cargoPath = path.join(appRoot, 'src-tauri', 'Cargo.toml');

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

let lib = read(libPath);

// env_logger::init() panics when a logger has already been installed. Android can
// recreate Activity/native entry paths during configuration/process transitions,
// so logger setup must be idempotent.
lib = lib.replace('    env_logger::init();', '    let _ = env_logger::try_init();');

const exitStart = '    let graceful_sync_exit_started = Arc::new(std::sync::atomic::AtomicBool::new(false));\n    app.run(move |app_handle, event| {';
const exitEnd = '        }\n    });\n}';

if (lib.includes(exitStart)) {
  const start = lib.indexOf(exitStart);
  const end = lib.lastIndexOf(exitEnd);
  if (end <= start) fail('could not locate the end of the Tauri run-event shutdown block');

  const oldBlock = lib.slice(start, end + exitEnd.length - 2); // preserve final crate brace
  const desktopBlock = oldBlock
    .replace(/^    let graceful_sync_exit_started/m, '        let graceful_sync_exit_started')
    .replace(/^    app\.run/m, '        app.run')
    .replace(/^        if let/mg, '            if let')
    .replace(/^            if /mg, '                if ')
    .replace(/^                api\./mg, '                    api.')
    .replace(/^                let /mg, '                    let ')
    .replace(/^                tauri::/mg, '                    tauri::')
    .replace(/^                return;/mg, '                    return;')
    .replace(/^            }$/mg, '                }')
    .replace(/^        }$/mg, '            }')
    .replace(/^    \}\);$/m, '        });');

  // Use a simpler, deterministic replacement rather than relying on Android's
  // desktop-style graceful exit flow. On Android, Activity lifecycle is owned by
  // the framework; calling AppHandle::exit while Binder threads are active can
  // tear down bionic/libandroidio globals underneath those threads.
  const replacement = `    #[cfg(not(target_os = "android"))]\n    {\n${desktopBlock}\n    }\n\n    #[cfg(target_os = "android")]\n    {\n        app.run(|_app_handle, _event| {\n            // Android owns Activity/process lifecycle. Never call AppHandle::exit\n            // or desktop service teardown from RunEvent callbacks on mobile.\n        });\n    }\n`;
  lib = lib.slice(0, start) + replacement + lib.slice(end + exitEnd.length - 2);
}

// If an earlier run already patched the file, require the safety markers.
if (!lib.includes('env_logger::try_init()')) {
  fail('idempotent logger initialization marker missing');
}
if (!lib.includes('#[cfg(target_os = "android")]') || !lib.includes('Android owns Activity/process lifecycle')) {
  fail('Android no-op run-event lifecycle block missing');
}
if (lib.includes('com.cameronamer.telegramdrive')) {
  fail('stale pre-rebrand Android package remains in Rust source');
}

writeIfChanged(libPath, read(libPath), lib);

let cargo = read(cargoPath);
// catch_unwind is ineffective with panic=abort. Keep unwind enabled for release
// so JNI/startup guards can actually catch Rust panics instead of SIGABRTing.
cargo = cargo.replace('panic = "abort"', 'panic = "unwind"');
if (!cargo.includes('panic = "unwind"')) fail('release panic strategy was not changed to unwind');
writeIfChanged(cargoPath, read(cargoPath), cargo);

console.log('Android Rust lifecycle hardening prepared.');
