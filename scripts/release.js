"use strict";

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const { version } = require("../package.json");
const tag = `v${version}`;
const isWindows = process.platform === "win32";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: isWindows, ...options });
  if (result.status !== 0) {
    console.error(`Command failed: ${command} ${args.join(" ")}`);
    process.exit(result.status || 1);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", shell: isWindows });
  return { ok: result.status === 0, out: (result.stdout || "").trim() };
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest("hex")}`;
}

const KEEP_RELEASES = 3;
const publishConfig = [].concat(require("../package.json").build?.publish || [])[0] || {};
const repoArgs = publishConfig.owner && publishConfig.repo ? ["--repo", `${publishConfig.owner}/${publishConfig.repo}`] : [];

function pruneOldReleases() {
  const listed = capture("gh", ["release", "list", "--limit", "200", "--json", "tagName,createdAt", ...repoArgs]);
  if (!listed.ok) {
    console.warn("Could not list releases; skipping cleanup of old installers.");
    return;
  }
  let releases;
  try { releases = JSON.parse(listed.out); } catch { return; }
  releases.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  for (const old of releases.slice(KEEP_RELEASES)) {
    console.log(`Deleting old release ${old.tagName}...`);
    spawnSync("gh", ["release", "delete", old.tagName, "--yes", "--cleanup-tag", ...repoArgs], { cwd: root, stdio: "inherit" });
  }
}

if (fs.existsSync(path.join(root, "desktop", "embedded-online.json")) && process.env.PORTAL_ALLOW_PUBLIC_EMBED !== "1") {
  console.error("desktop/embedded-online.json exists. Remove it before publishing a public release.");
  process.exit(1);
}
if (!capture("gh", ["auth", "status"]).ok) {
  console.error("GitHub CLI is not signed in. Run: gh auth login");
  process.exit(1);
}
if (process.argv.includes("--prune-only")) {
  pruneOldReleases();
  process.exit(0);
}
let releaseDraftExists = false;
const existingRelease = capture("gh", ["release", "view", tag, "--json", "isDraft", ...repoArgs]);
if (existingRelease.ok) {
  let release;
  try {
    release = JSON.parse(existingRelease.out);
  } catch {
    console.error(`Could not read the state of release ${tag}.`);
    process.exit(1);
  }
  if (!release.isDraft) {
    console.error(`Release ${tag} already exists. Raise "version" in package.json first.`);
    process.exit(1);
  }
  releaseDraftExists = true;
  console.log(`Resuming draft release ${tag}...`);
}

const x64Only = process.argv.includes("--x64-only");
const releaseDir = path.join(root, "release");
const expectedAssets = [
  `GraceDesk-Setup-${version}-x64.exe`,
  `GraceDesk-Setup-${version}-x64.exe.blockmap`,
  "latest.yml",
];
if (!x64Only) {
  expectedAssets.push(
    `GraceDesk-Setup-${version}-ia32.exe`,
    `GraceDesk-Setup-${version}-ia32.exe.blockmap`,
    "latest-ia32.yml",
  );
}

console.log(`Building GraceDesk ${version}...`);
run("npm", ["run", "check"]);
if (releaseDraftExists) {
  const missingLocalAssets = expectedAssets.filter((name) => !fs.existsSync(path.join(releaseDir, name)));
  if (missingLocalAssets.some((name) => name.includes("-x64.") || name === "latest.yml")) {
    run("npm", ["run", "dist:win:x64"]);
  }
  if (!x64Only && missingLocalAssets.some((name) => name.includes("-ia32.") || name === "latest-ia32.yml")) {
    run("npm", ["run", "dist:win:ia32"]);
  }
} else {
  run("npm", ["run", "dist:win:x64"]);
  if (!x64Only) run("npm", ["run", "dist:win:ia32"]);
}

const assets = fs.readdirSync(releaseDir)
  .filter((name) => name.includes(version)
    && (name.endsWith(".exe") || name.endsWith(".blockmap"))
    && (!x64Only || name.includes("-x64.")))
  .concat(fs.existsSync(path.join(releaseDir, "latest.yml")) ? ["latest.yml"] : [])
  .concat(!x64Only && fs.existsSync(path.join(releaseDir, "latest-ia32.yml")) ? ["latest-ia32.yml"] : [])
  .map((name) => path.join(releaseDir, name));

const assetNames = new Set(assets.map((file) => path.basename(file)));
const missingAssets = expectedAssets.filter((name) => !assetNames.has(name));
if (missingAssets.length > 0) {
  console.error(`Build output is missing required release assets: ${missingAssets.join(", ")}`);
  process.exit(1);
}

if (!releaseDraftExists) {
  run("gh", ["release", "create", tag, "--draft", "--title", `GraceDesk ${version}`, "--generate-notes", ...repoArgs], { shell: false });
}
const draftAssetsResult = capture("gh", ["release", "view", tag, "--json", "assets", ...repoArgs]);
if (!draftAssetsResult.ok) {
  console.error(`Could not inspect assets for draft release ${tag}.`);
  process.exit(1);
}
let draftAssets;
try {
  draftAssets = JSON.parse(draftAssetsResult.out).assets;
} catch {
  console.error(`Could not read the assets for draft release ${tag}.`);
  process.exit(1);
}
const assetsToUpload = [];
for (const file of assets) {
  const name = path.basename(file);
  const uploaded = draftAssets.find((asset) => asset.name === name);
  if (!uploaded) {
    assetsToUpload.push(file);
    continue;
  }
  if (uploaded.size !== fs.statSync(file).size || uploaded.digest !== sha256File(file)) {
    console.error(`Draft release already contains a different ${name}; refusing to replace it.`);
    process.exit(1);
  }
  console.log(`Already uploaded and verified ${name}.`);
}
if (assetsToUpload.length > 0) {
  run("gh", ["release", "upload", tag, ...assetsToUpload, ...repoArgs], { shell: false });
}
console.log(`Publishing ${tag}...`);
run("gh", ["release", "edit", tag, "--draft=false", ...repoArgs], { shell: false });
pruneOldReleases();
console.log(`Released ${tag}. Installed apps can now update from Settings.`);
