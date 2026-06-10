import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { LocalFolderConnector } from "./connectors/localFolder";
import { ApiError } from "./errors";
import { ContainerStore } from "./store";
import { LockService } from "./services/lockService";
import { CommitService } from "./services/commitService";
import { GovernanceService } from "./services/governanceService";
import { SCHEMA_VERSION, GovernanceState, validateManifest } from "../schemas/container";

/**
 * Sovereign Data Hub — local HTTP server (spec §3).
 *
 * Deliberately boring and dependency-light (built-in `http` only). It binds to
 * loopback, requires a local capability token, enforces lock-on-write, and
 * supports a read-only mode (proof-truth #6: writes 403 while list/read/export
 * still work). It is customer-side software; it holds no data on IFAI infra.
 */

const ROOT = process.env.SDH_ROOT || "./sdh-data";
const HOST = process.env.SDH_HOST || "127.0.0.1"; // loopback by default
const PORT = Number(process.env.SDH_PORT || 8787);
const READ_ONLY = /^(1|true|yes)$/i.test(process.env.SDH_READ_ONLY || "");
// Cap request bodies — without one, any token holder can exhaust memory with a
// single unbounded upload. Override with SDH_MAX_BODY_BYTES if you need more.
const MAX_BODY_BYTES = Number(process.env.SDH_MAX_BODY_BYTES || 64 * 1024 * 1024);

// The hub is loopback-only software. Binding to a network address exposes a
// single-shared-token, no-rate-limit API to the whole LAN, so it has to be an
// explicit, eyes-open choice — never one env var typo away.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
if (!LOOPBACK_HOSTS.has(HOST) && !/^(1|true|yes)$/i.test(process.env.SDH_ALLOW_NETWORK || "")) {
  console.error(
    `SDH: refusing to bind to non-loopback host "${HOST}". The hub key is a single shared token with no rate limiting — exposing it to a network needs an explicit opt-in. Set SDH_ALLOW_NETWORK=1 if you really mean it.`,
  );
  process.exit(1);
}
// The hub key is CHOSEN BY THE USER at setup and stored locally as a hash only —
// we never see or store the raw key. SDH_TOKEN env is a dev/smoke-test override.
const KEY_FILE = path.join(ROOT, ".sdh-key");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
function loadKeyHash(): string | null {
  if (process.env.SDH_TOKEN) return sha256(process.env.SDH_TOKEN);
  try { return existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : null; } catch { return null; }
}
let keyHash: string | null = loadKeyHash();

const KNOWN_TYPES = ["demo_master.project", "goldmine.knowledge", "persona.contract", "bts.demo_pack"];

