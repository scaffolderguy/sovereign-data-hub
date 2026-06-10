import { ContainerStore } from "../store";
import { ApiError } from "../errors";
import { ContainerManifest, nextVersionId } from "../../schemas/container";

/**
 * CommitService — advances version_id, sets parent_version_id, appends a history
 * record. The audit checkpoint (spec §3). Atomic at the manifest level via the
 * connector's temp+rename write.
 *
 * Locks are advisory and in-memory: a hub restart orphans every lease, so a
 * writer can believe it still holds a container another writer has since
 * advanced. The optional `expectedVersion` is the real safety net (optimistic
 * concurrency): pass the version_id your work was based on, and a commit on
 * top of anything newer is REFUSED instead of silently overwriting it.
 */
export class CommitService {
  constructor(private readonly store: ContainerStore) {}

  async commit(
    id: string,
    actor: string,
    summary: string,
    expectedVersion?: string,
  ): Promise<{ version_id: string; parent_version_id: string }> {
    const m = await this.store.open(id);
    if (expectedVersion && expectedVersion !== m.version_id) {
      throw new ApiError(
        409,
        `stale commit: the container is at ${m.version_id} but your work was based on ${expectedVersion}. Someone else committed in between — re-read the container and re-apply your changes.`,
      );
    }
    const now = new Date().toISOString();
    const version_id = nextVersionId(m.version_id);
    const updated: ContainerManifest = {
      ...m,
      parent_version_id: m.version_id,
      version_id,
      updated_at: now,
      governance: {
        ...m.governance,
        history: [...m.governance.history, { actor, action: "committed", at: now, summary }],
      },
    };
    await this.store.writeManifest(id, updated);
    return { version_id, parent_version_id: m.version_id };
  }
}
