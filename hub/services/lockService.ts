import { randomUUID } from "node:crypto";

/**
 * In-process advisory locks (leases) — spec §3. v0.1 is single-hub-process, so
 * an in-memory map is enough. Writes require a held, unexpired lock; this is the
 * "don't corrupt the pack" guard, not real-time collaboration.
 */

interface Lease {
  lockId: string;
  actor: string;
  expiresAt: number;
}

export class LockService {
  private leases = new Map<string, Lease>(); // containerId -> lease

  acquire(containerId: string, actor: string, ttlMs = 60_000):
    | { ok: true; lockId: string; expiresAt: number }
    | { ok: false; heldBy: string } {
    const now = Date.now();
    const existing = this.leases.get(containerId);
    if (existing && existing.expiresAt > now) {
      return { ok: false, heldBy: existing.actor };
    }
    const lockId = "lk_" + randomUUID().replace(/-/g, "").slice(0, 8);
    const expiresAt = now + ttlMs;
    this.leases.set(containerId, { lockId, actor, expiresAt });
    return { ok: true, lockId, expiresAt };
  }

  release(containerId: string, lockId: string): boolean {
    const l = this.leases.get(containerId);
    if (l && l.lockId === lockId) {
      this.leases.delete(containerId);
      return true;
    }
    return false;
  }

  /** True if the caller holds the current, unexpired lock for this container. */
  held(containerId: string, lockId: string | undefined): boolean {
    if (!lockId) return false;
    const l = this.leases.get(containerId);
    return !!l && l.lockId === lockId && l.expiresAt > Date.now();
  }
}