const connector = new LocalFolderConnector(ROOT);
const store = new ContainerStore(connector);
const locks = new LockService();
const commits = new CommitService(store);
const governance = new GovernanceService(store);

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function sendBytes(res: http.ServerResponse, status: number, bytes: Buffer) {
  res.writeHead(status, { "content-type": "application/octet-stream" });
  res.end(bytes);
}
function readRaw(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c) => {
      total += (c as Buffer).length;
      if (total > MAX_BODY_BYTES) {
        // Stop buffering, answer 413, and drain the rest — destroying the
        // socket here would kill the response along with the request.
        req.removeAllListeners("data");
        req.removeAllListeners("end");
        reject(new ApiError(413, `request body exceeds the ${MAX_BODY_BYTES}-byte limit (SDH_MAX_BODY_BYTES)`));
        req.resume();
        return;
      }
      chunks.push(c as Buffer);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req: http.IncomingMessage): Promise<any> {
  const raw = await readRaw(req);
  return raw.length ? JSON.parse(raw.toString("utf8")) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const seg = url.pathname.split("/").filter(Boolean);

    // --- serve the friendly UI shell at "/" (no token; the data API still needs it) ---
    if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      try {
        const html = await readFile(fileURLToPath(new URL("../ui/index.html", import.meta.url)));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("UI not found");
      }
      return;
    }

    // --- setup: the user CHOOSES their own hub key on first run ---
    if (url.pathname === "/setup-state" && method === "GET") {
      return sendJson(res, 200, { configured: keyHash !== null });
    }
    if (url.pathname === "/setup" && method === "POST") {
      if (keyHash) return sendJson(res, 409, { error: "this hub already has a key" });
      const b = await readJson(req);
      if (!b.key || String(b.key).length < 4) {
        return sendJson(res, 400, { error: "choose a key of at least 4 characters" });
      }
      mkdirSync(ROOT, { recursive: true });
      keyHash = sha256(String(b.key));
      writeFileSync(KEY_FILE, keyHash, "utf8"); // store the HASH only — never the raw key
      return sendJson(res, 200, { ok: true });
    }

    // --- auth: the user's chosen key, compared by hash, on every data request ---
    // timingSafeEqual instead of !== : a plain string compare leaks how many
    // leading characters matched. Both sides are 64-char hex, so lengths agree.
    const providedHash = sha256(String(req.headers["x-sdh-token"] || ""));
    if (!keyHash || !timingSafeEqual(Buffer.from(providedHash), Buffer.from(keyHash))) {
      return sendJson(res, 401, { error: "missing or invalid hub key" });
    }
    // --- read-only mode: only GET allowed ---
    if (READ_ONLY && method !== "GET") {
      return sendJson(res, 403, { error: "hub is read-only; writes are disabled" });
    }

    const lockHeader = req.headers["x-sdh-lock"] as string | undefined;
    const requireLock = (id: string) => {
      if (!locks.held(id, lockHeader)) {
        sendJson(res, 423, { error: "container is not locked by you; acquire a lock first" });
        return false;
      }
      return true;
    };

    // GET /capabilities
    if (method === "GET" && seg[0] === "capabilities" && seg.length === 1) {
      return sendJson(res, 200, {
        schema_versions: [SCHEMA_VERSION],
        container_types: KNOWN_TYPES,
        connectors: ["local-folder"],
        governance_enabled: true,
        read_only: READ_ONLY,
        data_location: ROOT,
      });
    }

    // POST /import — bring a container in from an exported bundle.
    // Fail closed: never overwrite an existing container (that would silently
    // destroy its history), and never persist bytes that don't match the
    // integrity hash the manifest claims for them.
    if (seg[0] === "import" && seg.length === 1 && method === "POST") {
      const b = await readJson(req);
      const m = validateManifest(b.manifest);
      if (await store.exists(m.container_id)) {
        return sendJson(res, 409, {
          error: `container ${m.container_id} already exists; import refuses to overwrite its history`,
        });
      }
      // Decode and verify everything BEFORE the first write, so a bad bundle
      // leaves no half-imported container behind.
      const assets: { pointer: string; bytes: Buffer }[] = [];
      for (const a of b.assets || []) {
        if (typeof a?.pointer !== "string" || typeof a?.b64 !== "string") {
          return sendJson(res, 400, { error: "bundle asset entries need string pointer and b64" });
        }
        const entry = m.assets.find((x) => x.pointer === a.pointer);
        if (!entry) {
          return sendJson(res, 400, { error: `bundle asset "${a.pointer}" is not listed in the manifest` });
        }
        const bytes = Buffer.from(a.b64, "base64");
        if (entry.sha256) {
          const actual = createHash("sha256").update(bytes).digest("hex");
          if (actual !== entry.sha256) {
            return sendJson(res, 422, {
              error: `integrity check failed for asset "${a.pointer}": manifest says ${entry.sha256}, bundle bytes hash to ${actual}`,
            });
          }
        }
        assets.push({ pointer: a.pointer, bytes });
      }
      if (b.payload && (typeof b.payload.path !== "string" || typeof b.payload.b64 !== "string")) {
        return sendJson(res, 400, { error: "bundle payload needs string path and b64" });
      }
      await store.writeManifest(m.container_id, m);
      if (b.payload?.b64) await store.writePayload(m.container_id, b.payload.path, Buffer.from(b.payload.b64, "base64"));
      for (const a of assets) await store.writeAsset(m.container_id, a.pointer, a.bytes);
      return sendJson(res, 201, { container: m });
    }

    if (seg[0] === "containers") {
      // GET /containers?type=  | POST /containers
      if (seg.length === 1) {
        if (method === "GET") {
          return sendJson(res, 200, { containers: await store.list(url.searchParams.get("type") || undefined) });
        }
        if (method === "POST") {
          const b = await readJson(req);
          if (!b.type || !b.title || !b.owner || !b.product || !b.actor) {
            return sendJson(res, 400, { error: "type, title, owner, product, actor required" });
          }
          // Fail closed on unregistered types: /capabilities advertises what
          // this hub speaks, so creating something it doesn't would make that
          // list decorative and let typo'd types slip in silently.
          if (!KNOWN_TYPES.includes(b.type)) {
            return sendJson(res, 400, {
              error: `unknown container type "${b.type}" — this hub speaks: ${KNOWN_TYPES.join(", ")}`,
            });
          }
          const m = await store.create(b);
          return sendJson(res, 201, { container: m });
        }
      }

      const id = seg[1];

      // GET /containers/:id
      if (seg.length === 2 && method === "GET") {
        return sendJson(res, 200, { manifest: await store.open(id) });
      }

      // GET /containers/:id/export — a portable bundle (manifest + payload + assets)
      if (seg[2] === "export" && seg.length === 3 && method === "GET") {
        const m = await store.open(id);
        let payload: { path: string; b64: string } | null = null;
        try { payload = { path: m.payload.entry, b64: (await store.readPayload(id, m.payload.entry)).toString("base64") }; } catch {}
        const assets: { pointer: string; b64: string }[] = [];
        for (const a of m.assets) {
          if (/^[a-z0-9]+:\/\//i.test(a.pointer)) continue; // remote pointers travel as pointers
          let bytes: Buffer;
          try { bytes = await store.readAsset(id, a.pointer); } catch { continue; } // missing local file: skip
          // Never export corruption with a seal of integrity (same rule as GET).
          if (a.sha256) {
            const actual = createHash("sha256").update(bytes).digest("hex");
            if (actual !== a.sha256) {
              return sendJson(res, 409, {
                error: `integrity check failed for asset "${a.id}" during export: manifest says ${a.sha256}, bytes on disk hash to ${actual}. Refusing to build a corrupt bundle.`,
              });
            }
          }
          assets.push({ pointer: a.pointer, b64: bytes.toString("base64") });
        }
        return sendJson(res, 200, { sdh_bundle: "0.1", manifest: m, payload, assets });
      }

      // /containers/:id/payload/<rest...>
      if (seg[2] === "payload" && seg.length >= 4) {
        const rel = "payload/" + seg.slice(3).map(decodeURIComponent).join("/");
        if (method === "GET") return sendBytes(res, 200, await store.readPayload(id, rel));
        if (method === "PUT") {
          if (!requireLock(id)) return;
          await store.writePayload(id, rel, await readRaw(req));
          return sendJson(res, 200, { ok: true });
        }
      }

      // /containers/:id/assets  and  /containers/:id/assets/:assetId
      if (seg[2] === "assets") {
        if (seg.length === 3 && method === "GET") {
          return sendJson(res, 200, { assets: await store.listAssets(id) });
        }
        if (seg.length === 4) {
          const assetId = decodeURIComponent(seg[3]);
          const manifest = await store.open(id);
          if (method === "GET") {
            const a = manifest.assets.find((x) => x.id === assetId);
            if (!a) return sendJson(res, 404, { error: "asset not found" });
            const bytes = await store.readAsset(id, a.pointer);
            // The manifest's hash is a promise — keep it. Serving bytes that no
            // longer match would hand out corruption with a seal of integrity.
            if (a.sha256) {
              const actual = createHash("sha256").update(bytes).digest("hex");
              if (actual !== a.sha256) {
                return sendJson(res, 409, {
                  error: `integrity check failed for asset "${assetId}": manifest says ${a.sha256}, bytes on disk hash to ${actual}. The file was changed outside the hub or is corrupted.`,
                });
              }
            }
            return sendBytes(res, 200, bytes);
          }
          if (method === "PUT") {
            if (!requireLock(id)) return;
            // The asset id becomes a literal filename. Bound the charset, and
            // reject Windows reserved device names (nul, con, com1…) and
            // trailing dots — on Windows those silently become something else.
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(assetId) || assetId.endsWith(".")) {
              return sendJson(res, 400, {
                error: `invalid asset id "${assetId}" — use 1-128 letters, digits, dot, dash, underscore (no trailing dot)`,
              });
            }
            if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(assetId)) {
              return sendJson(res, 400, {
                error: `invalid asset id "${assetId}" — reserved device name on Windows`,
              });
            }
            const bytes = await readRaw(req);
            const pointer = `assets/${assetId}`;
            await store.writeAsset(id, pointer, bytes);
            // upsert the manifest asset entry (pointer + integrity)
            const digest = createHash("sha256").update(bytes).digest("hex");
            const entry = { id: assetId, pointer, sha256: digest, bytes: bytes.length };
            const assets = manifest.assets.filter((x) => x.id !== assetId).concat(entry);
            await store.writeManifest(id, { ...manifest, assets, updated_at: new Date().toISOString() });
            return sendJson(res, 200, { asset: entry });
          }
        }
      }

      // POST /containers/:id/locks  | DELETE /containers/:id/locks/:lockId
      if (seg[2] === "locks") {
        if (seg.length === 3 && method === "POST") {
          const b = await readJson(req);
          if (!b.actor) return sendJson(res, 400, { error: "actor required" });
          return sendJson(res, 200, locks.acquire(id, b.actor, b.ttlMs));
        }
        if (seg.length === 4 && method === "DELETE") {
          return sendJson(res, 200, { released: locks.release(id, decodeURIComponent(seg[3])) });
        }
      }

      // POST /containers/:id/commit — pass expected_version (the version_id your
      // work was based on) to get optimistic concurrency: a stale commit is
      // refused instead of silently overwriting someone else's.
      if (seg[2] === "commit" && seg.length === 3 && method === "POST") {
        if (!requireLock(id)) return;
        const b = await readJson(req);
        if (!b.actor || !b.summary) return sendJson(res, 400, { error: "actor and summary required" });
        return sendJson(res, 200, await commits.commit(id, b.actor, b.summary, b.expected_version));
      }

      // review (governance)
      if (seg[2] === "review") {
        if (seg.length === 3 && method === "GET") {
          return sendJson(res, 200, { governance: await governance.get(id) });
        }
        if (seg[3] === "request" && method === "POST") {
          if (!requireLock(id)) return;
          const b = await readJson(req);
          return sendJson(res, 200, { manifest: await governance.requestReview(id, b.actor) });
        }
        if (seg[3] === "state" && method === "POST") {
          if (!requireLock(id)) return;
          const b = await readJson(req);
          return sendJson(res, 200, {
            manifest: await governance.setState(id, b.state as GovernanceState, b.actor, b.checks || []),
          });
        }
      }
    }

    return sendJson(res, 404, { error: "no such route" });
  } catch (err) {
    if (err instanceof ApiError) {
      return sendJson(res, err.status, { error: err.message });
    }
    console.error("SDH error:", err);
    return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Sovereign Data Hub listening on http://${HOST}:${PORT}`);
  console.log(`  root:      ${ROOT}`);
  console.log(`  read_only: ${READ_ONLY}`);
  console.log(`  key:       ${keyHash ? (process.env.SDH_TOKEN ? "dev override (SDH_TOKEN)" : "user-chosen (stored as hash)") : "NOT SET — open the UI to create your hub key"}`);
  if (process.env.SDH_OPEN) {
    const opener = process.platform === "win32" ? 'start "" ' : process.platform === "darwin" ? "open " : "xdg-open ";
    import("node:child_process").then((cp) => cp.exec(opener + `http://${HOST}:${PORT}/`)).catch(() => {});
  }
});
