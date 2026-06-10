import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateManifest, SCHEMA_VERSION } from "../schemas/container";

/**
 * BTS proof pack — "the six truths" (spec §8).
 *
 * This is the test that converts the sovereignty *claim* into *evidence*. It
 * drives the REAL hub the way a product would: the writable hub and a second
 * read-only hub are spawned as actual `hub/server.ts` processes and exercised
 * only over the Hub Protocol (HTTP). Nothing here reaches into storage directly
 * except to *prove* where bytes landed.
 *
 *   1. Container lives OUTSIDE the product repo.
 *   2. Product reads/writes ONLY through the hub (no token → no entry).
 *   3. Manifest VALIDATES (and a foreign schema_version fails loud).
 *   4. Asset POINTER resolves through the connector (pointer, never bytes).
 *   5. Secret value is NOT embedded (inline secret fails the schema).
 *   6. Expired product can't WRITE, but the hub can still LIST/EXPORT.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(repoRoot, "hub", "server.ts");
const TOKEN = "dev";

let dataRoot: string; // the customer-owned data layer (a temp dir, NOT the repo)
let writable: ChildProcess;
let readonly: ChildProcess;
let writableUrl: string;
let readonlyUrl: string;
let containerId: string;

/** Grab an ephemeral free port from the OS. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Spawn the real hub server and wait until it answers. */
async function startHub(opts: { port: number; readOnly?: boolean }): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SDH_ROOT: dataRoot,
    SDH_HOST: "127.0.0.1",
    SDH_PORT: String(opts.port),
    SDH_TOKEN: TOKEN, // dev override → keyHash = sha256("dev"); never writes .sdh-key
  };
  delete env.SDH_OPEN; // never pop a browser during tests
  if (opts.readOnly) env.SDH_READ_ONLY = "1";
  else delete env.SDH_READ_ONLY;

  // `node --import tsx hub/server.ts` runs the TS entrypoint with a real PID we
  // can kill cleanly (no shell, no npx wrapper to orphan).
  const proc = spawn(process.execPath, ["--import", "tsx", serverPath], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  proc.stdout?.on("data", (d) => (log += d));
  proc.stderr?.on("data", (d) => (log += d));

  const base = `http://127.0.0.1:${opts.port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`hub exited early (code ${proc.exitCode}):\n${log}`);
    }
    try {
      const r = await fetch(`${base}/setup-state`);
      if (r.ok) return proc;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`hub did not start within 20s:\n${log}`);
}

function stopHub(proc?: ChildProcess) {
  if (proc && proc.exitCode === null) proc.kill();
}

/** Small fetch helper that carries the hub key by default. */
function api(base: string, p: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("x-sdh-token")) headers.set("x-sdh-token", TOKEN);
  return fetch(`${base}${p}`, { ...init, headers });
}

beforeAll(async () => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "sdh-proof-"));
  const [pW, pR] = await Promise.all([freePort(), freePort()]);
  writableUrl = `http://127.0.0.1:${pW}`;
  readonlyUrl = `http://127.0.0.1:${pR}`;
  writable = await startHub({ port: pW });
  // read-only hub points at the SAME data layer → proves it can still serve it.
  readonly = await startHub({ port: pR, readOnly: true });
}, 60_000);

afterAll(() => {
  stopHub(writable);
  stopHub(readonly);
  if (dataRoot && existsSync(dataRoot)) rmSync(dataRoot, { recursive: true, force: true });
});

