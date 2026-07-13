// scripts/lib/render.mjs
//
// Shared conversion logic for postmortem markdown -> HTML fragment.
// Used by both publish-postmortem.mjs (your local, manual workflow, still
// gated on status: PUBLISHED) and render-draft.mjs (the PR-based workflow,
// gated by PR review instead). Kept in one place so the two never
// silently diverge in what they actually produce.
 
export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
 
export function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => `<a href="${url}">${label}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  return out;
}
 
export function renderBody(markdown) {
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
 
export function parseFrontmatter(raw) {
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
 
export function extractTitle(body) {
  const m = body.match(/^#\s+Postmortem draft:\s*(.*)$/m) || body.match(/^#\s+(.*)$/m);
  const raw = m ? m[1].trim() : "";
  if (!raw || raw === "(untitled)") {
    throw new Error('draft still has no real title ("(untitled)" or missing h1); a real title is required before this can render');
  }
  return raw;
}
