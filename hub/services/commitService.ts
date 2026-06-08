import { ContainerStore } from "../store";
import { ContainerManifest, nextVersionId } from "../../schemas/container";

/**
 * CommitService — advances version_id, sets parent_version_id, appends a history
 * record. The audit checkpoint (spec §3). Atomic at the manifest level via the
 * connector's temp+rename write.
 */
export class CommitService {
  constructor(private readonly store: ContainerStore) {}

  async commit(id: string, actor: string, summary: string): Promise<{ version_id: string; parent_version_id: string }> {
    const m = await this.store.open(id);
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
