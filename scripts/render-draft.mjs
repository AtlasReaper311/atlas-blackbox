#!/usr/bin/env node
// scripts/render-draft.mjs
//
// Converts one draft under drafts/ into a static HTML fragment plus a
// manifest.json entry, same converter as publish-postmortem.mjs, but
// without requiring status: PUBLISHED. This only ever runs inside
// render-postmortem-draft.yml, against an open pull request; nothing it
// produces reaches production until that PR is reviewed and merged by
// hand. The PR review is the gate here, not a frontmatter string, so
// there is nothing left for the string to protect against on this path.
//
// A real title is still required, catches an obviously unfinished draft
// before a human even opens the diff.
//
// Usage:
//   node scripts/render-draft.mjs <path-to-draft.md>
 
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderBody, parseFrontmatter, extractTitle } from "./lib/render.mjs";
 
const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTMORTEMS_DIR = resolve(__dirname, "..", "postmortems");
const MANIFEST_PATH = resolve(POSTMORTEMS_DIR, "manifest.json");
 
function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("usage: node scripts/render-draft.mjs <path-to-draft.md>");
    process.exit(1);
  }
 
  const raw = readFileSync(resolve(inputPath), "utf8");
  const { meta, body } = parseFrontmatter(raw);
 
  if (!meta.incident) {
    throw new Error('frontmatter is missing "incident:" (the incident id this postmortem belongs to)');
  }
 
  const title = extractTitle(body);
  const html = renderBody(body);
 
  if (!existsSync(POSTMORTEMS_DIR)) mkdirSync(POSTMORTEMS_DIR, { recursive: true });
 
  const outputPath = resolve(POSTMORTEMS_DIR, `${meta.incident}.html`);
  writeFileSync(outputPath, html, "utf8");
 
  let manifest = {};
  if (existsSync(MANIFEST_PATH)) {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  }
  manifest[meta.incident] = {
    title,
    sealed: meta.sealed || null,
    publishedAt: new Date().toISOString()
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");
 
  console.log(`Rendered ${meta.incident}: "${title}"`);
  console.log(`  wrote  ${outputPath}`);
  console.log(`  wrote  ${MANIFEST_PATH}`);
}
 
main();
