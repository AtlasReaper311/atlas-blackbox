import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowUrl = new URL(
  "../.github/workflows/render-postmortem-draft.yml",
  import.meta.url
);
const workflow = readFileSync(workflowUrl, "utf8");

function shellBodies(source) {
  const lines = source.split("\n");
  const bodies = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run:\s*\|\s*$/);
    if (!match) continue;

    const runIndent = match[1].length;
    const body = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === "") {
        body.push(line);
        continue;
      }
      const indent = line.match(/^\s*/)[0].length;
      if (indent <= runIndent) {
        index -= 1;
        break;
      }
      body.push(line);
    }
    bodies.push(body.join("\n"));
  }

  return bodies;
}

test("postmortem write-back is restricted to same-repository pull requests", () => {
  assert.match(workflow, /permissions:\n\s{2}contents: read/);
  assert.match(
    workflow,
    /if: github\.event\.pull_request\.head\.repo\.full_name == github\.repository/
  );
  assert.match(workflow, /render:\n(?:.|\n)*?permissions:\n\s{6}contents: write/);
});

test("pull-request controlled values are never interpolated directly into shell", () => {
  for (const body of shellBodies(workflow)) {
    assert.doesNotMatch(body, /\$\{\{\s*github\.event\.pull_request\./);
    assert.doesNotMatch(body, /\$\{\{\s*steps\./);
  }
});

test("changed draft paths are consumed as null-delimited data", () => {
  assert.match(workflow, /git diff --name-only -z/);
  assert.match(workflow, /read -r -d '' file/);
  assert.doesNotMatch(workflow, /GITHUB_OUTPUT/);
});

test("head ref is validated and passed to git push as quoted data", () => {
  assert.match(workflow, /HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.ref \}\}/);
  assert.match(workflow, /git check-ref-format --branch "\$HEAD_REF"/);
  assert.match(workflow, /git push origin "HEAD:refs\/heads\/\$HEAD_REF"/);
});
