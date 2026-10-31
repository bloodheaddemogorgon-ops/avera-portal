"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.join(__dirname, "..");
const sourceDirectories = ["desktop", "scripts", "test"];
const rootJavaScriptFiles = [
  "auth-rate-limiter.js",
  "server.js",
  "who-growth-reference.js",
];

async function collectJavaScriptFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJavaScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(entryPath);
    }
  }
  return files;
}

async function main() {
  const javascriptFiles = rootJavaScriptFiles.map((file) => path.join(projectRoot, file));
  for (const directory of sourceDirectories) {
    javascriptFiles.push(...await collectJavaScriptFiles(path.join(projectRoot, directory)));
  }
  for (const file of javascriptFiles) {
    new vm.Script(await fs.readFile(file, "utf8"), { filename: file });
  }

  const htmlPath = path.join(projectRoot, "index.html");
  const html = await fs.readFile(htmlPath, "utf8");
  const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map((match) => match[1])
    .filter((script) => script.trim());
  inlineScripts.forEach((script, index) => {
    new vm.Script(script, { filename: `${htmlPath}:inline-script-${index + 1}` });
  });
  console.log(`Syntax OK: ${javascriptFiles.length} JavaScript files and ${inlineScripts.length} inline scripts.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
