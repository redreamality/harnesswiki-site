import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const errors = [];
const profileBaselineMarker = "\u7814\u7a76\u951a\u70b9";
const behaviorAnchorMarker = "\u884c\u4e3a\u951a\u70b9";
const claimAnchorMarker = "Claim \u951a\u70b9";
const localMaterializedMarker = "\u672c\u5730\u7269\u5316";
const driftMarker = "\u6f02\u79fb";
const validAnchorKinds = new Set(["behavior", "claim"]);
const stableCorpusCounts = Object.freeze({
  profiles: 20,
  gitSources: 20,
  externalOnlyProfiles: 1,
});
const stableCorpusProfiles = Object.freeze({
  "minimax-code": Object.freeze({
    profilePath: "docs/harnesses/minimax-code.md",
    sourceMode: "external-only",
    sources: Object.freeze([]),
  }),
  openhands: Object.freeze({
    profilePath: "docs/harnesses/openhands.md",
    sourceMode: "git",
    sources: Object.freeze([
      Object.freeze({ id: "canvas", path: "upstreams/OpenHands/OpenHands" }),
      Object.freeze({
        id: "runtime",
        path: "upstreams/OpenHands/software-agent-sdk",
      }),
    ]),
  }),
});

function runGit(args, cwd = root) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(" | ");
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${detail}`);
  }
  return result.stdout.trim();
}

function normalizeRepositoryUrl(url) {
  return url.trim().replace(/\/+$/u, "").replace(/\.git$/iu, "").toLowerCase();
}

function normalizeRepositoryPath(value) {
  return value.trim().replaceAll("\\", "/").replace(/^\.\/+|\/+$/gu, "");
}

function isRepositoryRelativePath(value) {
  if (typeof value !== "string" || normalizeRepositoryPath(value) !== value) return false;
  if (value.startsWith("/") || /^[a-z]:\//iu.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function parseStageZeroGitlink(stage, expectedPath) {
  const lines = stage.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) throw new Error("index does not contain exactly one entry");

  const match = /^160000 ([0-9a-f]{40}) 0\t(.+)$/u.exec(lines[0]);
  if (!match) throw new Error("index entry is not a stage-0 gitlink");
  if (normalizeRepositoryPath(match[2]) !== normalizeRepositoryPath(expectedPath)) {
    throw new Error(`index path ${match[2]} != ${expectedPath}`);
  }
  return match[1];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCommit(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function headerLineContains(profileText, marker, value, forbiddenMarkers = []) {
  const header = profileText.split(/^## /mu, 1)[0];
  return header.split(/\r?\n/u).some(
    (line) =>
      line.includes(marker) &&
      line.includes(value) &&
      forbiddenMarkers.every((forbidden) => !line.includes(forbidden)),
  );
}

function findHeaderLine(profileText, marker, value) {
  const header = profileText.split(/^## /mu, 1)[0];
  return header
    .split(/\r?\n/u)
    .find((line) => line.includes(marker) && line.includes(value));
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return (
    normalizedLeft.length === left.length &&
    normalizedRight.length === right.length &&
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function readCorpusProfilePaths() {
  const indexPath = path.join(root, "docs", "harnesses", "README.md");
  const text = fs.readFileSync(indexPath, "utf8");
  return [...text.matchAll(/^\| \[[^\]]+\]\(\.\/([^)]+\.md)\) \|/gmu)].map(
    ([, file]) => normalizeRepositoryPath(path.posix.join("docs/harnesses", file)),
  );
}

function readAnchorRegistry() {
  const configuredPath = process.env.HARNESS_VERSION_ANCHORS;
  const registryPath = configuredPath
    ? path.resolve(root, configuredPath)
    : path.join(root, "docs", "research", "harness-version-anchors.json");
  try {
    return JSON.parse(fs.readFileSync(registryPath, "utf8"));
  } catch (error) {
    errors.push(`version anchor registry: ${error.message}`);
    return null;
  }
}

function validateStableCorpusTopology(profiles, counts) {
  for (const [key, expected] of Object.entries(stableCorpusCounts)) {
    if (counts[key] !== expected) {
      errors.push(`stable Corpus topology: ${key}=${counts[key]}, expected ${expected}`);
    }
  }

  const expectedExternalOnlyIds = Object.entries(stableCorpusProfiles)
    .filter(([, contract]) => contract.sourceMode === "external-only")
    .map(([profileId]) => profileId);
  const actualExternalOnlyIds = profiles
    .filter((profile) => profile?.sourceMode === "external-only")
    .map((profile) => profile.id);
  if (!sameStringSet(actualExternalOnlyIds, expectedExternalOnlyIds)) {
    errors.push(
      `stable Corpus topology: external-only profiles=${JSON.stringify(actualExternalOnlyIds)}, ` +
        `expected ${JSON.stringify(expectedExternalOnlyIds)}`,
    );
  }

  for (const [profileId, contract] of Object.entries(stableCorpusProfiles)) {
    const profile = profiles.find((candidate) => candidate?.id === profileId);
    if (!profile) {
      errors.push(`stable Corpus topology: missing profile ${profileId}`);
      continue;
    }
    if (profile.profilePath !== contract.profilePath) {
      errors.push(
        `stable Corpus topology: ${profileId} profilePath=${profile.profilePath}, ` +
          `expected ${contract.profilePath}`,
      );
    }
    if (profile.sourceMode !== contract.sourceMode) {
      errors.push(
        `stable Corpus topology: ${profileId} sourceMode=${profile.sourceMode}, ` +
          `expected ${contract.sourceMode}`,
      );
    }

    const actualSources = Array.isArray(profile.sources)
      ? profile.sources.map((source) => `${source?.id ?? "<missing-id>"}:${source?.path ?? "<missing-path>"}`)
      : [];
    const expectedSources = contract.sources.map((source) => `${source.id}:${source.path}`);
    if (!sameStringSet(actualSources, expectedSources)) {
      errors.push(
        `stable Corpus topology: ${profileId} sources=${JSON.stringify(actualSources)}, ` +
          `expected ${JSON.stringify(expectedSources)}`,
      );
    }
  }
}

function validateAnchorRegistry(moduleByPath, sourceStateByPath, registry = readAnchorRegistry()) {
  const counts = {
    profiles: 0,
    gitSources: 0,
    externalOnlyProfiles: 0,
    aligned: 0,
    drifted: 0,
    claimMatched: 0,
  };
  if (!registry) return counts;

  if (registry.schemaVersion !== 1) {
    errors.push(`version anchor registry: schemaVersion=${registry.schemaVersion}, expected 1`);
  }
  if (typeof registry.snapshotDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(registry.snapshotDate)) {
    errors.push("version anchor registry: snapshotDate must use YYYY-MM-DD");
  }
  if (!isObject(registry.expectedCounts)) {
    errors.push("version anchor registry: expectedCounts must be an object");
  }
  if (!Array.isArray(registry.profiles)) {
    errors.push("version anchor registry: profiles must be an array");
    return counts;
  }

  const corpusProfilePaths = readCorpusProfilePaths();
  const corpusProfileSet = new Set(corpusProfilePaths);
  const profileIds = new Set();
  const profilePaths = new Set();
  const sourcePaths = new Set();
  counts.profiles = registry.profiles.length;

  if (corpusProfileSet.size !== corpusProfilePaths.length) {
    errors.push("Corpus index: duplicate Harness profile path");
  }

  for (const profile of registry.profiles) {
    validateAnchorProfile(profile, {
      corpusProfileSet,
      moduleByPath,
      profileIds,
      profilePaths,
      sourcePaths,
      sourceStateByPath,
      counts,
    });
  }

  for (const profilePath of corpusProfileSet) {
    if (!profilePaths.has(profilePath)) {
      errors.push(`version anchor registry: missing Corpus profile ${profilePath}`);
    }
  }

  validateStableCorpusTopology(registry.profiles, counts);

  const expectedCounts = registry.expectedCounts;
  if (isObject(expectedCounts)) {
    for (const key of ["profiles", "gitSources", "externalOnlyProfiles"]) {
      if (!Number.isInteger(expectedCounts[key]) || expectedCounts[key] < 0) {
        errors.push(`version anchor registry: expectedCounts.${key} must be a non-negative integer`);
      } else if (expectedCounts[key] !== stableCorpusCounts[key]) {
        errors.push(
          `version anchor registry: expectedCounts.${key}=${expectedCounts[key]}, ` +
            `stable contract expects ${stableCorpusCounts[key]}`,
        );
      } else if (counts[key] !== expectedCounts[key]) {
        errors.push(
          `version anchor registry: ${key}=${counts[key]}, expected ${expectedCounts[key]}`,
        );
      }
    }
    if (corpusProfilePaths.length !== expectedCounts.profiles) {
      errors.push(
        `Corpus index: profiles=${corpusProfilePaths.length}, registry expects ${expectedCounts.profiles}`,
      );
    }
  }

  return counts;
}

function validateAnchorProfile(profile, context) {
  if (!isObject(profile)) {
    errors.push("version anchor registry: each profile must be an object");
    return;
  }

  const label = typeof profile.id === "string" ? profile.id : "<missing-id>";
  if (typeof profile.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(profile.id)) {
    errors.push(`${label}: id must be a lowercase kebab-case string`);
  } else if (context.profileIds.has(profile.id)) {
    errors.push(`${label}: duplicate profile id`);
  } else {
    context.profileIds.add(profile.id);
  }

  let profilePath = "";
  let profileText = "";
  if (typeof profile.profilePath !== "string") {
    errors.push(`${label}: profilePath must be a string`);
  } else {
    profilePath = normalizeRepositoryPath(profile.profilePath);
    if (profilePath !== profile.profilePath) {
      errors.push(`${label}: profilePath must use normalized repository separators`);
    }
    if (context.profilePaths.has(profilePath)) {
      errors.push(`${label}: duplicate profilePath ${profilePath}`);
    } else {
      context.profilePaths.add(profilePath);
    }
    if (!context.corpusProfileSet.has(profilePath)) {
      errors.push(`${label}: ${profilePath} is not listed in the Corpus Harness index`);
    }

    const absoluteProfilePath = path.join(root, profilePath);
    if (!fs.existsSync(absoluteProfilePath)) {
      errors.push(`${label}: profile file is missing -> ${profilePath}`);
    } else {
      profileText = fs.readFileSync(absoluteProfilePath, "utf8");
    }
  }

  if (profile.sourceMode === "external-only") {
    context.counts.externalOnlyProfiles += 1;
    validateExternalBaseline(profile, profileText, label);
    return;
  }
  if (profile.sourceMode !== "git") {
    errors.push(`${label}: sourceMode must be git or external-only`);
    return;
  }
  if (!Array.isArray(profile.sources) || profile.sources.length === 0) {
    errors.push(`${label}: git profile must declare at least one source`);
    return;
  }

  const sourceIds = new Set();
  for (const source of profile.sources) {
    validateAnchorSource(source, {
      ...context,
      label,
      profileText,
      sourceIds,
    });
  }
}

function validateExternalBaseline(profile, profileText, label) {
  if (!Array.isArray(profile.sources) || profile.sources.length !== 0) {
    errors.push(`${label}: external-only profile must have an empty sources array`);
  }
  if (Object.hasOwn(profile, "materialized")) {
    errors.push(`${label}: external-only profile cannot declare materialized Git state`);
  }

  const baseline = profile.profileBaseline;
  if (!isObject(baseline) || baseline.kind !== "release") {
    errors.push(`${label}: external-only profileBaseline must be a release object`);
    return;
  }
  if (typeof baseline.value !== "string" || baseline.value.length === 0) {
    errors.push(`${label}: release baseline value must be a non-empty string`);
  } else if (
    profileText &&
    !headerLineContains(profileText, profileBaselineMarker, baseline.value, [
      behaviorAnchorMarker,
      localMaterializedMarker,
    ])
  ) {
    errors.push(`${label}: profile baseline line does not contain ${baseline.value}`);
  }
  if (typeof baseline.releasedOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(baseline.releasedOn)) {
    errors.push(`${label}: release baseline releasedOn must use YYYY-MM-DD`);
  } else if (profileText && !profileText.includes(baseline.releasedOn)) {
    errors.push(`${label}: profile does not contain release date ${baseline.releasedOn}`);
  }
  if (typeof baseline.evidenceType !== "string" || baseline.evidenceType.length === 0) {
    errors.push(`${label}: release baseline evidenceType must be a non-empty string`);
  }
}

function validateAnchorSource(source, context) {
  context.counts.gitSources += 1;
  if (!isObject(source)) {
    errors.push(`${context.label}: each Git source must be an object`);
    return;
  }

  const sourceId = typeof source.id === "string" ? source.id : "<missing-source-id>";
  const label = `${context.label}/${sourceId}`;
  if (typeof source.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(source.id)) {
    errors.push(`${label}: source id must be a lowercase kebab-case string`);
  } else if (context.sourceIds.has(source.id)) {
    errors.push(`${label}: duplicate source id`);
  } else {
    context.sourceIds.add(source.id);
  }

  let sourcePath = "";
  if (!isRepositoryRelativePath(source.path)) {
    errors.push(`${label}: path must be a normalized repository-relative path`);
  } else {
    sourcePath = source.path;
    if (context.sourcePaths.has(sourcePath)) {
      errors.push(`${label}: duplicate registered source path ${sourcePath}`);
    } else {
      context.sourcePaths.add(sourcePath);
    }
  }

  if (typeof source.repositoryUrl !== "string" || source.repositoryUrl.length === 0) {
    errors.push(`${label}: repositoryUrl must be a non-empty string`);
  }

  const module = sourcePath ? context.moduleByPath.get(sourcePath) : null;
  if (!module && sourcePath) {
    errors.push(`${label}: source path is not declared in .gitmodules -> ${sourcePath}`);
  } else if (
    module &&
    typeof source.repositoryUrl === "string" &&
    normalizeRepositoryUrl(module.url) !== normalizeRepositoryUrl(source.repositoryUrl)
  ) {
    errors.push(`${label}: registry URL ${source.repositoryUrl} != .gitmodules ${module.url}`);
  }

  const baseline = source.profileBaseline;
  let baselineCommit = "";
  if (!isObject(baseline) || baseline.kind !== "commit" || !isCommit(baseline.value)) {
    errors.push(`${label}: profileBaseline must contain a lowercase 40-character commit`);
  } else {
    baselineCommit = baseline.value;
    const marker = typeof baseline.marker === "string" ? baseline.marker : profileBaselineMarker;
    if (marker.length === 0) {
      errors.push(`${label}: profileBaseline marker must be a non-empty string`);
    } else if (
      context.profileText &&
      !headerLineContains(context.profileText, marker, baselineCommit, [
        behaviorAnchorMarker,
        localMaterializedMarker,
      ])
    ) {
      errors.push(`${label}: profile baseline line does not contain ${baselineCommit}`);
    }
  }

  const claimAnchors = validateClaimAnchors(source.claimAnchors, context.profileText, label);
  validateMaterializedState(source.materialized, {
    ...context,
    baselineCommit,
    claimAnchors,
    label,
    source,
    sourcePath,
  });
}

function validateClaimAnchors(claimAnchors, profileText, label) {
  if (!Array.isArray(claimAnchors)) {
    errors.push(`${label}: claimAnchors must be an array`);
    return [];
  }

  const anchorIds = new Set();
  const validAnchors = [];
  for (const anchor of claimAnchors) {
    if (!isObject(anchor)) {
      errors.push(`${label}: each claim anchor must be an object`);
      continue;
    }
    const anchorId = typeof anchor.id === "string" ? anchor.id : "<missing-anchor-id>";
    const anchorLabel = `${label}/${anchorId}`;
    let anchorIsValid = true;
    if (typeof anchor.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(anchor.id)) {
      errors.push(`${anchorLabel}: claim anchor id must be lowercase kebab-case`);
      anchorIsValid = false;
    } else if (anchorIds.has(anchor.id)) {
      errors.push(`${anchorLabel}: duplicate claim anchor id`);
      anchorIsValid = false;
    } else {
      anchorIds.add(anchor.id);
    }
    const validKind = validAnchorKinds.has(anchor.kind);
    if (!validKind) {
      errors.push(`${anchorLabel}: kind must be behavior or claim`);
      anchorIsValid = false;
    }
    const validCommit = isCommit(anchor.value);
    if (!validCommit) {
      errors.push(`${anchorLabel}: value must be a lowercase 40-character commit`);
      anchorIsValid = false;
    }

    if (validKind && validCommit) {
      const expectedMarker = anchor.kind === "behavior" ? behaviorAnchorMarker : claimAnchorMarker;
      if (Object.hasOwn(anchor, "marker")) {
        if (typeof anchor.marker !== "string" || anchor.marker.length === 0) {
          errors.push(`${anchorLabel}: marker must be a non-empty string when declared`);
          anchorIsValid = false;
        } else if (anchor.marker !== expectedMarker) {
          errors.push(
            `${anchorLabel}: ${anchor.kind} anchor marker must be ${expectedMarker}`,
          );
          anchorIsValid = false;
        }
      }
      const forbiddenMarkers = [
        profileBaselineMarker,
        behaviorAnchorMarker,
        claimAnchorMarker,
        localMaterializedMarker,
      ].filter((marker) => marker !== expectedMarker);
      if (
        profileText &&
        !headerLineContains(profileText, expectedMarker, anchor.value, forbiddenMarkers)
      ) {
        errors.push(`${anchorLabel}: profile claim-anchor line does not contain ${anchor.value}`);
        anchorIsValid = false;
      }
    }

    if (!isRepositoryRelativePath(anchor.evidencePath)) {
      errors.push(`${anchorLabel}: evidencePath must be a normalized repository-relative path`);
      anchorIsValid = false;
    } else {
      const evidencePath = path.join(root, anchor.evidencePath);
      if (!fs.existsSync(evidencePath)) {
        errors.push(`${anchorLabel}: evidence file is missing -> ${anchor.evidencePath}`);
        anchorIsValid = false;
      } else if (validCommit) {
        const evidenceText = fs.readFileSync(evidencePath, "utf8");
        if (!evidenceText.includes(anchor.value)) {
          errors.push(`${anchorLabel}: evidence file does not contain anchor ${anchor.value}`);
          anchorIsValid = false;
        }
      }
    }
    if (anchorIsValid) validAnchors.push(anchor);
  }
  return validAnchors;
}

function validateMaterializedState(materialized, context) {
  if (!isObject(materialized)) {
    errors.push(`${context.label}: materialized must be an object`);
    return;
  }

  if (!isCommit(materialized.gitlink)) {
    errors.push(`${context.label}: materialized.gitlink must be a lowercase 40-character commit`);
    return;
  }
  if (!new Set(["aligned", "drifted"]).has(materialized.baselineStatus)) {
    errors.push(`${context.label}: baselineStatus must be aligned or drifted`);
  }
  if (
    !Array.isArray(materialized.matchingClaimAnchors) ||
    !materialized.matchingClaimAnchors.every((value) => typeof value === "string")
  ) {
    errors.push(`${context.label}: matchingClaimAnchors must be a string array`);
  }

  if (context.baselineCommit) {
    const computedStatus =
      materialized.gitlink === context.baselineCommit ? "aligned" : "drifted";
    if (materialized.baselineStatus !== computedStatus) {
      errors.push(
        `${context.label}: baselineStatus=${materialized.baselineStatus}, computed ${computedStatus}`,
      );
    }
    context.counts[computedStatus] += 1;

    const materializedLine = context.profileText
      ? findHeaderLine(context.profileText, localMaterializedMarker, materialized.gitlink)
      : null;
    if (computedStatus === "drifted") {
      if (!materializedLine) {
        errors.push(
          `${context.label}: drifted source is missing a local-materialized header line for ${materialized.gitlink}`,
        );
      } else if (!materializedLine.includes(driftMarker)) {
        errors.push(`${context.label}: drifted local-materialized header line must state drift`);
      }
    } else if (materializedLine?.includes(driftMarker)) {
      errors.push(`${context.label}: aligned local-materialized header line incorrectly states drift`);
    }
  }

  const matchingClaimAnchors = context.claimAnchors
    .filter((anchor) => anchor.value === materialized.gitlink)
    .map((anchor) => anchor.id);
  if (!sameStringSet(materialized.matchingClaimAnchors, matchingClaimAnchors)) {
    errors.push(
      `${context.label}: matchingClaimAnchors=${JSON.stringify(materialized.matchingClaimAnchors)}, ` +
        `computed ${JSON.stringify(matchingClaimAnchors)}`,
    );
  }
  context.counts.claimMatched += matchingClaimAnchors.length;

  const sourceState = context.sourcePath
    ? context.sourceStateByPath.get(context.sourcePath)
    : null;
  if (!sourceState && context.sourcePath) {
    errors.push(`${context.label}: no readable materialized Git state for ${context.sourcePath}`);
    return;
  }
  if (!sourceState) return;

  if (sourceState.gitlink !== materialized.gitlink) {
    errors.push(
      `${context.label}: stage-0 gitlink ${sourceState.gitlink} != registry ${materialized.gitlink}`,
    );
  }
  if (sourceState.head !== sourceState.gitlink) {
    errors.push(`${context.label}: HEAD ${sourceState.head} != gitlink ${sourceState.gitlink}`);
  }
  if (
    typeof context.source.repositoryUrl === "string" &&
    normalizeRepositoryUrl(sourceState.origin) !==
      normalizeRepositoryUrl(context.source.repositoryUrl)
  ) {
    errors.push(
      `${context.label}: origin ${sourceState.origin} != registry ${context.source.repositoryUrl}`,
    );
  }
}

function buildRegistryOnlySourceState(registry) {
  const moduleByPath = new Map();
  const sourceStateByPath = new Map();
  if (!Array.isArray(registry?.profiles)) return { moduleByPath, sourceStateByPath };

  for (const profile of registry.profiles) {
    if (!Array.isArray(profile?.sources)) continue;
    for (const source of profile.sources) {
      if (!isObject(source) || typeof source.path !== "string") continue;
      if (typeof source.repositoryUrl === "string") {
        moduleByPath.set(source.path, { url: source.repositoryUrl });
      }
      if (isCommit(source.materialized?.gitlink) && typeof source.repositoryUrl === "string") {
        sourceStateByPath.set(source.path, {
          gitlink: source.materialized.gitlink,
          head: source.materialized.gitlink,
          origin: source.repositoryUrl,
        });
      }
    }
  }
  return { moduleByPath, sourceStateByPath };
}

if (process.argv.includes("--registry-only")) {
  const registry = readAnchorRegistry();
  const { moduleByPath, sourceStateByPath } = buildRegistryOnlySourceState(registry);
  const anchorCounts = validateAnchorRegistry(moduleByPath, sourceStateByPath, registry);
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(
    `Version anchor registry check passed: profiles=${anchorCounts.profiles}, ` +
      `git_sources=${anchorCounts.gitSources}, external_only=${anchorCounts.externalOnlyProfiles}, ` +
      `aligned=${anchorCounts.aligned}, drifted=${anchorCounts.drifted}, ` +
      `claim_matched=${anchorCounts.claimMatched}.`,
  );
  process.exit(0);
}

const pathKeys = runGit([
  "config",
  "--file",
  ".gitmodules",
  "--name-only",
  "--get-regexp",
  String.raw`^submodule\..*\.path$`,
])
  .split(/\r?\n/u)
  .filter(Boolean);

const counts = {
  declared: pathKeys.length,
  gitdir: 0,
  gitfile: 0,
  headMatch: 0,
  originMatch: 0,
  shallow: 0,
};
const moduleByPath = new Map();
const sourceStateByPath = new Map();

for (const pathKey of pathKeys) {
  const sectionKey = pathKey.slice(0, -".path".length);
  const submodulePath = normalizeRepositoryPath(
    runGit(["config", "--file", ".gitmodules", "--get", pathKey]),
  );
  const expectedUrl = runGit([
    "config",
    "--file",
    ".gitmodules",
    "--get",
    `${sectionKey}.url`,
  ]);
  const configuredShallow = runGit([
    "config",
    "--file",
    ".gitmodules",
    "--bool",
    "--get",
    `${sectionKey}.shallow`,
  ]);
  if (moduleByPath.has(submodulePath)) {
    errors.push(`${submodulePath}: duplicate path in .gitmodules`);
  } else {
    moduleByPath.set(submodulePath, {
      sectionKey,
      shallow: configuredShallow,
      url: expectedUrl,
    });
  }

  try {
    const absolutePath = path.join(root, submodulePath);
    const metadataPath = path.join(absolutePath, ".git");
    if (!fs.existsSync(absolutePath)) throw new Error("working tree is missing");
    if (!fs.existsSync(metadataPath)) throw new Error(".git metadata is missing");

    const metadata = fs.statSync(metadataPath);
    if (metadata.isDirectory()) counts.gitdir += 1;
    else if (metadata.isFile()) counts.gitfile += 1;
    else throw new Error(".git metadata is neither a directory nor a gitfile");

    const stage = runGit(["ls-files", "--stage", "--", submodulePath]);
    const gitlink = parseStageZeroGitlink(stage, submodulePath);

    const head = runGit(["rev-parse", "HEAD"], absolutePath).toLowerCase();
    if (head === gitlink) counts.headMatch += 1;
    else errors.push(`${submodulePath}: HEAD ${head} != gitlink ${gitlink}`);

    const origin = runGit(["remote", "get-url", "origin"], absolutePath);
    if (normalizeRepositoryUrl(origin) === normalizeRepositoryUrl(expectedUrl)) {
      counts.originMatch += 1;
    } else {
      errors.push(`${submodulePath}: origin ${origin} != ${expectedUrl}`);
    }
    sourceStateByPath.set(submodulePath, { gitlink, head, origin });

    const isShallow = runGit(["rev-parse", "--is-shallow-repository"], absolutePath);
    if (configuredShallow === "true" && isShallow === "true") counts.shallow += 1;
    else errors.push(`${submodulePath}: shallow config=${configuredShallow}, repository=${isShallow}`);
  } catch (error) {
    errors.push(`${submodulePath}: ${error.message}`);
  }
}

if (counts.declared !== 68) errors.push(`declared=${counts.declared}, expected 68`);
if (counts.gitdir + counts.gitfile !== counts.declared) {
  errors.push(`git metadata count=${counts.gitdir + counts.gitfile}, declared=${counts.declared}`);
}

const anchorCounts = validateAnchorRegistry(moduleByPath, sourceStateByPath);

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Upstream check passed: declared=${counts.declared}, gitdir=${counts.gitdir}, ` +
      `gitfile=${counts.gitfile}, head_match=${counts.headMatch}, ` +
      `origin_match=${counts.originMatch}, shallow=${counts.shallow}; ` +
      `profiles=${anchorCounts.profiles}, git_sources=${anchorCounts.gitSources}, ` +
      `external_only=${anchorCounts.externalOnlyProfiles}, aligned=${anchorCounts.aligned}, ` +
      `drifted=${anchorCounts.drifted}, claim_matched=${anchorCounts.claimMatched}.`,
  );
}
