import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const repository = path.join(root, "upstreams/JegernOUTT/refact");
const anchors = {
  baseline: "5f5bbd0257c5d667c7b60903088c953533ffd5ce",
  refreshed: "0d096c958c6d1af9b702e48607adab03cc689c86",
};
const verifierPath = "refact-agent/engine/src/chat/goal_verifier.rs";
const typesPath = "refact-agent/engine/crates/refact-chat-api/src/lib.rs";
const options = { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 };
const rustTarget = process.env.REFACT_RUST_TARGET;
function git(...args) {
  return execFileSync("git", ["-C", repository, ...args], options).trimEnd();
}
function block(text, signature) {
  const start = text.indexOf(signature);
  assert(start >= 0, `Missing ${signature}`);
  const end = text.indexOf("\n}", start);
  assert(end > start, `Missing closing brace for ${signature}`);
  return text.slice(start, end + 2);
}
function sourceAt(sha, sourcePath) {
  const tree = git("ls-tree", "-r", "--name-only", sha, "--", sourcePath);
  assert.equal(tree, sourcePath);
  return git("show", `${sha}:${sourcePath}`);
}

assert(fs.existsSync(repository));
const checkoutBefore = git("rev-parse", "HEAD");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "refact-goal-probe-"));
const report = {
  observedAt: new Date().toISOString(),
  rustc: execFileSync("rustc", ["--version"], options).trim(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  rustTarget: rustTarget ?? "host default",
  scope: "Unmodified upstream parser functions; serde attributes removed only from the data type. No model, daemon, filesystem freshness or concurrency experiment.",
  runs: [],
};
for (const [label, sha] of Object.entries(anchors)) {
  git("cat-file", "-e", `${sha}^{commit}`);
  const source = sourceAt(sha, verifierPath);
  const types = sourceAt(sha, typesPath);
  const functions = [
    block(source, "pub fn parse_goal_verdict("),
    block(source, "fn inconclusive_verdict("),
    block(source, "pub fn parse_criteria_verdicts("),
  ].join("\n\n");
  const verdict = block(source, "pub enum GoalVerdict {");
  const criterion = block(types, "pub struct CriterionVerdict {")
    .replace(/^\s*#\[serde[^\n]*\]\r?\n/gmu, "");
  const expectedCriteria = label === "baseline"
    ? 'vec!["CRITERION C1: MET".to_string(), "CRITERION C2: UNMET - docs missing".to_string()]'
    : 'vec!["C2: docs missing".to_string()]';
  const harness = `
#[derive(Debug, Clone, PartialEq, Eq)]
${verdict}
${criterion}
const INCONCLUSIVE_GAP: &str = "verification inconclusive; continue";
${functions}
fn main() {
    assert_eq!(parse_goal_verdict("GOAL: MET", false), GoalVerdict::Met);
    assert_eq!(parse_goal_verdict("GOAL: UNMET\\n- missing tests\\n* docs", false),
        GoalVerdict::Unmet(vec!["missing tests".into(), "docs".into()]));
    assert_eq!(parse_goal_verdict("GOAL: MET", true),
        GoalVerdict::Unmet(vec![INCONCLUSIVE_GAP.into()]));
    assert_eq!(parse_goal_verdict("", false),
        GoalVerdict::Unmet(vec![INCONCLUSIVE_GAP.into()]));
    let criteria = "GOAL: UNMET\\nCRITERION C1: MET\\nCRITERION C2: UNMET - docs missing";
    let result = parse_goal_verdict(criteria, false);
    assert_eq!(result, GoalVerdict::Unmet(${expectedCriteria}));
    println!("criteria_only={:?}", result);
    let contradictory = "GOAL: MET\\nCRITERION C1: UNMET - tests failed";
    assert_eq!(parse_goal_verdict(contradictory, false), GoalVerdict::Met);
    let detail = parse_criteria_verdicts(contradictory);
    assert_eq!(detail.len(), 1);
    assert!(!detail[0].met);
    assert_eq!(detail[0].note, "tests failed");
    println!("contradictory_overall=Met; criterion_met=false");
    println!("PASS: six scenarios, nine assertions");
}
`;
  const sourceFile = path.join(temp, `${label}.rs`);
  const binary = path.join(temp, `${label}${process.platform === "win32" ? ".exe" : ""}`);
  fs.writeFileSync(sourceFile, harness);
  execFileSync("rustc", [
    "--edition=2021", ...(rustTarget ? ["--target", rustTarget] : []),
    sourceFile, "-o", binary,
  ], options);
  const output = execFileSync(binary, [], options).trim();
  report.runs.push({
    label, sha, sourcePath: verifierPath,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    extractedFunctionsSha256: createHash("sha256").update(functions).digest("hex"),
    output,
  });
}
assert.equal(git("rev-parse", "HEAD"), checkoutBefore);
report.checkoutUnchanged = checkoutBefore;
const resultPath = path.join(root, "scripts/research/refact-goal-probe-result.json");
fs.writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
