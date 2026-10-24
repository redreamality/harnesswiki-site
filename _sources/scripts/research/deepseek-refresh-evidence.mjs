import fs from "node:fs";
import { execFileSync } from "node:child_process";

const repository = "upstreams/deepseek-ai/DeepSeek-Harness";
const refresh = JSON.parse(fs.readFileSync(".dev/research-latest/deepseek-harness.json", "utf8"));
const old = "99f6f02fecdb7dff40c3fbc9470f5907c29f74ca";
const current = refresh.sources?.[0]?.fetchedCommit;
if (refresh.status !== "fetched" || current !== "22ddee3792402c3e70ec5f86a63c3e3e895a2f60") {
  throw new Error("This comparison requires the coordinator's verified second-round anchor");
}
const proxy = process.env.RESEARCH_HTTP_PROXY;
const env = { ...process.env, GIT_TERMINAL_PROMPT: "0",
  ...(proxy ? { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "http.proxy",
    GIT_CONFIG_VALUE_0: proxy, GIT_CONFIG_KEY_1: "http.version",
    GIT_CONFIG_VALUE_1: "HTTP/1.1" } : {}) };
const git = (...args) => execFileSync("git", ["-C", repository, ...args], {
  env, encoding: "utf8", timeout: 25000, maxBuffer: 8 * 1024 * 1024,
}).trim();
const paths = [
  "packages/core/session/src/repair.ts",
  "packages/core/session/src/surface.ts",
  "packages/compaction/compaction-basic/src/region.ts",
];
const tree = new Set(git("ls-tree", "-r", "--name-only", current).split("\n"));
const files = paths.map((path) => {
  if (!tree.has(path)) throw new Error(`Missing current source: ${path}`);
  return { path, oldBlob: git("rev-parse", `${old}:${path}`),
    currentBlob: git("rev-parse", `${current}:${path}`),
    diff: git("diff", "--unified=3", old, current, "--", path) };
});
const url = "https://api.github.com/repos/deepseek-ai/DeepSeek-Harness/releases?per_page=5";
let releases;
try {
  const body = execFileSync(process.platform === "win32" ? "curl.exe" : "curl", ["--fail", "--silent", "--show-error",
    "--max-time", "20", ...(proxy ? ["--proxy", proxy] : []), url], {
    encoding: "utf8", timeout: 25000, maxBuffer: 4 * 1024 * 1024,
  });
  const data = JSON.parse(body);
  if (!Array.isArray(data)) throw new Error("Release response is not an array");
  releases = { status: "verified", source: url, limit: "One page, up to five releases; not a complete release history.",
    entries: data.map(({ tag_name, published_at, prerelease, draft, target_commitish, html_url, body }) =>
      ({ tag_name, published_at, prerelease, draft, target_commitish, html_url, body })) };
} catch (error) {
  releases = { status: "blocked", source: url, error: error.message, attempts: 1 };
}
const result = { verifiedAt: new Date().toISOString(), old, current, refresh,
  checkout: git("rev-parse", "HEAD"), files, releases };
fs.writeFileSync("scripts/research/deepseek-refresh-new-evidence.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ current, files: files.map(({ diff, ...file }) => file), releases }, null, 2));
