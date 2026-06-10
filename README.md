# Sovereign Data Hub (SDH)

Customer-owned **data control plane + work-container protocol** for the Infinite
Future AI suite. **Not a storage product.** The customer owns the data layer; we
license the engines that operate on it.

> **The rule:** Products do not own data. The customer's data layer does.
> Products speak only the Hub Protocol; the hub owns connectors, governance, and
> the container index — all on the customer side. IFAI holds nothing.

Spec: `docs/PROTOCOL_v0.1.md` · Build a bridge: `BRIDGE_GUIDE.md`

**License:** Apache-2.0 (open standard — build on it, keep the attribution).
Run a hub, build a bridge, list it if you like. Infinite Future AI licenses the
*engines*; the hub and protocol are everyone's.

## Layout (current)

```
sovereign-data-hub/
  schemas/
    container.ts            # Zod manifest schema + validateManifest()        [DONE]
  hub/
    connectors/
      localFolder.ts        # reference backend, six-op interface, atomic write [DONE]
    store.ts                # connector + validation (nothing invalid persists) [DONE]
    services/
      lockService.ts        # lease/lock (write guard)                          [DONE]
      commitService.ts      # version_id + parent + history                     [DONE]
      governanceService.ts  # draft->in_review->approved state machine          [DONE]
    server.ts               # Hub Protocol over local HTTP                      [DONE]
  examples/
    demo_master.project/    # a valid v0.1 container                            [DONE]
  tests/
    proof_pack.test.ts      # the six truths                                    [DONE]
```

## Design choices (v0.1)

- **Dependency-light:** built-in `node:http`, only real dep is `zod`. Smaller
  surface = stronger sovereignty/auditability claim.
- **Loopback + local token:** binds `127.0.0.1`, every request needs
  `x-sdh-token`. Loopback alone isn't auth.
- **Lock-on-write:** payload/asset/commit/governance writes need a held lease
  (`x-sdh-lock`) → 423 otherwise. "Don't corrupt the pack."
- **Atomic manifest writes:** temp + rename, never a half-written `container.json`.
- **Read-only mode:** `SDH_READ_ONLY=1` → all writes 403, list/read/export still
  work (proves "expired product can't write, hub can still export").

## Run

```
npm install
SDH_ROOT=./sdh-data SDH_TOKEN=dev npm start
# prints: Sovereign Data Hub listening on http://127.0.0.1:8787
# every request needs header  x-sdh-token: dev

# smoke test (new terminal):
curl -s -H "x-sdh-token: dev" http://127.0.0.1:8787/capabilities
```

Verify types: `npm run typecheck`.

## Status (build order)

1. ✅ Hub protocol + container envelope spec
2. ✅ Container schema + validator
3. ✅ Local-folder connector
4. ✅ Hub server (capabilities, locks, commit, governance, read-only)
5. ✅ Demo Master adapter — `lib/sovereign/` in Demo Master; verified round-trip
6. ✅ BTS proof-pack test (the six truths) — `npm test`

## Runtime
TypeScript/Node, run via `tsx`. Prototyped against **Demo Master** first
(it's the first *client*, not the standard-setter), then extended one product at a
time as new payload types (`goldmine.knowledge`, `persona.contract`, `cmm.*`,
`clcs.*`) — same envelope, not new connector systems.
