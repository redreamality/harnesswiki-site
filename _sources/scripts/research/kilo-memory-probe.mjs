import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Run with Bun: it loads the original TypeScript namespaces without rewriting them.
if (!globalThis.Bun) throw new Error("Run: bun scripts/research/kilo-memory-probe.mjs");
const workspace = fileURLToPath(new URL("../../", import.meta.url));
const refresh = JSON.parse(await readFile(path.join(workspace, ".dev/research-latest/kilo-code.json"), "utf8"));
assert.equal(refresh.status, "fetched");
const source = refresh.sources.find((item) => item.id === "core");
assert(source && /^[a-f0-9]{40}$/.test(source.fetchedCommit));
const repository = path.join(workspace, source.path);
const temporary = await mkdtemp(path.join(os.tmpdir(), "kilo-memory-probe-"));
const report = {
  anchor: source.fetchedCommit,
  platform: process.platform,
  bun: Bun.version,
  node: process.version,
  temporary,
  files: [],
  checks: [],
};
function git(args, cwd = repository) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", timeout: 45_000, maxBuffer: 8 * 1024 * 1024,
    windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}
const tree = new Set(git(["ls-tree", "-r", "--name-only", source.fetchedCommit]).trim().split("\n"));
const scanner = new Bun.Transpiler({ loader: "ts" });
const copied = new Set();
async function materialize(file) {
  assert(tree.has(file), `Path was not found in fetched tree: ${file}`);
  if (copied.has(file)) return;
  copied.add(file);
  let text;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      text = git(["show", `${source.fetchedCommit}:${file}`]);
      break;
    } catch (error) {
      if (attempt === 1) throw new Error(`blocked: ${file}`, { cause: error });
    }
  }
  const target = path.join(temporary, "source", file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
  report.files.push({ path: file, sha256: createHash("sha256").update(text).digest("hex") });
  for (const item of scanner.scanImports(text)) {
    if (!item.path.startsWith(".")) {
      assert(isBuiltin(item.path), `Unexpected external dependency: ${item.path}`);
      continue;
    }
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), item.path));
    const dependency = [base, `${base}.ts`, `${base}/index.ts`].find((candidate) => tree.has(candidate));
    assert(dependency, `Unresolved import: ${item.path}`);
    await materialize(dependency);
  }
}
async function load(file) {
  await materialize(file);
  return import(pathToFileURL(path.join(temporary, "source", file)).href);
}
function pass(name, evidence) {
  report.checks.push({ name, status: "passed", evidence });
  console.log(`PASS ${name}`);
}
try {
  const { Memory } = await load("packages/kilo-memory/src/memory.ts");
  const { MemoryPaths } = await load("packages/kilo-memory/src/storage/paths.ts");
  const { MemoryFiles } = await load("packages/kilo-memory/src/storage/store.ts");
  const main = path.join(temporary, "main");
  const linked = path.join(temporary, "linked");
  const clone = path.join(temporary, "clone");
  await mkdir(main);
  git(["init", "--initial-branch=main"], main);
  git(["-c", "user.name=Memory Probe", "-c", "user.email=probe@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"], main);
  git(["worktree", "add", "--detach", linked], main);
  git(["clone", "--local", main, clone], temporary);
  const data = path.join(temporary, "data");
  const rootFor = (directory) => MemoryPaths.root({ ctx: { directory, worktree: directory }, data });
  const root = rootFor(main);
  assert.equal(rootFor(linked), root);
  assert.notEqual(rootFor(clone), root);
  pass("linked worktree shares memory; independent clone does not", {
    main: root, linked: rootFor(linked), clone: rootFor(clone),
  });

  await Memory.enable({ root });
  await Memory.remember({ root, key: "compiler_choice", text: "Project compiler is ALPHA_COMPILER." });
  await Memory.correct({ root, key: "compiler_choice", text: "Project compiler is BETA_COMPILER." });
  let shown = await Memory.show({ root });
  assert(shown.sources.project.includes("ALPHA_COMPILER"));
  assert(shown.sources.corrections.includes("BETA_COMPILER"));
  assert(shown.index.includes("ALPHA_COMPILER") && shown.index.includes("BETA_COMPILER"));
  pass("correction coexists with old fact in source and index", { oldFact: true, correction: true });

  await Memory.recordSession({
    root, sessionID: "probe_history", topic: "Compiler history",
    summary: "Project compiler is ALPHA_COMPILER.", time: 1_800_000_000_000,
  });
  const forgotten = await Memory.forget({ root, query: "project.md:Facts:compiler_choice" });
  shown = await Memory.show({ root });
  assert.equal(forgotten.result.removed, 1);
  assert(!shown.sources.project.includes("ALPHA_COMPILER"));
  assert(shown.sources.corrections.includes("BETA_COMPILER"));
  const digest = await MemoryFiles.readSession(root, { sessionID: "probe_history", max: 4000 });
  assert(digest.summary.includes("ALPHA_COMPILER"));
  const recalled = await Memory.recall({ root, query: "ALPHA_COMPILER" });
  assert(recalled.hits.some((hit) => JSON.stringify(hit).includes("ALPHA_COMPILER")));
  assert(shown.index.includes("ALPHA_COMPILER"));
  pass("qualified forget removes typed fact but retains recallable digest", {
    removed: forgotten.result.removed, recallHits: recalled.hits.length, oldTextInIndex: true,
  });

  await Memory.apply({ root, trigger: "turn-close", ops: [{ action: "remove", query: "compiler_choice" }] });
  assert((await Memory.show({ root })).sources.corrections.includes("BETA_COMPILER"));
  pass("facade turn-close filters remove", { correctionRetained: true });

  await Memory.correct({ root, key: "compiler_choice", text: "Project compiler is GAMMA_COMPILER." });
  shown = await Memory.show({ root });
  assert(!shown.sources.corrections.includes("BETA_COMPILER"));
  assert(shown.sources.corrections.includes("GAMMA_COMPILER"));
  pass("same source/section/key upserts correction", { previousCorrectionRemoved: true });

  const deletedRoot = rootFor(clone);
  await Memory.enable({ root: deletedRoot });
  await Memory.remember({ root: deletedRoot, key: "retired", text: "Use RETIRED_COMPILER for builds." });
  await unlink(MemoryPaths.files(deletedRoot).project);
  assert.equal(await MemoryFiles.indexExpired(deletedRoot), true);
  const context = await Memory.context({ root: deletedRoot, record: false });
  assert(!JSON.stringify(context.blocks).includes("RETIRED_COMPILER"));
  pass("source deletion expires index and fresh context rebuilds", { oldTextInFreshBlocks: false });

  const unowned = path.join(temporary, "unowned");
  await mkdir(unowned);
  await writeFile(path.join(unowned, "keep.txt"), "keep");
  await assert.rejects(Memory.purge({ root: unowned }), /unowned memory root/);
  assert.equal(await readFile(path.join(unowned, "keep.txt"), "utf8"), "keep");
  pass("purge rejects unowned fixture directory", { retained: "keep.txt" });

  // Only the newly created memory root inside this run's temporary directory is purged.
  const relative = path.relative(temporary, root);
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  assert.equal((await Memory.purge({ root })).purged, true);
  assert.equal(await MemoryFiles.exists(root), false);
  pass("purge removes owned source/index/digest root", { rootAbsent: true });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  const result = path.join(temporary, "result.json");
  await writeFile(result, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, result, error: report.error }));
}
