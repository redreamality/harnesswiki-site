import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This imports upstream modules verbatim; only unrelated model declarations are sliced out.
const root = fileURLToPath(new URL("../../", import.meta.url));
const anchor = "760cd2b5984d29c2d513bb15ca33e995fae45f17";
const repository = path.join(root, "upstreams/stakpak/agent");
await fs.access(repository);
function git(args) {
  return execFileSync("git", args, {
    cwd: repository, encoding: "utf8", timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trimEnd();
}
const headBefore = git(["rev-parse", "HEAD"]);
const files = new Set(git(["ls-tree", "-r", "--name-only", anchor]).split(/\r?\n/u));
const work = await fs.mkdtemp(path.join(os.tmpdir(), "stakpak-skill-probe-"));
await fs.mkdir(path.join(work, "src/skills"), { recursive: true });
const hashes = {};
function source(file) {
  assert(files.has(file), `Not in fixed tree: ${file}`);
  const text = git(["show", `${anchor}:${file}`]) + "\n";
  hashes[file] = createHash("sha256").update(text).digest("hex");
  return text;
}
for (const name of ["mod.rs", "parser.rs"]) {
  await fs.writeFile(path.join(work, "src/skills", name),
    source(`libs/api/src/local/skills/${name}`));
}
const models = source("libs/api/src/models.rs");
const start = models.indexOf("/// Unified skill type representing knowledge from any source.");
const end = models.indexOf("impl Skill {", start);
assert(start >= 0 && end > start);
const visibility = models.match(/#\[derive\(Serialize, Deserialize, Debug, Clone, Copy, Default\)\]\r?\n#\[serde\(rename_all = "UPPERCASE"\)\]\r?\npub enum RuleBookVisibility \{[^}]+\}/u)?.[0];
assert(visibility, "Upstream visibility declaration changed");
await fs.writeFile(path.join(work, "src/models.rs"),
  `use serde::{Serialize, Deserialize};\nuse std::collections::HashMap;\n${visibility}\n${models.slice(start, end)}`);
await fs.copyFile(new URL("./stakpak-skill-probe.rs", import.meta.url), path.join(work, "src/main.rs"));
await fs.writeFile(path.join(work, "Cargo.toml"), `[package]
name = "stakpak-skill-probe"
version = "0.0.0"
edition = "2024"

[dependencies]
serde = { version = "=1.0.228", features = ["derive"] }
serde_yaml = "=0.9.34"
`);
console.log(JSON.stringify({ anchor, work, hashes, scope: "Real local skill modules; no MCP, model, credentials, or full agent build" }));
const result = await new Promise((resolve, reject) => {
  const child = spawn("cargo", ["run", "--quiet", "--manifest-path", path.join(work, "Cargo.toml")], {
    cwd: work, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CARGO_HTTP_TIMEOUT: "20", CARGO_NET_RETRY: "0" },
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 10_000 });
    } else {
      child.kill("SIGKILL");
    }
  }, 90_000);
  child.on("error", (error) => { clearTimeout(timer); reject(error); });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code, timedOut, stdout, stderr });
  });
});
assert.equal(git(["rev-parse", "HEAD"]), headBefore, "Upstream checkout changed");
console.log(JSON.stringify(result, null, 2));
if (result.code !== 0 || result.timedOut) process.exitCode = 1;
