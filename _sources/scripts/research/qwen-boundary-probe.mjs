import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mock } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sha = "e034944c73f77d63fca7fbd9d84ab96ef87b4d21";
const repository = path.join(root, "upstreams/QwenLM/qwen-code");
const work = path.join(root, ".dev/research-work/qwen", sha);
const sourceNames = [
  "permissionMediator.ts", "permission.ts", "bridgeErrors.ts",
  "workspacePaths.ts", "eventBus.ts", "replay-summary.ts",
];
const git = (...args) => execFileSync("git", ["-C", repository, ...args], {
  encoding: "utf8", timeout: 45_000, maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
});
const refresh = JSON.parse(await fs.readFile(
  path.join(root, ".dev/research-latest/qwen-code.json"), "utf8",
));
assert.equal(refresh.status, "fetched", "Refresh must succeed before this probe");
assert.equal(refresh.sources[0].fetchedCommit, sha, "Review probe before changing its anchor");
const checkout = git("rev-parse", "HEAD").trim();
const tree = new Set(git("ls-tree", "-r", "--name-only", sha).trim().split(/\r?\n/u));
await fs.mkdir(path.join(work, "source"), { recursive: true });
await fs.mkdir(path.join(work, "compiled"), { recursive: true });
await fs.writeFile(path.join(work, "package.json"), JSON.stringify({
  private: true, type: "module",
  dependencies: { typescript: "5.8.3", "@agentclientprotocol/sdk": "0.14.1" },
}, null, 2) + "\n");
const requireFromWork = createRequire(path.join(work, "package.json"));
try {
  requireFromWork.resolve("typescript");
  requireFromWork.resolve("@agentclientprotocol/sdk");
} catch {
  const args = ["install", "--ignore-scripts", "--config.fetch-retries=0",
    "--config.fetch-timeout=30000"];
  execFileSync(process.platform === "win32" ? "cmd.exe" : "pnpm",
    process.platform === "win32" ? ["/d", "/c", "pnpm.cmd", ...args] : args,
    { cwd: work, stdio: "inherit", timeout: 90_000 });
}
const ts = requireFromWork("typescript");
assert.equal(ts.version, "5.8.3");
for (const name of sourceNames) {
  const sourcePath = `packages/acp-bridge/src/${name}`;
  assert.ok(tree.has(sourcePath), sourcePath);
  const source = git("show", `${sha}:${sourcePath}`);
  await fs.writeFile(path.join(work, "source", name), source);
  const result = ts.transpileModule(source, {
    fileName: name, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  assert.equal(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  await fs.writeFile(path.join(work, "compiled", name.replace(/\.ts$/u, ".js")), result.outputText);
}
const { EventBus } = await import(pathToFileURL(path.join(work, "compiled/eventBus.js")));
const { MultiClientPermissionMediator, createNoOpPermissionAuditPublisher } =
  await import(pathToFileURL(path.join(work, "compiled/permissionMediator.js")));
const results = [];
const record = (requestId = "request", promptId = "prompt") => ({
  requestId, sessionId: "session", promptId, originatorClientId: "A",
  allowedOptionIds: new Set(["allow", "deny"]), issuedAtMs: 1000,
});
const vote = (requestId = "request") => ({
  requestId, sessionId: "session", clientId: "A", optionId: "allow",
  receivedAtMs: 1010, fromLoopback: true,
});
function runtime(emitHook) {
  const events = [], audit = [];
  const mediator = new MultiClientPermissionMediator("first-responder", {
    now: () => 1010, votersForSession: () => new Set(["A"]),
    emit: (_sid, event) => { events.push(event); emitHook?.(event, mediator); },
    audit: {
      ...createNoOpPermissionAuditPublisher(),
      recordResolved: (_r, resolution, reason) => audit.push({ resolution, reason }),
    },
  });
  return { mediator, events, audit };
}
function pass(name, details) {
  results.push({ name, ...details });
  console.log(JSON.stringify(results.at(-1)));
}
const permutations = [
  ["vote", "timeout", "close"], ["vote", "close", "timeout"],
  ["timeout", "vote", "close"], ["timeout", "close", "vote"],
  ["close", "vote", "timeout"], ["close", "timeout", "vote"],
];
for (const order of permutations) {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { mediator, events, audit } = runtime();
    const pending = mediator.request(record(), 10);
    let voteResult;
    for (const action of order) {
      if (action === "vote") voteResult = mediator.vote(vote());
      if (action === "timeout") mock.timers.tick(10);
      if (action === "close") mediator.forgetSession("session");
    }
    const resolution = await pending;
    const expected = order[0] === "vote" ? { kind: "option", optionId: "allow" }
      : { kind: "cancelled", reason: order[0] === "timeout" ? "timeout" : "session_closed" };
    assert.deepEqual(resolution, expected);
    assert.equal(mediator.pendingCount, 0);
    assert.equal(events.filter(e => e.type === "permission_resolved").length, 1);
    assert.equal(audit.length, 1);
    assert.equal(voteResult.kind, order[0] === "vote" ? "resolved" : "already_resolved");
    pass(`ordering:${order.join(">")}`, { resolution, voteResult, terminalCount: 1 });
  } finally {
    mock.timers.reset();
  }
}
{
  const { mediator, events } = runtime();
  const pending = mediator.request(record(), 5);
  // The mediator unrefs its timer; the watchdog both keeps Node alive and bounds failure.
  let watchdog;
  try {
    const resolution = await Promise.race([pending, new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error("Native timer did not settle")), 1000);
    })]);
    assert.deepEqual(resolution, { kind: "cancelled", reason: "timeout" });
    mediator.forgetSession("session");
    assert.equal(mediator.vote(vote()).kind, "already_resolved");
    assert.equal(events.filter(e => e.type === "permission_resolved").length, 1);
    pass("native-timeout", { resolution });
  } finally { clearTimeout(watchdog); }
}
{
  let duringEmit;
  const { mediator } = runtime((event, instance) => {
    if (event.type === "permission_resolved") duringEmit = instance.vote(vote());
  });
  const pending = mediator.request(record(), 0);
  mediator.vote(vote());
  await pending;
  assert.equal(duringEmit.kind, "unknown_request");
  const afterEmit = mediator.vote(vote());
  assert.equal(afterEmit.kind, "already_resolved");
  pass("synchronous-emit-reentry", { duringEmit, afterEmit });
}
{
  const { mediator } = runtime();
  const background = mediator.request(record("background", "notification"), 0);
  const foreground = mediator.request(record("foreground", "user"), 0);
  mediator.cancelForPrompt("session", "notification");
  assert.deepEqual(await background, { kind: "cancelled", reason: "agent_cancelled" });
  assert.equal(mediator.pendingCount, 1);
  mediator.vote(vote("foreground"));
  assert.deepEqual(await foreground, { kind: "option", optionId: "allow" });
  pass("prompt-cancel-isolation", { background: "agent_cancelled", foreground: "allow" });
}
const publish = (bus, n) => bus.publish({ type: "probe", data: { n }, _meta: { serverTimestamp: 1000 } });
const stream = (bus, options) => bus.subscribe(options)[Symbol.asyncIterator]();
async function take(iterator, count) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    frames.push(next.value);
  }
  return frames;
}
{
  const bus = new EventBus(3);
  for (let n = 1; n <= 5; n++) publish(bus, n);
  const stale = stream(bus, { lastEventId: 1, epoch: bus.epoch });
  const frames = await take(stale, 5);
  assert.equal(frames[0].data.reason, "ring_evicted");
  assert.deepEqual(frames.slice(1, 4).map(e => e.id), [3, 4, 5]);
  assert.equal(frames[4].type, "replay_complete");
  assert.equal(frames[4].data.replayedCount, 3);
  publish(bus, 6);
  assert.equal((await stale.next()).value.id, 6);
  const boundary = stream(bus, { lastEventId: 3, epoch: bus.epoch });
  const boundaryFrames = await take(boundary, 4);
  assert.deepEqual(boundaryFrames.map(e => e.id ?? e.type), [4, 5, 6, "replay_complete"]);
  await stale.return(); await boundary.return(); bus.close();
  pass("ring-gap-and-boundary", { replay: frames.map(e => e.id ?? e.type), liveAfterResync: 6 });
}
{
  const bus = new EventBus(10, 64, undefined, { replayBudgetBytes: 1 });
  publish(bus, 1); publish(bus, 2);
  const iterator = stream(bus, { lastEventId: 0, epoch: bus.epoch });
  const frames = await take(iterator, 3);
  assert.equal(frames[0].id, 1);
  assert.equal(frames[1].data.reason, "replay_budget_exceeded");
  assert.equal(frames[2].data.replayedCount, 1);
  publish(bus, 3);
  assert.equal((await iterator.next()).value.id, 3);
  await iterator.return(); bus.close();
  pass("replay-budget-first-frame", { budgetBytes: 1, frames: frames.map(e => e.id ?? e.type), live: 3 });
}
{
  const bus = new EventBus(16);
  for (let n = 1; n <= 3; n++) publish(bus, n);
  const slow = stream(bus, { lastEventId: 0, epoch: bus.epoch, maxQueued: 2,
    onSubscriberDiagnostic: () => true });
  const fast = stream(bus, {});
  const fastIds = [];
  for (let n = 4; n <= 5; n++) {
    publish(bus, n);
    fastIds.push((await fast.next()).value.id);
  }
  assert.equal(bus.subscriberCount, 2, "Replay must not count toward live cap");
  publish(bus, 6);
  fastIds.push((await fast.next()).value.id);
  assert.equal(bus.subscriberCount, 1);
  const frames = [];
  for (;;) {
    const next = await slow.next();
    if (next.done) break;
    frames.push(next.value);
  }
  assert.deepEqual(frames.map(e => e.id ?? e.type),
    [1, 2, 3, "replay_complete", 4, 5, "slow_client_warning", "client_evicted"]);
  assert.equal(frames.at(-1).data.reason, "queue_overflow");
  assert.equal(frames.at(-1).data.droppedAfter, 6);
  assert.deepEqual(fastIds, [4, 5, 6]);
  const resumed = stream(bus, { lastEventId: 5, epoch: bus.epoch });
  assert.deepEqual((await take(resumed, 2)).map(e => e.id ?? e.type), [6, "replay_complete"]);
  await resumed.return(); await fast.return(); bus.close();
  pass("replay-live-handoff-and-slow-consumer", {
    slow: frames.map(e => e.id ?? e.type), healthy: fastIds, droppedAfter: 6, recovered: 6,
  });
}
assert.equal(git("rev-parse", "HEAD").trim(), checkout);
const output = {
  sha, fetchedAt: refresh.sources[0].fetchedAt, executedAt: new Date().toISOString(),
  node: process.version, platform: `${process.platform} ${process.arch}`,
  typescript: ts.version, sdk: "0.14.1", checkout, results,
  limits: "Real modules; synthetic inputs and recording audit; six controlled timer orders plus one native timer. No HTTP, model, or full typecheck.",
};
await fs.writeFile(path.join(work, "results.json"), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ passed: results.length, output: path.join(work, "results.json") }));
