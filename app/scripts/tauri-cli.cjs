const { readFileSync } = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runNodePrepare(scriptName, label) {
  const prepareScript = path.join(__dirname, scriptName);
  const prepare = spawnSync(process.execPath, [prepareScript], {
    cwd: appRoot,
    env: process.env,
    stdio: 'inherit',
  });

  if (prepare.error) {
    fail(`Unable to prepare ${label}: ${prepare.error.message}`);
  }
  if (prepare.status !== 0) {
    process.exit(prepare.status ?? 1);
  }
}

if (process.platform === 'win32' && args[0] === 'build') {
  const prepareScript = path.join(__dirname, 'prepare-windows-runtime.ps1');
  const prepare = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', prepareScript],
    { cwd: appRoot, stdio: 'inherit' },
  );

  if (prepare.error) {
    fail(`Unable to prepare the Windows runtime: ${prepare.error.message}`);
  }
  if (prepare.status !== 0) {
    process.exit(prepare.status ?? 1);
  }

  const hasCustomConfig = args.some(
    (argument) => argument === '--config' || argument.startsWith('--config='),
  );
  if (!hasCustomConfig) {
    args.push('--config', 'src-tauri/tauri.windows.release.conf.json');
  }
}

const isAndroidCommand = args[0] === 'android';
const androidSubcommand = args[1];

// Patch Rust/mobile lifecycle before both init and compile. This is idempotent and
// prevents desktop AppHandle::exit teardown from racing Android Binder threads.
if (isAndroidCommand && ['init', 'build', 'dev'].includes(androidSubcommand)) {
  runNodePrepare('prepare-android-rust-lifecycle.cjs', 'the Android Rust lifecycle');
}

// Build/dev runs also need generated Kotlin/manifest/JNI glue.
if (isAndroidCommand && (androidSubcommand === 'build' || androidSubcommand === 'dev')) {
  runNodePrepare('prepare-android-runtime.cjs', 'the Android runtime');
}

const cliPackagePath = path.join(
  appRoot,
  'node_modules',
  '@tauri-apps',
  'cli',
  'package.json',
);

let cliEntry;
try {
  const cliPackage = JSON.parse(readFileSync(cliPackagePath, 'utf8'));
  const cliBin = typeof cliPackage.bin === 'string'
    ? cliPackage.bin
    : cliPackage.bin?.tauri;

  if (!cliBin) {
    fail('The installed @tauri-apps/cli package does not expose a Tauri executable.');
  }
  cliEntry = path.resolve(path.dirname(cliPackagePath), cliBin);
} catch (error) {
  fail(`Unable to locate @tauri-apps/cli. Run npm install first. ${error.message}`);
}

const tauri = spawn(process.execPath, [cliEntry, ...args], {
  cwd: appRoot,
  env: process.env,
  stdio: 'inherit',
});

tauri.on('error', (error) => {
  fail(`Unable to start Tauri: ${error.message}`);
});

tauri.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
