# Sovereign Data Hub (SDH) — Customer-Owned Data Control Plane & Work-Container Protocol, v0.1

> This is **not a storage product.** It is the **control plane + protocol layer**
> for customer-owned work. The customer owns the data layer; we license the
> engines that operate on it.

**The rule this proves:** *Products do not own data. The customer's data layer
does.*

**Custody (precise wording — avoid the trap):** *IFAI (Infinite Future AI) holds
nothing.* The customer-owned hub controls pointers, metadata, and access **on the
customer side**. The hub MAY index and cache metadata locally; it does **not**
move customer data to IFAI infrastructure.

**Three roles, never blurred:**
- **Product** = the licensed engine.
- **SDH** = the customer-owned data control plane.
- **Connector** = the physical storage adapter.

**Prototype path:** build against **Demo Master first** (it already has the
`demo_pack`/project-pack pattern), then extend one product at a time
(GoldmineAI → Persona Contract → CMM → CLCS) as *payload types*, not new
connector systems.

---

## 1. Roles and the two interfaces

```
  Product (licensed engine)        -> "Hub Protocol" (§3)   # products' only data dependency
        |
        v
  Sovereign Data Hub  (customer-owned control plane: index, governance, connectors, locks)
        |
        v
  Storage backend (local folder / NAS / S3 / their server)  -> "Connector Interface" (§4)
```

> **Products never touch storage. They only speak the Hub Protocol.**
> This single rule prevents the suite from becoming a mess of half-compatible
> filesystem/NAS/S3/server adapters, and keeps the sovereign claim honest.

---

## 2. The work container (the envelope)

```
<container>/
  container.json     # manifest (required)
  payload/           # product-specific files (the actual work)
  assets/            # optional local heavy media, OR omitted in favor of pointers
```

### container.json (manifest)

```json
{
  "schema_version": "0.1",
  "container_id": "sdh_3f9a1c8b",
  "version_id": "v_000001",
  "parent_version_id": null,
  "type": "demo_master.project",
  "owner": { "org_id": "org_acme", "workspace_id": "ws_marketing" },
  "product": { "name": "Demo Master", "min_version": "1.0.0" },
  "created_at": "2026-06-08T17:40:00Z",
  "updated_at": "2026-06-08T17:40:00Z",
  "title": "Acme Q3 launch",
  "payload": { "entry": "payload/project.json" },
  "assets": [
    { "id": "bg_hero", "pointer": "assets/ai-bg-hero.png", "sha256": "…", "bytes": 1361071 },
    { "id": "bts_run_12", "pointer": "nas://evidence/run12/redacted.mp4", "sha256": "…" }
  ],
  "secrets": [
    { "id": "nas_creds", "ref": "keychain:sdh/acme/nas" }
  ],
  "governance": {
    "state": "draft",
    "reviewers": [],
    "methodology_checks": [],
    "history": [
      { "actor": "user:rob", "action": "created", "at": "2026-06-08T17:40:00Z", "summary": "Initial container" }
    ]
  }
}
```

Rules:
- **`owner`** (`org_id`/`workspace_id`) — local governance, multi-client work,
  collision avoidance. *Not* for IFAI custody — the hub is customer-side.
- **`container_id` is stable; `version_id` advances on `commit`**, with
  `parent_version_id` forming the audit chain (rollbacks, BTS proof snapshots).
- **`type`** = `<product>.<payload-kind>`: same envelope, different payload
  (`demo_master.project`, `goldmine.knowledge`, `persona.contract`,
  `bts.demo_pack`, `cmm.*`, `clcs.*`).
- **Assets are pointers** with `sha256`; heavy media in `assets/` or anywhere
  reachable (`nas://`, `s3://`, `https://`). Never base64 in the manifest.
- **Secrets are references only** (`keychain:`/`env:`/`file:`) — never inline.
- **Governance has actors, not bare strings** — `reviewers[]` +
  `history[{actor, action, at, summary}]`. *No meaningful state change without a
  record* (matches Repair Lane / Change Publication discipline).
- **Unknown/foreign `schema_version` fails loud** on load.

---

## 3. Hub Protocol  (Product ↔ Hub)

Local HTTP/IPC to the customer-side hub. The product never learns the backend.