describe("SDH proof pack — the six truths", () => {
  it("truth 2: the product reaches the hub ONLY through the protocol (no key → 401)", async () => {
    // No token at all → rejected. The connector/storage has no side door.
    const noKey = await fetch(`${writableUrl}/capabilities`);
    expect(noKey.status).toBe(401);

    // Wrong key → rejected.
    const badKey = await fetch(`${writableUrl}/capabilities`, {
      headers: { "x-sdh-token": "not-the-key" },
    });
    expect(badKey.status).toBe(401);

    // Correct key → the protocol answers.
    const ok = await api(writableUrl, "/capabilities");
    expect(ok.status).toBe(200);
    const caps = await ok.json();
    expect(caps.schema_versions).toContain(SCHEMA_VERSION);
  });

  it("truth 1: a created container lives OUTSIDE the product repo", async () => {
    const res = await api(writableUrl, "/containers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "demo_master.project",
        title: "Proof Pack — Acme launch",
        owner: { org_id: "org_acme", workspace_id: "ws_marketing" },
        product: { name: "Demo Master", min_version: "1.0.0" },
        actor: "user:rob",
      }),
    });
    expect(res.status).toBe(201);
    const { container } = await res.json();
    containerId = container.container_id;
    expect(containerId).toMatch(/^sdh_[a-z0-9]+$/);

    // It physically lives in the customer's data layer (temp dir), not the repo.
    const onDisk = path.join(dataRoot, containerId, "container.json");
    expect(existsSync(onDisk)).toBe(true);
    expect(dataRoot.startsWith(repoRoot)).toBe(false);
  });

  it("truth 3: the manifest validates — and a foreign schema_version fails loud", async () => {
    // The live container the hub just served validates against the real schema.
    const res = await api(writableUrl, `/containers/${containerId}`);
    expect(res.status).toBe(200);
    const { manifest } = await res.json();
    expect(() => validateManifest(manifest)).not.toThrow();
    expect(validateManifest(manifest).container_id).toBe(containerId);

    // The shipped example container is valid too.
    const example = JSON.parse(
      readFileSync(path.join(repoRoot, "examples", "demo_master.project", "container.json"), "utf8"),
    );
    expect(() => validateManifest(example)).not.toThrow();

    // A foreign / future schema_version is rejected with a clear message.
    expect(() => validateManifest({ schema_version: "9.9" })).toThrow(/schema_version/);
  });

  it("truth 4: an asset is a POINTER that resolves through the connector", async () => {
    // Writes require a held lease ("don't corrupt the pack").
    const lockRes = await api(writableUrl, `/containers/${containerId}/locks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "user:rob" }),
    });
    const lock = await lockRes.json();
    expect(lock.ok).toBe(true);

    const bytes = Buffer.from("hero-image-pixels-not-base64-in-the-manifest");
    const put = await api(writableUrl, `/containers/${containerId}/assets/hero`, {
      method: "PUT",
      headers: { "x-sdh-lock": lock.lockId, "content-type": "application/octet-stream" },
      body: bytes,
    });
    expect(put.status).toBe(200);
    const { asset } = await put.json();
    // The manifest records a POINTER + integrity hash, never the bytes.
    expect(asset.pointer).toBe("assets/hero");
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);

    // The hub resolves that pointer back to the exact bytes via the connector.
    const get = await api(writableUrl, `/containers/${containerId}/assets/hero`);
    expect(get.status).toBe(200);
    const roundTrip = Buffer.from(await get.arrayBuffer());
    expect(roundTrip.equals(bytes)).toBe(true);

    // The manifest holds a string pointer, and the bytes live at that pointer on disk.
    const manifest = (await (await api(writableUrl, `/containers/${containerId}`)).json()).manifest;
    const entry = manifest.assets.find((a: { id: string }) => a.id === "hero");
    expect(typeof entry.pointer).toBe("string");
    expect(existsSync(path.join(dataRoot, containerId, "assets", "hero"))).toBe(true);
  });

  it("truth 5: secret VALUES are never embedded — only references are accepted", async () => {
    const base = (await (await api(writableUrl, `/containers/${containerId}`)).json()).manifest;

    // A proper secret REFERENCE validates.
    expect(() =>
      validateManifest({ ...base, secrets: [{ id: "nas", ref: "keychain:sdh/acme/nas" }] }),
    ).not.toThrow();

    // An inline secret VALUE (no keychain:/env:/file: scheme) fails the schema.
    expect(() =>
      validateManifest({ ...base, secrets: [{ id: "nas", ref: "hunter2-raw-password" }] }),
    ).toThrow();

    // Nothing the hub served carries embedded secret material.
    expect(base.secrets).toEqual([]);
  });

  it("truth 6: an expired/read-only product can't WRITE, but the hub still LISTS and EXPORTS", async () => {
    // A write against the read-only hub is refused...
    const blocked = await api(readonlyUrl, "/containers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "demo_master.project",
        title: "should not be writable",
        owner: { org_id: "org_acme", workspace_id: "ws_marketing" },
        product: { name: "Demo Master", min_version: "1.0.0" },
        actor: "user:rob",
      }),
    });
    expect(blocked.status).toBe(403);

    // ...yet the same hub still lists the container the customer already owns...
    const list = await api(readonlyUrl, "/containers");
    expect(list.status).toBe(200);
    const { containers } = await list.json();
    expect(containers.map((c: { container_id: string }) => c.container_id)).toContain(containerId);

    // ...and exports a portable bundle, so the customer is never trapped.
    const exp = await api(readonlyUrl, `/containers/${containerId}/export`);
    expect(exp.status).toBe(200);
    const bundle = await exp.json();
    expect(bundle.sdh_bundle).toBe("0.1");
    expect(bundle.manifest.container_id).toBe(containerId);
  });
});

/**
 * Fail-closed guarantees — the controls the hub ADVERTISES must be ENFORCED.
 * A recorded hash that is never checked, or an approval that ignores failed
 * checks, is worse than nothing: it looks like protection. These tests prove
 * the hub refuses (loudly, with a reason) rather than serving corruption,
 * rubber-stamping, or overwriting history.
 */
describe("SDH proof pack — fail-closed guarantees", () => {
  /** Create a fresh container over the protocol and return its id. */
  async function createContainer(title: string): Promise<string> {
    const res = await api(writableUrl, "/containers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "demo_master.project",
        title,
        owner: { org_id: "org_acme", workspace_id: "ws_marketing" },
        product: { name: "Demo Master", min_version: "1.0.0" },
        actor: "user:rob",
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).container.container_id;
  }

  /** Acquire a write lease and return the lock id. */
  async function lock(id: string): Promise<string> {
    const res = await api(writableUrl, `/containers/${id}/locks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "user:rob" }),
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    return body.lockId;
  }

  it("a tampered asset is refused with an integrity error, not served", async () => {
    const id = await createContainer("tamper target");
    const lockId = await lock(id);
    const put = await api(writableUrl, `/containers/${id}/assets/evidence`, {
      method: "PUT",
      headers: { "x-sdh-lock": lockId, "content-type": "application/octet-stream" },
      body: Buffer.from("the-original-evidence-bytes"),
    });
    expect(put.status).toBe(200);

    // Corrupt the bytes BEHIND the hub's back (disk failure / outside edit).
    writeFileSync(path.join(dataRoot, id, "assets", "evidence"), "tampered-evidence-bytes");

    // The hub must refuse to serve it — with a reason — not hand out corruption
    // under the manifest's seal of integrity.
    const get = await api(writableUrl, `/containers/${id}/assets/evidence`);
    expect(get.status).toBe(409);
    const err = await get.json();
    expect(err.error).toMatch(/integrity check failed/);
    expect(err.error).toMatch(/changed outside the hub|corrupt/);

    // Export of the same container must also refuse to build a corrupt bundle.
    const exp = await api(writableUrl, `/containers/${id}/export`);
    expect(exp.status).toBe(409);
    expect((await exp.json()).error).toMatch(/integrity check failed/);
  });

  it("approval is refused while any methodology check has failed", async () => {
    const id = await createContainer("governance gate");
    const lockId = await lock(id);
    const headers = { "x-sdh-lock": lockId, "content-type": "application/json" };

    const reqReview = await api(writableUrl, `/containers/${id}/review/request`, {
      method: "POST", headers, body: JSON.stringify({ actor: "user:rob" }),
    });
    expect(reqReview.status).toBe(200);

    // Approving WITH a failed check → refused, state unchanged.
    const overFailed = await api(writableUrl, `/containers/${id}/review/state`, {
      method: "POST", headers,
      body: JSON.stringify({
        state: "approved", actor: "expert:jane",
        checks: [{ id: "sources_cited", passed: false, note: "two claims uncited" }],
      }),
    });
    expect(overFailed.status).toBe(409);
    expect((await overFailed.json()).error).toMatch(/cannot approve/);
    const after = await api(writableUrl, `/containers/${id}/review`);
    expect((await after.json()).governance.state).toBe("in_review");

    // Record the failure honestly via changes_requested, cycle back to review...
    const changes = await api(writableUrl, `/containers/${id}/review/state`, {
      method: "POST", headers,
      body: JSON.stringify({
        state: "changes_requested", actor: "expert:jane",
        checks: [{ id: "sources_cited", passed: false, note: "two claims uncited" }],
      }),
    });
    expect(changes.status).toBe(200);
    const back = await api(writableUrl, `/containers/${id}/review/state`, {
      method: "POST", headers, body: JSON.stringify({ state: "in_review", actor: "user:rob" }),
    });
    expect(back.status).toBe(200);

    // ...then approving WITHOUT sending checks must still see the retained
    // failure — the silent-rubber-stamp path is closed.
    const rubberStamp = await api(writableUrl, `/containers/${id}/review/state`, {
      method: "POST", headers, body: JSON.stringify({ state: "approved", actor: "expert:jane" }),
    });
    expect(rubberStamp.status).toBe(409);
    expect((await rubberStamp.json()).error).toMatch(/sources_cited/);

    // Once the checks actually pass, approval goes through.
    const approve = await api(writableUrl, `/containers/${id}/review/state`, {
      method: "POST", headers,
      body: JSON.stringify({
        state: "approved", actor: "expert:jane",
        checks: [{ id: "sources_cited", passed: true }],
      }),
    });
    expect(approve.status).toBe(200);
    expect((await approve.json()).manifest.governance.state).toBe("approved");
  });

  it("import refuses to overwrite an existing container, and refuses bytes that don't match the manifest hash", async () => {
    // Build a real container with a real asset, then export its bundle.
    const id = await createContainer("import source");
    const lockId = await lock(id);
    await api(writableUrl, `/containers/${id}/assets/logo`, {
      method: "PUT",
      headers: { "x-sdh-lock": lockId, "content-type": "application/octet-stream" },
      body: Buffer.from("logo-pixel-bytes"),
    });
    const bundle = await (await api(writableUrl, `/containers/${id}/export`)).json();
    expect(bundle.assets.length).toBe(1);

    const importBundle = (b: unknown) =>
      api(writableUrl, "/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(b),
      });

    // Re-importing the same container id would silently clobber its history → 409.
    const clobber = await importBundle(bundle);
    expect(clobber.status).toBe(409);
    expect((await clobber.json()).error).toMatch(/already exists/);

    // A fresh id but TAMPERED bytes → the manifest hash catches it → 422.
    const tampered = {
      ...bundle,
      manifest: { ...bundle.manifest, container_id: "sdh_freshtamper1" },
      assets: [{ pointer: bundle.assets[0].pointer, b64: Buffer.from("not-the-logo").toString("base64") }],
    };
    const badImport = await importBundle(tampered);
    expect(badImport.status).toBe(422);
    expect((await badImport.json()).error).toMatch(/integrity check failed/);
    // And nothing half-imported landed on disk.
    expect(existsSync(path.join(dataRoot, "sdh_freshtamper1"))).toBe(false);

    // The honest bundle with a fresh id imports cleanly and round-trips.
    const fresh = { ...bundle, manifest: { ...bundle.manifest, container_id: "sdh_freshclean1" } };
    const goodImport = await importBundle(fresh);
    expect(goodImport.status).toBe(201);
    const roundTrip = await api(writableUrl, "/containers/sdh_freshclean1/assets/logo");
    expect(roundTrip.status).toBe(200);
    expect(Buffer.from(await roundTrip.arrayBuffer()).equals(Buffer.from("logo-pixel-bytes"))).toBe(true);
  });
});
