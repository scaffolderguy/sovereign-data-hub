# Build a Bridge — Sovereign Data Hub (SDH) Integration Guide, v0.1

The Sovereign Data Hub is an **open, customer-owned data layer.** Your app — a
*bridge* — speaks the Hub Protocol to read and write the user's work as portable
**containers.** You never store the user's data; their hub does, wherever they
point it. Build a bridge, optionally list it, and your customers use the same
hub as everyone else's.

Full contract: `docs/PROTOCOL_v0.1.md`. This guide is the practical "how do I
plug in" version.

---

## The one rule

**Your app does not own the user's data. It speaks the Hub Protocol.** The
user's hub (running on *their* machine/infra) holds the work. You hold nothing,
you phone home about nothing.

---

## 1. Talk to a hub

- A hub runs **customer-side**, default `http://127.0.0.1:8787` (loopback).
- Every request needs the header **`x-sdh-token: <key>`**. The user supplies
  their hub key (the hub prints it on start). No key, no access.
- **Ask what it supports before you assume anything:**

```
GET /capabilities
-> { schema_versions, container_types, connectors, governance_enabled, read_only }
```

Check this first, every session. If `read_only` is true, don't attempt writes.
If `governance_enabled` is false, don't assume review endpoints exist. Degrade
gracefully — a casual user may run a minimal hub.

---

## 2. Pick your container type

Containers are typed `<product>.<kind>` — e.g. `demo_master.project`,
`goldmine.knowledge`. Choose yours: **`yourapp.<kind>`**. The *envelope* is
shared across the whole ecosystem; the *payload* inside is yours to define.

---

## 3. The lifecycle: create → lock → write → commit

```
POST   /containers                         create one of your type
GET    /containers?type=yourapp.kind       list yours
GET    /containers/:id                     read the manifest
POST   /containers/:id/locks               acquire a write lease -> lockId
PUT    /containers/:id/payload/<path>      write payload (needs x-sdh-lock)
GET    /containers/:id/payload/<path>      read payload
PUT    /containers/:id/assets/:assetId     write an asset (needs x-sdh-lock)
POST   /containers/:id/commit              checkpoint: version + history
DELETE /containers/:id/locks/:lockId       release the lease
```

Writes require a held lease (`x-sdh-lock: <lockId>`), or you get `423`. Lock,
write, commit, release.

---

## 4. The container shape

```
<container>/
  container.json   # manifest — hub-managed; you mostly read it
  payload/         # YOUR files; your payload schema is yours
  assets/          # optional local media
```

Two non-negotiables (the conformance test checks them):

- **Assets are pointers, not bytes.** `assets/x.png`, `nas://…`, `s3://…`,
  `https://…` — each with a `sha256`. Never base64 a file into the manifest.
- **Secrets are references, never inline.** `keychain:…` / `env:…` / `file:…`.
  An inline secret value will be rejected.

---

## 5. Respect governance

Every container carries `governance.state` (`draft → in_review → approved`).

- **Don't assume `approved`.** If your bridge consumes another app's container
  for cross-product work, gate on `approved`.
- Move state only through the review endpoints; every change is recorded with
  the acting actor (`requested_by` ≠ `reviewers`). No silent state changes.

```
GET  /containers/:id/review
POST /containers/:id/review/request   { actor }
POST /containers/:id/review/state     { state, actor, checks? }
```

---

## 6. Golden rules (the etiquette that keeps it sovereign)

1. Treat the hub as your **only** data dependency — don't keep your own copy of
   the user's work.
2. **Never phone home.** The user's data and usage are not yours to see.
3. **Check capabilities; degrade gracefully** — handle "no governance", "no
   asset writes", "read-only".
4. **Lock before you write**, release when done.
5. **Assets by pointer, secrets by reference.** Always.
6. **Don't break old containers.** Build against a `schema_version`.

Follow these and you inherit the whole promise for free: your customers' data
stays theirs, portable, and recoverable — and your app is a good citizen of a
data layer it doesn't have to own or secure.

---

## 7. Be conformant

Pass the **conformance test** (the six truths: data outside your app, hub-only
read/write, manifest validates, pointers resolve, secrets not embedded,
read-only/export honored). Passing earns the **"SDH-compatible"** badge. The
test is open and re-runnable by anyone — the badge is *earned and verifiable*,
not granted.

---

## 8. List your bridge (opt-in)

Want discovery? Submit a listing to the **public registry**:

```json
{ "name": "MyApp", "subject": "notes", "description": "…",
  "homepage": "https://myapp.example", "container_types": ["myapp.note"],
  "compatible": true }
```

It's **opt-in and public** — only what you choose to publish. The hub's Apps tab
pulls the registry read-only; nothing is reported back. **Not listing is fine** —
your customers can still use your bridge; you simply won't appear in the store.
(The hub never tells anyone you exist. That's the point.)

---

## Minimal bridge (JavaScript)

```js
const HUB = "http://127.0.0.1:8787";
const KEY = process.env.SDH_KEY;            // the user's hub key
const base = { "x-sdh-token": KEY, "content-type": "application/json" };
const api = (p, o = {}) =>
  fetch(HUB + p, { headers: base, ...o })
    .then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e.error); }));

// 1. what does this hub support?
const caps = await api("/capabilities");
if (caps.read_only) throw new Error("hub is read-only");

// 2. create a container of YOUR type
const { container } = await api("/containers", {
  method: "POST",
  body: JSON.stringify({
    type: "myapp.note", title: "Hello", actor: "user:me",
    owner: { org_id: "org_local", workspace_id: "default" },
    product: { name: "MyApp", min_version: "1.0.0" },
  }),
});
const id = container.container_id;

// 3. lock, write your payload, commit, release
const { lockId } = await api(`/containers/${id}/locks`, {
  method: "POST", body: JSON.stringify({ actor: "user:me" }),
});
const locked = { "x-sdh-token": KEY, "x-sdh-lock": lockId };
await fetch(`${HUB}/containers/${id}/payload/note.json`, {
  method: "PUT",
  headers: { ...locked, "content-type": "application/octet-stream" },
  body: JSON.stringify({ text: "my work" }),
});
await api(`/containers/${id}/commit`, {
  method: "POST", headers: { ...locked, "content-type": "application/json" },
  body: JSON.stringify({ actor: "user:me", summary: "saved" }),
});
await fetch(`${HUB}/containers/${id}/locks/${lockId}`, { method: "DELETE", headers: base });

// 4. read it back
const mine = await api(`/containers/${id}`);
```

That's a complete bridge: ~25 lines, no SDK, no data held, no telemetry. Speak
the protocol and you're in.

---

## Versioning & support

- `schema_version` is on every manifest. Build against a version; validate on
  read; fail loud on a version you don't speak.
- The protocol evolves by published spec versions — bridges that conform to a
  version keep working. Breaking changes get a new major version, not a silent
  shift.

Welcome to the ecosystem. Hold nothing, lock in no one, build something good.
