import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const INCIDENT_ID = "inc-20260705-230335";
const TITLE = "Blocked: atlas-systems.uk";
const SEALED = "2026-07-05 23:03:35Z";
const PUBLISHED_AT = "2026-07-30T17:32:21.780Z";
const VERIFIER_PATH = fileURLToPath(new URL("../scripts/verify-published-postmortems.mjs", import.meta.url));

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function runVerifier({ retained = false, detailStatus = 200 } = {}) {
  let detailRequests = 0;
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

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [VERIFIER_PATH], {
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

  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });

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
