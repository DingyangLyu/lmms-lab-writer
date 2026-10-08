/* global console */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();

const TARGET_JSON_FILES = [
  "package.json",
  "apps/desktop/package.json",
  "apps/collaboration/package.json",
  "packages/latex-editor/package.json",
  "packages/shared/package.json",
  "packages/writing/package.json",
  "apps/desktop/src-tauri/tauri.conf.json",
];

const TARGET_CARGO_FILE = "apps/desktop/src-tauri/Cargo.toml";

function fail(message) {
  console.error(`[sync-version] ${message}`);
  process.exit(1);
}

function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function readText(relPath) {
  const absPath = path.join(repoRoot, relPath);
  return fs.readFileSync(absPath, "utf8");
}

function writeText(relPath, content) {
  const absPath = path.join(repoRoot, relPath);
  fs.writeFileSync(absPath, content, "utf8");
}

function normalizeVersion(input) {
  if (!input) return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  const withoutV = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  const semverLike = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

  if (!semverLike.test(withoutV)) {
    fail(`Invalid version '${input}'. Expected semver like 0.1.1 or v0.1.1-beta.1`);
  }

  return withoutV;
}

function parseArgs(argv) {
  let explicitVersion = null;
  let fromTag = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--version") {
      explicitVersion = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--from-tag") {
      fromTag = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      console.log(`Usage:
  node scripts/sync-version.mjs
  node scripts/sync-version.mjs --version 0.1.1
  node scripts/sync-version.mjs --from-tag v0.1.1
  node scripts/sync-version.mjs --from-tag v0.1.1 --dry-run`);
      process.exit(0);
    }

    if (!arg.startsWith("-") && !explicitVersion && !fromTag) {
      explicitVersion = arg;
      continue;
    }

    fail(`Unknown argument '${arg}'`);
  }

  if (explicitVersion && fromTag) {
    fail("Use only one of --version or --from-tag");
  }

  return { explicitVersion, fromTag, dryRun };
}

function resolveTargetVersion({ explicitVersion, fromTag }) {
  if (explicitVersion) {
    return normalizeVersion(explicitVersion);
  }

  if (fromTag) {
    return normalizeVersion(fromTag);
  }

  const rootPackage = JSON.parse(readText("package.json"));
  return normalizeVersion(rootPackage.version);
}

function updateJsonVersion(relPath, version, dryRun) {
  const original = readText(relPath);
  const eol = detectEol(original);
  const parsed = JSON.parse(original);
  const prev = parsed.version;

  if (prev === version) {
    return { changed: false, previous: prev };
  }

  parsed.version = version;
  const next = `${JSON.stringify(parsed, null, 2)}${eol}`;

  if (!dryRun) {
    writeText(relPath, next);
  }

  return { changed: true, previous: prev };
}

function updateCargoVersion(relPath, version, dryRun) {
  const original = readText(relPath);
  const packageSectionMatch = original.match(/\[package\][\s\S]*?(?=\r?\n\[|$)/);

  if (!packageSectionMatch) {
    fail(`Could not find [package] section in ${relPath}`);
  }

  const packageSection = packageSectionMatch[0];
  const versionMatch = packageSection.match(/^version\s*=\s*"([^"]+)"/m);

  if (!versionMatch) {
    fail(`Could not find package version in ${relPath}`);
  }

  const previous = versionMatch[1];
  if (previous === version) {
    return { changed: false, previous };
  }

  const updatedSection = packageSection.replace(
    /^version\s*=\s*"[^"]+"/m,
    `version = "${version}"`,
  );
  const next = original.replace(packageSection, updatedSection);

  if (!dryRun) {
    writeText(relPath, next);
  }

  return { changed: true, previous };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = resolveTargetVersion(args);
  const results = [];

  for (const relPath of TARGET_JSON_FILES) {
    if (!fs.existsSync(path.join(repoRoot, relPath))) {
      continue;
    }
    results.push({
      file: relPath,
      ...updateJsonVersion(relPath, version, args.dryRun),
    });
  }

  if (fs.existsSync(path.join(repoRoot, TARGET_CARGO_FILE))) {
    results.push({
      file: TARGET_CARGO_FILE,
      ...updateCargoVersion(TARGET_CARGO_FILE, version, args.dryRun),
    });
  }

  const changedCount = results.filter((r) => r.changed).length;
  console.log(
    `[sync-version] ${args.dryRun ? "Would sync" : "Synced"} version to ${version} (${changedCount}/${results.length} files changed)`,
  );

  for (const result of results) {
    const status = result.changed ? (args.dryRun ? "would-update" : "updated") : "unchanged";
    console.log(
      `[sync-version] ${status}: ${result.file}${result.previous ? ` (was ${result.previous})` : ""}`,
    );
  }
}

main();
