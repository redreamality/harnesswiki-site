import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const work = path.join(root, ".dev/research-work/deepseek");
const repository = path.join(root, "upstreams/deepseek-ai/DeepSeek-Harness");
const latest = process.argv.includes("--latest");
const anchor = latest ? "22ddee3792402c3e70ec5f86a63c3e3e895a2f60" : "99f6f02fecdb7dff40c3fbc9470f5907c29f74ca";
const stamp = "2026-10-24T00:00:00.000Z";

function durableAppend(file, events) {
  const fd = fs.openSync(file, "a");
  try {
    fs.writeFileSync(fd, events.map((event) => JSON.stringify(event) + "\n").join(""));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readEvents(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function crashSeed() {
  return [
    { type: "turn/start", data: { turn: 1 } },
    { type: "user/message", surfaceOp: "append", data: {
      id: "request", role: "user", source: { kind: "user" },
      content: [{ type: "text", text: "Increment the loopback counter once." }],
    } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "assistant/message", surfaceOp: "append", data: {
      turn: 1, step: 1, message: {
        id: "assistant", role: "assistant", source: { kind: "model", provider: "probe", model: "fixed" },
        content: [{ type: "tool-call", id: "write-1", name: "increment", arguments: {} }],
      },
    } },
    { type: "tool/call", data: { turn: 1, step: 1, callId: "write-1", name: "increment", arguments: {} } },
  ].map((event, seq) => ({ ...event, seq, time: stamp }));
}

if (process.argv[2] === "--crash-worker") {
  const [file, url] = process.argv.slice(3);
  durableAppend(file, crashSeed());
  const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const receipt = await response.json();
  process.send({ receipt });
  // The parent kills this writer after the service acknowledged the side effect.
  setInterval(() => {}, 1000);
} else {
  await main();
}

async function main() {
  const git = (args) => execFileSync("git", args, {
    cwd: repository, encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: latest ? "0" : "1", GIT_TERMINAL_PROMPT: "0",
      ...(latest && process.env.RESEARCH_HTTP_PROXY ? { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "http.proxy",
        GIT_CONFIG_VALUE_0: process.env.RESEARCH_HTTP_PROXY, GIT_CONFIG_KEY_1: "http.version",
        GIT_CONFIG_VALUE_1: "HTTP/1.1" } : {}) },
  }).trimEnd();
  git(["cat-file", "-e", `${anchor}^{commit}`]);
  const tree = new Set(git(["ls-tree", "-r", "--name-only", anchor]).split("\n"));
  const run = fs.mkdtempSync(path.join(work, "run-"));
  const build = path.join(run, "modules");
  const require = createRequire(path.join(work, "package.json"));
  const ts = require("typescript");
  const sources = [
    ...(latest ? [
      "packages/core/session/src/types.ts",
      "packages/core/session/src/known-event-types.ts",
      "packages/util/brand/src/index.ts",
      "packages/util/values/src/index.ts",
      "packages/util/values/src/partial-json.ts",
      "packages/util/crypto/src/index.ts",
    ] : []),
    "packages/core/session/src/repair.ts",
    "packages/core/session/src/surface.ts",
    "packages/util/timeout/src/index.ts",
    "packages/compaction/compaction/src/index.ts",
    "packages/compaction/compaction/src/brand.ts",
    "packages/compaction/compaction/src/checkpoint.ts",
    "packages/compaction/compaction/src/tool-pairing.ts",
    "packages/compaction/compaction-basic/src/region.ts",
    "packages/compaction/compaction-basic/src/summarizer.ts",
    ...[...tree].filter((name) => /^packages\/llm\/llm\/src\/.*\.ts$/.test(name)),
    ...[...tree].filter((name) => /^vendor\/(cordis|cosmokit|schemastery)\/src\/.*\.ts$/.test(name)),
  ];
  const manifest = [];
  for (const name of sources) {
    assert(tree.has(name), `Source missing at anchor: ${name}`);
    const source = git(["show", `${anchor}:${name}`]);
    const destination = path.join(build, name.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, ts.transpileModule(source, {
      fileName: name,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        rewriteRelativeImportExtensions: true,
      },
    }).outputText);
    manifest.push({ path: name, blob: git(["rev-parse", `${anchor}:${name}`]) });
  }
  fs.writeFileSync(path.join(build, "package.json"), '{"type":"module"}\n');
  const llmPackage = "packages/llm/llm/package.json";
  assert(tree.has(llmPackage));
  fs.writeFileSync(path.join(build, llmPackage), git(["show", `${anchor}:${llmPackage}`]) + "\n");
  manifest.push({ path: llmPackage, blob: git(["rev-parse", `${anchor}:${llmPackage}`]) });
  const aliases = {
    ...(latest ? {
      "@deepseek-ai/dsh-brand": "packages/util/brand/src/index.js",
      "@deepseek-ai/dsh-util-values": "packages/util/values/src/index.js",
      "@deepseek-ai/dsh-util-crypto": "packages/util/crypto/src/index.js",
      // Region imports only the value constructor from this service entry.
      "@deepseek-ai/dsh-session": "packages/core/session/src/types.js",
    } : {}),
    "@deepseek-ai/dsh-llm": "packages/llm/llm/src/index.js",
    "@deepseek-ai/dsh-compaction": "packages/compaction/compaction/src/index.js",
    "@deepseek-ai/cordis": "vendor/cordis/src/index.js",
    "@deepseek-ai/cosmokit": "vendor/cosmokit/src/index.js",
    "@deepseek-ai/schemastery": "vendor/schemastery/src/index.js",
    "@deepseek-ai/dsh-timeout": "packages/util/timeout/src/index.js",
  };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (Object.hasOwn(aliases, specifier)) {
        return { url: pathToFileURL(path.join(build, aliases[specifier])).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  const load = (name) => import(pathToFileURL(path.join(build, name)).href);
  const { interruptedTurnClosers } = await load("packages/core/session/src/repair.js");
  const { SurfaceManager, foldSurface, deriveEventMessage } = await load("packages/core/session/src/surface.js");
  let compactSurfaceRegion;
  let compactionLoadFailure;
  try {
    ({ compactSurfaceRegion } = await load("packages/compaction/compaction-basic/src/region.js"));
  } catch (error) {
    if (!latest) throw error;
    compactionLoadFailure = { code: error.code, message: error.message };
  }
  const { createUserMessage } = await load("packages/llm/llm/src/message.js");

  const result = {
    anchor, executedAt: new Date().toISOString(), node: process.version,
    platform: `${process.platform} ${process.arch}`, compiler: ts.version,
    upstreamCheckout: git(["rev-parse", "HEAD"]),
    refresh: JSON.parse(fs.readFileSync(path.join(root, ".dev/research-latest/deepseek-harness.json"), "utf8")),
    moduleManifest: manifest,
  };

  let counter = 0;
  const serviceFile = path.join(run, "service-receipts.jsonl");
  const server = http.createServer((request, response) => {
    if (request.method === "POST") {
      counter += 1;
      durableAppend(serviceFile, [{ count: counter }]);
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ count: counter }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/counter`;
  const logFile = path.join(run, "crash-session.jsonl");
  let child;
  try {
    child = fork(fileURLToPath(import.meta.url), ["--crash-worker", logFile, url], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const exited = once(child, "exit");
    const [message] = await once(child, "message", { signal: AbortSignal.timeout(10000) });
    assert.equal(message.receipt.count, 1);
    child.kill("SIGKILL");
    const [exitCode, signal] = await exited;
    const before = readEvents(logFile);
    assert.equal(before.length, 5);
    assert(!before.some((event) => event.type === "tool/result"));
    const closers = interruptedTurnClosers(before);
    assert.equal(closers[0].data.error.code, "TOOL_OUTCOME_UNKNOWN");
    if (latest) {
      assert.equal(closers[0].data.message.role, "tool");
      assert.equal(closers[0].data.message.toolCallId, "write-1");
      assert.equal(closers[0].data.message.isError, true);
    }
    assert.deepEqual(closers[0].sourceEventSeqs, [4]);
    assert.deepEqual(closers.map((event) => event.type), ["tool/result", "step/end", "turn/end"]);
    assert.deepEqual(interruptedTurnClosers(before), closers);
    durableAppend(logFile, closers);
    const repaired = readEvents(logFile);
    assert.deepEqual(interruptedTurnClosers(repaired), []);
    const partialCounts = [1, 2].map((count) => {
      const partialFile = path.join(run, `partial-repair-${count}.jsonl`);
      durableAppend(partialFile, [...before, ...closers.slice(0, count)]);
      const partial = readEvents(partialFile);
      const remainder = interruptedTurnClosers(partial);
      assert(!remainder.some((event) => event.type === "tool/result"));
      durableAppend(partialFile, remainder);
      assert.deepEqual(interruptedTurnClosers(readEvents(partialFile)), []);
      return { persistedClosers: count, remainingTypes: remainder.map((event) => event.type) };
    });
    const external = await (await fetch(url)).json();
    assert.equal(external.count, 1);
    assert.equal(readEvents(serviceFile).length, 1);
    const noCall = interruptedTurnClosers(before.slice(0, -1));
    assert.equal(noCall[0].data.error.code, "TOOL_NOT_STARTED");
    // A deliberately blind local retry demonstrates that repair supplies no external dedupe key.
    const duplicate = await (await fetch(url, { method: "POST" })).json();
    assert.equal(duplicate.count, 2);
    result.recovery = {
      childExit: { exitCode, signal }, durableCallSeq: 4,
      externalCountAfterRepair: external.count, persistedEventCount: repaired.length,
      closers: closers.map((event) => ({ type: event.type, seq: event.seq, data: event.data })),
      repeatedRepairClosers: 0, partialRepair: partialCounts,
      missingCallControl: noCall[0].data.error.code,
      deliberateBlindRetryExternalCount: duplicate.count,
    };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  // A small Session port adapter; projection, pairing and transaction code remain upstream.
  function sessionFixture() {
    const events = [];
    const surface = new SurfaceManager(events);
    const session = {
      events, surface, deriveEventMessage, requestHeader: () => undefined,
      get seq() { return events.length; },
      eventAt: (seq) => events[seq],
      append(type, data, metadata = {}) {
        const event = { type, data, seq: events.length, time: stamp, ...metadata };
        surface.validateNext(event);
        events.push(event);
        return event;
      },
    };
    for (const text of ["ORIGINAL_A", "ORIGINAL_B", "RETAINED_TAIL"]) {
      session.append("user/message", createUserMessage({
        content: [{ type: "text", text }], source: { kind: "user" },
      }), { surfaceOp: "append" });
    }
    return session;
  }
  if (latest && compactionLoadFailure) {
    const session = sessionFixture();
    session.append("user/message", createUserMessage({
      content: [{ type: "text", text: "REPLACEMENT" }], source: { kind: "plugin", plugin: "probe" },
    }), { surfaceOp: { op: "replace", startSeq: 0, endSeq: 1 }, sourceEventSeqs: [0, 1] });
    const file = path.join(run, "surface-reload.jsonl");
    durableAppend(file, session.events);
    const reloaded = readEvents(file);
    const projection = foldSurface(reloaded);
    assert.deepEqual(projection.nodes, [3, 2]);
    assert(JSON.stringify(reloaded).includes("ORIGINAL_A"));
    const invalid = structuredClone(reloaded);
    invalid[3].sourceEventSeqs = [0];
    assert.throws(() => foldSurface(invalid), /must include every shadowed surface node/);
    result.surfaceReload = { nodes: projection.nodes, replacements: projection.replacements,
      originalRetained: true, missingLineageRejected: true };
    result.compaction = { status: "blocked", stage: "module-load", ...compactionLoadFailure,
      limit: "No latest compaction transaction executed; historical observations are not migrated." };
    const output = path.join(run, "observations.json");
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
    const evidence = path.join(root, "scripts/research/deepseek-boundary-new-evidence.json");
    fs.writeFileSync(evidence, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ output, evidence, recovery: result.recovery,
      surfaceReload: result.surfaceReload, compaction: result.compaction }, null, 2));
    return;
  }
  const meter = {
    measure: (session) => ({ nodes: session.surface.nodes.map((seq) => ({
      seq, tokens: 1000, ...(latest ? { heuristicTokens: 1000 } : {}),
    })) }),
    estimateMessage: () => 1,
  };
  const options = { owner: null, stability: "selected-span" };
  const summary = (text) => ({
    summary: [{ type: "text", text }], provider: "probe", model: "deterministic",
  });
  const appendTail = (session) => session.append("user/message", createUserMessage({
    content: [{ type: "text", text: "CONCURRENT_TAIL" }], source: { kind: "user" },
  }), { surfaceOp: "append" });
  async function asynchronousCase(kind) {
    const session = sessionFixture();
    if (kind === "whole-tail") session.append("turn/start", { turn: 1 });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const running = compactSurfaceRegion({
      meter, summarize: async () => { await gate; return summary("CANDIDATE"); },
    }, session, 0, 1, { session, options: {} }, {
      owner: kind === "whole-tail" ? "current-turn" : null,
      stability: kind === "whole-tail" ? "whole-surface" : "selected-span",
    });
    const settled = running.then((value) => ({ value }), (error) => ({ error }));
    if (kind === "selected-replaced") {
      session.append("user/message", createUserMessage({
        content: [{ type: "text", text: "RIVAL_REPLACEMENT" }], source: { kind: "plugin", plugin: "probe" },
      }), { surfaceOp: latest ? { op: "replace", startSeq: 0, endSeq: 0 }
        : { op: "replace", start: 0, end: 0 }, sourceEventSeqs: [0] });
    } else {
      appendTail(session);
    }
    release();
    const outcome = await settled;
    const lifecycle = session.events.filter((event) => event.type.startsWith("compaction/"));
    if (kind === "selected-tail") {
      assert(outcome.value);
      assert.equal(session.events.filter((event) => event.type === "compaction/summary").length, 1);
      assert(session.surface.nodes.some((seq) => session.events[seq].data.content?.[0]?.text === "CONCURRENT_TAIL"));
    } else {
      if (kind === "whole-tail") {
        assert.equal(outcome.error.constructor.name, "SurfaceChangedError");
      } else {
        assert.equal(outcome.error.code, "changed");
      }
      assert.deepEqual(lifecycle.map((event) => event.type), ["compaction/start", "compaction/end"]);
      assert(lifecycle.at(-1).data.error);
    }
    durableAppend(path.join(run, `${kind}.jsonl`), session.events);
    return {
      kind, error: outcome.error ? (outcome.error.code ?? outcome.error.constructor.name) : null,
      lifecycle: lifecycle.map((event) => event.type),
      surface: [...session.surface.nodes],
    };
  }
  result.asyncCandidates = [];
  for (const kind of ["selected-replaced", "selected-tail", "whole-tail"]) {
    result.asyncCandidates.push(await asynchronousCase(kind));
  }

  const session = sessionFixture();
  const dependencies = { meter, summarize: async () => summary("SUMMARY_ONE") };
  const first = await compactSurfaceRegion(dependencies, session, 0, 1, { session, options: {} }, options);
  dependencies.summarize = async (input) => {
    assert(JSON.stringify(input.messages).includes("SUMMARY_ONE"));
    assert(!JSON.stringify(input.messages).includes("ORIGINAL_A"));
    return summary("SUMMARY_TWO");
  };
  const second = await compactSurfaceRegion(dependencies, session,
    session.surface.nodes[0], session.surface.nodes.at(-1), { session, options: {} }, options);
  const multipleFile = path.join(run, "multiple-compaction.jsonl");
  durableAppend(multipleFile, session.events);
  const reloaded = readEvents(multipleFile);
  const projection = foldSurface(reloaded);
  assert.equal(projection.replacements.length, 2);
  assert.equal(projection.nodes.length, 1);
  assert.equal(reloaded.filter((event) => event.type === "compaction/summary").length, 2);
  const projectedText = JSON.stringify(projection.nodes.map((seq) => deriveEventMessage(reloaded[seq])));
  assert(projectedText.includes("SUMMARY_TWO"));
  assert(!projectedText.includes("ORIGINAL_A"));
  assert(!projectedText.includes("SUMMARY_ONE"));
  assert(JSON.stringify(reloaded).includes("ORIGINAL_A"));
  assert(JSON.stringify(reloaded).includes("SUMMARY_ONE"));
  const finalSources = reloaded[projection.nodes[0]].sourceEventSeqs;
  assert(finalSources.includes(projection.replacements[0].seq));
  const rejected = structuredClone(reloaded);
  rejected[projection.nodes[0]].sourceEventSeqs = [second.startSeq, second.summarySeq];
  assert.throws(() => foldSurface(rejected), /must include every shadowed surface node/);
  result.multipleCompaction = {
    first, second, durableEventCount: reloaded.length,
    summaryCount: 2, surface: projection.nodes, replacements: projection.replacements,
    finalSourceEventSeqs: finalSources, projectedText,
    missingLineageRejected: true,
  };
  const output = path.join(run, "observations.json");
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  if (latest) {
    fs.writeFileSync(path.join(root, "scripts/research/deepseek-boundary-new-evidence.json"),
      JSON.stringify(result, null, 2) + "\n");
  }
  console.log(JSON.stringify({ output, anchor, refreshStatus: result.refresh.status,
    recovery: result.recovery, asyncCandidates: result.asyncCandidates,
    multipleCompaction: result.multipleCompaction }, null, 2));
}
