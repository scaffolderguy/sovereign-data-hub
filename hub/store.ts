import { randomUUID } from "node:crypto";
import { LocalFolderConnector } from "./connectors/localFolder";
import { validateManifest, ContainerManifest, SCHEMA_VERSION } from "../schemas/container";

/**
 * ContainerStore — ties the storage connector to manifest validation. Nothing
 * invalid is ever persisted. Products never see this; the hub server does.
 */

export interface Owner {
  org_id: string;
  workspace_id: string;
}

export interface ContainerRef {
  container_id: string;
  type: string;
  title: string;
  version_id: string;
  governance_state: string;
}

export class ContainerStore {
  constructor(private readonly connector: LocalFolderConnector) {}

  async list(type?: string): Promise<ContainerRef[]> {
    const ids = await this.connector.listContainers();
    const refs: ContainerRef[] = [];
    for (const id of ids) {
      try {
        const m = validateManifest(await this.connector.readManifest(id));
        if (!type || m.type === type) {
          refs.push({
            container_id: m.container_id,
            type: m.type,
            title: m.title,
            version_id: m.version_id,
            governance_state: m.governance.state,
          });
        }
      } catch {
        // Skip containers that fail validation rather than poison the list.
      }
    }
    return refs;
  }

  async open(id: string): Promise<ContainerManifest> {
    return validateManifest(await this.connector.readManifest(id));
  }

  async create(params: {
    type: string;
    title: string;
    owner: Owner;
    product: { name: string; min_version: string };
    actor: string;
  }): Promise<ContainerManifest> {
    const id = "sdh_" + randomUUID().replace(/-/g, "").slice(0, 8);
    const now = new Date().toISOString();
    const manifest: ContainerManifest = {
      schema_version: SCHEMA_VERSION,
      container_id: id,
      version_id: "v_000001",
      parent_version_id: null,
      type: params.type,
      owner: params.owner,
      product: params.product,
      created_at: now,
      updated_at: now,
      title: params.title,
      payload: { entry: "payload/index.json" },
      assets: [],
      secrets: [],
      governance: {
        state: "draft",
        requested_by: null,
        reviewers: [],
        methodology_checks: [],
        history: [{ actor: params.actor, action: "created", at: now, summary: "Initial container" }],
      },
    };
    await this.writeManifest(id, manifest);
    return manifest;
  }

  /** Persist a manifest — validated first, so an invalid one never lands. */
  async writeManifest(id: string, manifest: ContainerManifest): Promise<void> {
    validateManifest(manifest);
    await this.connector.writeManifest(id, manifest);
  }

  readPayload(id: string, rel: string) { return this.connector.readPayload(id, rel); }
  writePayload(id: string, rel: string, bytes: Buffer) { return this.connector.writePayload(id, rel, bytes); }
  readAsset(id: string, pointer: string) { return this.connector.readAsset(id, pointer); }
  writeAsset(id: string, pointer: string, bytes: Buffer) { return this.connector.writeAsset(id, pointer, bytes); }
  listAssets(id: string) { return this.connector.listAssets(id); }
}
