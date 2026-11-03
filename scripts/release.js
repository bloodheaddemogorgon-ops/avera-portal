"use strict";

const { spawnSync } = require("node:child_process");
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
if (capture("gh", ["release", "view", tag, ...repoArgs]).ok) {
  console.error(`Release ${tag} already exists. Raise "version" in package.json first.`);
  process.exit(1);
}

console.log(`Building GraceDesk ${version}...`);
run("npm", ["run", "check"]);
run("npm", ["run", "dist:win:x64"]);
const x64Only = process.argv.includes("--x64-only");
if (!x64Only) run("npm", ["run", "dist:win:ia32"]);

const releaseDir = path.join(root, "release");
const assets = fs.readdirSync(releaseDir)
  .filter((name) => name.includes(version)
    && (name.endsWith(".exe") || name.endsWith(".blockmap"))
    && (!x64Only || name.includes("-x64.")))
  .concat(fs.existsSync(path.join(releaseDir, "latest.yml")) ? ["latest.yml"] : [])
  .concat(!x64Only && fs.existsSync(path.join(releaseDir, "latest-ia32.yml")) ? ["latest-ia32.yml"] : [])
  .map((name) => path.join(releaseDir, name));

if (!assets.some((file) => file.endsWith("latest.yml"))
  || (!x64Only && !assets.some((file) => file.endsWith("latest-ia32.yml")))
  || !assets.some((file) => x64Only ? file.endsWith("-x64.exe") : file.endsWith(".exe"))) {
  console.error("Build output is missing an installer or architecture update metadata.");
  process.exit(1);
}

console.log(`Publishing ${tag}...`);
run("gh", ["release", "create", tag, ...assets, "--title", `GraceDesk ${version}`, "--generate-notes", ...repoArgs], { shell: false });
pruneOldReleases();
console.log(`Released ${tag}. Installed apps can now update from Settings.`);