```
getCapabilities()                  -> { schema_versions, container_types, connectors,
                                        governance_enabled, read_only }
listContainers(type?)              -> ContainerRef[]
openContainer(id)                  -> { manifest, handle }
createContainer(type, title, owner)-> id
readPayload(id, path)              -> bytes
writePayload(id, path, bytes)
readAsset(id, assetId)             -> bytes          # hub resolves pointer/backend
writeAsset(id, assetId, bytes, meta)
listAssets(id)                     -> AssetRef[]
acquireLock(id, actor, ttl)        -> lockId         # don't corrupt the container
releaseLock(id, lockId)
commit(id, actor, summary)         -> version_id     # advances version, appends history
requestReview(id, actor) / getReview(id) / setReviewState(id, state, actor, checks)
```

- **`getCapabilities` first** — products must ask what the hub supports before
  assuming reviews, asset writes, or backend types. A casual user may have only
  simple local-folder mode (`governance_enabled: false`); products must not break.
- **Lock before write** — v0.1 needs no real-time collab, just "don't corrupt the
  pack." A lease with TTL is enough.
- **`commit`** advances `version_id` and appends a `history` record.

---

## 4. Connector Interface  (Hub ↔ Storage backend)

Implemented once per backend by the hub. Deliberately tiny.

```
readContainer(id)        -> ContainerBytes      # manifest + payload tree
writeContainer(id, bytes)
listContainers()         -> id[]
readAsset(ptr)           -> bytes               # resolves a manifest pointer
writeAsset(ptr, bytes)
listAssets(id)           -> ptr[]
```

**Reference backend (v0.1): local folder.** A root directory the customer picks
(File System Access API in-browser, or a path for the local agent). Each
container = a subdirectory with a `container.json`. This is the proof-pack
backend. Future backends (NAS/SMB, S3, their server) implement the same six ops;
no product changes when a backend is added.

---

## 5. Lifecycle & licensing

- **License gates the PRODUCT (engine)** — checked by the product, not the hub.
  The hub is unlicensed customer software; it holds the index, connectors, locks,
  and governance — all **on the customer side**.
- **On license expiry:** the product drops to **read-only / export**. The hub
  still lists, opens, and exports every container. Open format → opens in any
  conforming tool. **The customer is never trapped.**
- **IFAI infrastructure holds nothing.** The hub runs local or on the customer's
  server.

---

## 6. Governance (the suite advantage)

Every product's output converges at the hub, so the hub is the review gate:
- `governance.state`: `draft → in_review → approved` (+ `rejected` /
  `changes_requested`).
- The customer's **own domain experts** (or AI reviewers, or BTS) move state via
  actors; `methodology_checks` records named checks against company output
  requirements; `history` records who/when/why.
- **Cross-product flow can require `approved`** (e.g., a `goldmine.knowledge`
  container must be approved before Demo Master builds from it). Governed
  interoperability under customer custody — what siloed SaaS suites can't do.

---

## 7. Versioning & validation

- `schema_version` on every manifest; one shared validator (Zod + exported JSON
  Schema) that fails loud on unknown shapes / foreign versions.
- It is the same validator BTS uses in the proof tests (§8).

---

## 8. Build target (concrete, boring on purpose)

```
sovereign-data-hub/
  hub/
    server.ts              # speaks the Hub Protocol (§3) over local HTTP
    protocol.ts            # route handlers
    connectors/
      localFolder.ts       # reference backend (§4)
    governance.ts          # tiny state machine (§6)
    locks.ts               # lease/lock (§3)
  schemas/
    container.ts           # Zod schema + types + validate()  (exports JSON Schema)
  examples/
    demo_master.project/
      container.json
      payload/project.json
  tests/
    proof_pack.test.ts     # the six truths below
```

**The first BTS proof tests six simple truths — not "enterprise sovereignty":**
1. Container lives **outside** the product repo.
2. Product reads/writes **only through the hub**.
3. Manifest **validates**.
4. Asset **pointer resolves** through the connector.
5. Secret value is **not embedded**.
6. **Expired product can't write, but the hub can still list/export.**

That is enough to prove the primitive. Build order: §3 protocol → §2 envelope →
local-folder connector → Demo Master adapter → BTS proof → extend payload types.
Keep it a small customer-owned hub that proves one rule, not a giant enterprise
data platform.
