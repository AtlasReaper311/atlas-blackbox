#!/usr/bin/env node
// scripts/publish-postmortem.mjs
//
// Converts one reviewed postmortem draft (atlas-postmortem's YAML
// frontmatter + plain-markdown body) into a static HTML fragment served
// by this Worker's POSTMORTEM_ASSETS binding, and records it in
// postmortems/manifest.json.
//
// Refuses to run unless the draft's frontmatter status is exactly
// "PUBLISHED", and refuses an unfilled "(untitled)" heading: an
// unreviewed draft cannot reach the live site by accident.
//
// Usage:
//   node scripts/publish-postmortem.mjs <path-to-reviewed-draft.md>
 
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
 
const REQUIRED_STATUS = "PUBLISHED";
const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTMORTEMS_DIR = resolve(__dirname, "..", "postmortems");
const MANIFEST_PATH = resolve(POSTMORTEMS_DIR, "manifest.json");
 
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
 
function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => `<a href="${url}">${label}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  return out;
}
 
function renderBody(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let inList = false;
  let i = 0;
 
  function closeList() {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  }
 
  while (i < lines.length) {
    const line = lines[i];
 
    if (/^##\s+/.test(line)) {
      closeList();
      html.push(`<h2>${renderInline(line.replace(/^##\s+/, ""))}</h2>`);
      i++;
      continue;
    }
    if (/^#\s+/.test(line)) {
      // The draft's own h1 (title line) is dropped from the body; the
      // manifest supplies the reviewed title instead.
      i++;
      continue;
    }
    if (/^-\s+/.test(line)) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${renderInline(line.replace(/^-\s+/, ""))}</li>`);
      i++;
      continue;
    }
    if (line.trim() === "") {
      closeList();
      i++;
      continue;
    }
 
    closeList();
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !/^##?\s+/.test(lines[i]) && !/^-\s+/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    html.push(`<p>${renderInline(para.join(" "))}</p>`);
  }
  closeList();
  return html.join("\n");
}
 
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("no --- delimited frontmatter block found at the top of the file");
  }
  const [, fmBlock, body] = match;
  const meta = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body };
}
 
function extractTitle(body) {
  const m = body.match(/^#\s+Postmortem draft:\s*(.*)$/m) || body.match(/^#\s+(.*)$/m);
  const raw = m ? m[1].trim() : "";
  if (!raw || raw === "(untitled)") {
    throw new Error('draft still has no real title ("(untitled)" or missing h1); fill in a real title before publishing');
  }
  return raw;
}
 
function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("usage: node scripts/publish-postmortem.mjs <path-to-reviewed-draft.md>");
    process.exit(1);
  }
 
  const raw = readFileSync(resolve(inputPath), "utf8");
  const { meta, body } = parseFrontmatter(raw);
 
  if (!meta.incident) {
    throw new Error('frontmatter is missing "incident:" (the incident id this postmortem belongs to)');
  }
  if (meta.status !== REQUIRED_STATUS) {
    throw new Error(
      `refusing to publish: frontmatter status is "${meta.status || "(missing)"}", must be exactly ` +
        `"${REQUIRED_STATUS}". Review the draft, edit the content, then set status: ${REQUIRED_STATUS} and run this again.`
    );
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
 
  console.log(`Published ${meta.incident}: "${title}"`);
  console.log(`  wrote  ${outputPath}`);
  console.log(`  wrote  ${MANIFEST_PATH}`);
  console.log("Next: git add postmortems/, commit, push.");
}
 
main();
