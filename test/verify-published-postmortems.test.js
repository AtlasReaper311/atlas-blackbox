import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const INCIDENT_ID = "inc-20990101-000001";
const TITLE = "Synthetic postmortem title";
const SEALED = "2099-01-01 00:00:01Z";
const PUBLISHED_AT = "2099-01-02T03:04:05.678Z";
const VERIFIER_SOURCE_PATH = fileURLToPath(new URL("../scripts/verify-published-postmortems.mjs", import.meta.url));

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function runVerifier({ retained = false, detailStatus = 200 } = {}) {
  let detailRequests = 0;
  const tempRoot = await mkdtemp(join(tmpdir(), "atlas-blackbox-verifier-"));
  const scriptDirectory = join(tempRoot, "scripts");
  const postmortemDirectory = join(tempRoot, "postmortems");
  const verifierPath = join(scriptDirectory, "verify-published-postmortems.mjs");
  await mkdir(scriptDirectory, { recursive: true });
  await mkdir(postmortemDirectory, { recursive: true });
  await copyFile(VERIFIER_SOURCE_PATH, verifierPath);
  await writeFile(join(postmortemDirectory, "manifest.json"), JSON.stringify({
    [INCIDENT_ID]: { title: TITLE, sealed: SEALED, publishedAt: PUBLISHED_AT }
  }));
  await writeFile(join(postmortemDirectory, `${INCIDENT_ID}.html`), "<h2>Synthetic postmortem</h2>");

  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") {
      sendJson(response, 200, {
        ok: true,
        name: "atlas-blackbox",
        version: "1.0.2",
        postmortemAssetsAvailable: true,
        publishedPostmortemCount: 1
      });
      return;
    }
    if (path === "/incidents") {
      sendJson(response, 200, {
        ok: true,
        incidents: retained ? [{ id: INCIDENT_ID }] : []
      });
      return;
    }
    if (path === `/incidents/${INCIDENT_ID}`) {
      detailRequests += 1;
      sendJson(response, detailStatus, detailStatus === 200
        ? {
            ok: true,
            id: INCIDENT_ID,
            postmortemAssetsAvailable: true,
            hasPostmortem: true,
            postmortemTitle: TITLE,
            postmortemPublishedAt: PUBLISHED_AT
          }
        : { ok: false, error: "no such incident" });
      return;
    }
    if (path === `/incidents/${INCIDENT_ID}/postmortem`) {
      sendJson(response, 200, {
        ok: true,
        id: INCIDENT_ID,
        title: TITLE,
        sealed: SEALED,
        publishedAt: PUBLISHED_AT,
        html: "<h2>What broke</h2><p>Published test fixture.</p>"
      });
      return;
    }
    sendJson(response, 404, { ok: false, error: "unexpected test URL" });
  });

  let result;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [verifierPath], {
        env: {
          ...process.env,
          BLACKBOX_PUBLIC_BASE_URL: `http://127.0.0.1:${address.port}`,
          BLACKBOX_VERIFY_ATTEMPTS: "1",
          BLACKBOX_VERIFY_DELAY_MS: "0",
          EXPECTED_BLACKBOX_VERSION: "1.0.2"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(tempRoot, { recursive: true, force: true });
  }

  return { ...result, detailRequests };
}

test("published postmortem remains valid after its incident ages out of the rolling shelf", async () => {
  const result = await runVerifier({ retained: false });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.detailRequests, 0);
  assert.match(result.stdout, /verified 1 published postmortem/);
});

test("retained incidents still have their detail metadata checked", async () => {
  const result = await runVerifier({ retained: true });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.detailRequests, 1);
});

test("a retained incident whose detail route fails still fails verification", async () => {
  const result = await runVerifier({ retained: true, detailStatus: 404 });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /no such incident/);
});
