import {
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
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
  before += inputSize;

  const tempDir = mkdtempSync(join(tmpdir(), "parallax-obf-"));

  try {
    const args = [
      "--yes",
      "javascript-obfuscator@5.4.3",
      file,
      "--output", tempDir,
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
      "--unicode-escape-sequence", "false",
    ];

    const command = process.platform === "win32" ? "npx.cmd" : "npx";
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error(`javascript-obfuscator failed for ${file}`);
    }

    const generated = collectJs(tempDir);
    const outputFile =
      generated.find((candidate) => basename(candidate) === basename(file)) ??
      generated[0];

    if (!outputFile) {
      throw new Error(`javascript-obfuscator produced no JS output for ${file}`);
    }

    writeFileSync(file, readFileSync(outputFile));
    after += statSync(file).size;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

console.log(
  `Parallax release obfuscation: ${files.length} JS chunks, ${before} -> ${after} bytes`,
);
