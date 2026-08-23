import { readdirSync, statSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

if (process.env.PARALLAX_RELEASE_OBFUSCATE !== "1") {
  process.exit(0);
}

const root = new URL("../dist/", import.meta.url).pathname;

function collectJs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    const st = statSync(file);
    if (st.isDirectory()) collectJs(file, out);
    else if (st.isFile() && file.endsWith(".js")) out.push(file);
  }
  return out;
}

const files = collectJs(root);
let before = 0;
let after = 0;

for (const file of files) {
  const inputSize = statSync(file).size;
  const temp = `${file}.obfuscated`;
  before += inputSize;

  const args = [
    "--yes",
    "javascript-obfuscator@5.4.3",
    file,
    "--output", temp,
    "--target", "browser",
    "--compact", "true",
    "--simplify", "true",
    "--identifier-names-generator", "hexadecimal",
    "--control-flow-flattening", "true",
    "--control-flow-flattening-threshold", "0.75",
    "--dead-code-injection", "false",
    "--rename-globals", "false",
    "--rename-properties", "false",
    "--string-array", "true",
    "--string-array-threshold", "0.60",
    "--string-array-encoding", "base64",
    "--string-array-rotate", "true",
    "--string-array-shuffle", "true",
    "--string-array-index-shift", "true",
    "--self-defending", "false",
    "--debug-protection", "false",
    "--source-map", "false",
    "--unicode-escape-sequence", "false"
  ];

  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    try { unlinkSync(temp); } catch {}
    throw new Error(`javascript-obfuscator failed for ${file}`);
  }

  renameSync(temp, file);
  after += statSync(file).size;
}

console.log(`Parallax release obfuscation: ${files.length} JS chunks, ${before} -> ${after} bytes`);
