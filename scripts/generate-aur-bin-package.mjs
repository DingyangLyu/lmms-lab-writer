/* global console */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function fail(message) {
  console.error(`[aur] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    tag: "",
    version: "",
    linuxArtifactsDir: "aur-input",
    outDir: "aur-dist/lmms-lab-writer-bin",
    repo: "EvolvingLMMs-Lab/lmms-lab-writer",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tag") {
      args.tag = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--version") {
      args.version = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--linux-artifacts-dir") {
      args.linuxArtifactsDir = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--out-dir") {
      args.outDir = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--repo") {
      args.repo = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      console.log(`Usage:
  node scripts/generate-aur-bin-package.mjs --tag v0.1.1 --linux-artifacts-dir aur-input

Options:
  --tag <vX.Y.Z>              Git tag used in release URL
  --version <X.Y.Z>           Package version (overrides --tag)
  --linux-artifacts-dir <dir> Downloaded Linux artifact directory (default: aur-input)
  --out-dir <dir>             Output directory for PKGBUILD/.SRCINFO
  --repo <owner/repo>         GitHub repo for release URLs`);
      process.exit(0);
    }
    fail(`Unknown argument '${arg}'`);
  }

  return args;
}

function normalizeVersion(input) {
  if (!input) return "";
  const trimmed = input.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

function collectFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }

  return results;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function toGithubReleaseAssetName(fileName) {
  return fileName.replace(/\s+/g, ".");
}

function inferVersionFromTagOrArg(args) {
  const version = normalizeVersion(args.version || args.tag);
  if (!version) {
    fail("Provide --tag or --version");
  }
  if (version.includes("-")) {
    fail(`AUR stable package generation only supports stable versions. Got '${version}'`);
  }
  if (!/^\d+\.\d+\.\d+(?:\.[0-9A-Za-z]+)?$/.test(version)) {
    fail(`Invalid version '${version}'`);
  }
  return version;
}

function pickDebAsset(files, version) {
  const debs = files.filter((file) => file.endsWith(".deb"));
  if (debs.length === 0) {
    fail("No .deb file found in Linux artifacts");
  }

  const preferred = debs.find((file) =>
    file.toLowerCase().includes(`_${version.toLowerCase()}_amd64.deb`),
  );
  if (preferred) return preferred;

  const amd64 = debs.find((file) => file.toLowerCase().endsWith("_amd64.deb"));
  if (amd64) return amd64;

  return debs[0];
}

function buildPkgbuild({
  version,
  sourceFileName,
  sourceUrl,
  sha256,
}) {
  return `pkgname=lmms-lab-writer-bin
pkgver=${version}
pkgrel=1
pkgdesc="AI-native LaTeX editor desktop application (prebuilt binary)"
arch=('x86_64')
url="https://github.com/EvolvingLMMs-Lab/lmms-lab-writer"
license=('MIT')
depends=('gtk3' 'webkit2gtk-4.1' 'libappindicator-gtk3')
provides=('lmms-lab-writer')
conflicts=('lmms-lab-writer')
options=(!strip)
source_x86_64=("${sourceFileName}::${sourceUrl}")
sha256sums_x86_64=('${sha256}')

package() {
  local workdir data_archive
  workdir="\${srcdir}/deb-extract"
  rm -rf "\${workdir}"
  mkdir -p "\${workdir}"

  bsdtar -xf "\${srcdir}/${sourceFileName}" -C "\${workdir}"
  data_archive="$(find "\${workdir}" -maxdepth 1 -type f -name 'data.tar.*' | head -n 1)"
  if [[ -z "\${data_archive}" ]]; then
    echo "data.tar.* not found in ${sourceFileName}" >&2
    return 1
  fi

  bsdtar -xf "\${data_archive}" -C "\${pkgdir}"
}
`;
}

function buildSrcinfo({
  version,
  sourceFileName,
  sourceUrl,
  sha256,
}) {
  return `pkgbase = lmms-lab-writer-bin
\tpkgdesc = AI-native LaTeX editor desktop application (prebuilt binary)
\tpkgver = ${version}
\tpkgrel = 1
\turl = https://github.com/EvolvingLMMs-Lab/lmms-lab-writer
\tarch = x86_64
\tlicense = MIT
\tdepends = gtk3
\tdepends = webkit2gtk-4.1
\tdepends = libappindicator-gtk3
\tprovides = lmms-lab-writer
\tconflicts = lmms-lab-writer
\toptions = !strip
\tsource_x86_64 = ${sourceFileName}::${sourceUrl}
\tsha256sums_x86_64 = ${sha256}

pkgname = lmms-lab-writer-bin
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = inferVersionFromTagOrArg(args);
  const tag = args.tag || `v${version}`;
  const allFiles = collectFiles(args.linuxArtifactsDir);
  const debPath = pickDebAsset(allFiles, version);
  const debAssetName = path.basename(debPath);
  const releaseAssetName = toGithubReleaseAssetName(debAssetName);
  const encodedAssetName = encodeURIComponent(releaseAssetName);
  const sourceFileName = `lmms-lab-writer_${version}_amd64.deb`;
  const sourceUrl = `https://github.com/${args.repo}/releases/download/${tag}/${encodedAssetName}`;
  const sha256 = sha256File(debPath);

  fs.mkdirSync(args.outDir, { recursive: true });

  const pkgbuild = buildPkgbuild({
    version,
    sourceFileName,
    sourceUrl,
    sha256,
  });
  const srcinfo = buildSrcinfo({
    version,
    sourceFileName,
    sourceUrl,
    sha256,
  });

  fs.writeFileSync(path.join(args.outDir, "PKGBUILD"), pkgbuild, "utf8");
  fs.writeFileSync(path.join(args.outDir, ".SRCINFO"), srcinfo, "utf8");
  fs.writeFileSync(
    path.join(args.outDir, "README.md"),
    `# lmms-lab-writer-bin (AUR)\n\nGenerated from release tag ${tag}.\n\nFiles:\n- PKGBUILD\n- .SRCINFO\n`,
    "utf8",
  );

  console.log(`[aur] generated AUR package files in ${args.outDir}`);
  console.log(`[aur] source asset: ${debAssetName}`);
  console.log(`[aur] release asset: ${releaseAssetName}`);
  console.log(`[aur] sha256: ${sha256}`);
}

main();
