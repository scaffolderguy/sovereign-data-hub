import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { LocalFolderConnector } from "./connectors/localFolder";
import { ContainerStore } from "./store";
import { LockService } from "./services/lockService";
import { CommitService } from "./services/commitService";
import { GovernanceService } from "./services/governanceService";
import { SCHEMA_VERSION, GovernanceState } from "../schemas/container";

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
    req.on("data", (c) => chunks.push(c as Buffer));
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
    if (!keyHash || sha256(String(req.headers["x-sdh-token"] || "")) !== keyHash) {
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
      });
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
          const m = await store.create(b);
          return sendJson(res, 201, { container: m });
        }
      }

      const id = seg[1];

      // GET /containers/:id
      if (seg.length === 2 && method === "GET") {
        return sendJson(res, 200, { manifest: await store.open(id) });
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
            return sendBytes(res, 200, await store.readAsset(id, a.pointer));
          }
          if (method === "PUT") {
            if (!requireLock(id)) return;
            const bytes = await readRaw(req);
            const pointer = `assets/${assetId}`;
            await store.writeAsset(id, pointer, bytes);
            // upsert the manifest asset entry (pointer + integrity)
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            const entry = { id: assetId, pointer, sha256, bytes: bytes.length };
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

      // POST /containers/:id/commit
      if (seg[2] === "commit" && seg.length === 3 && method === "POST") {
        if (!requireLock(id)) return;
        const b = await readJson(req);
        if (!b.actor || !b.summary) return sendJson(res, 400, { error: "actor and summary required" });
        return sendJson(res, 200, await commits.commit(id, b.actor, b.summary));
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
