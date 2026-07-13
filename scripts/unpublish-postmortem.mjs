#!/usr/bin/env node
// scripts/unpublish-postmortem.mjs
//
// Reverses scripts/publish-postmortem.mjs: removes one incident's HTML
// fragment and its manifest entry. Not destructive to git history, this
// only stops the live site serving it once committed and pushed; the
// content still exists in past commits if you ever want it back.
//
// Usage:
//   node scripts/unpublish-postmortem.mjs <incident-id>
 
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
 
const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTMORTEMS_DIR = resolve(__dirname, "..", "postmortems");
const MANIFEST_PATH = resolve(POSTMORTEMS_DIR, "manifest.json");
 
function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: node scripts/unpublish-postmortem.mjs <incident-id>");
    process.exit(1);
  }
 
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`no manifest.json found at ${MANIFEST_PATH}`);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
 
  if (!manifest[id]) {
    console.log(`"${id}" is not in the manifest; nothing to unpublish.`);
    process.exit(0);
  }
 
  const title = manifest[id].title;
  delete manifest[id];
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");
 
  const htmlPath = resolve(POSTMORTEMS_DIR, `${id}.html`);
  if (existsSync(htmlPath)) {
    unlinkSync(htmlPath);
  }
 
  console.log(`Unpublished ${id}: "${title}"`);
  console.log(`  removed  ${htmlPath}`);
  console.log(`  updated  ${MANIFEST_PATH}`);
  console.log("Next: git add postmortems/, commit, push.");
}
 
main();
