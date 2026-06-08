import { z } from "zod";

/**
 * Sovereign Data Hub — work-container manifest schema (v0.1).
 *
 * This is the single shared validator (per spec §7). It fails loud on unknown
 * shapes or a foreign schema_version, and it enforces the two non-negotiables:
 *   - assets are POINTERS (no embedded media)
 *   - secrets are REFERENCES (keychain:/env:/file:), never inline values
 */

export const SCHEMA_VERSION = "0.1" as const;

export const AssetRef = z.object({
  id: z.string().min(1),
  // assets/x.png (local) | nas://… | s3://… | https://… — a pointer, never bytes.
  pointer: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  bytes: z.number().int().nonnegative().optional(),
});
export type AssetRef = z.infer<typeof AssetRef>;

export const SecretRef = z.object({
  id: z.string().min(1),
  // reference ONLY — keychain:/env:/file:. An inline secret value fails here.
  ref: z.string().regex(/^(keychain|env|file):/),
});

export const GovernanceState = z.enum([
  "draft",
  "in_review",
  "approved",
  "rejected",
  "changes_requested",
]);
export type GovernanceState = z.infer<typeof GovernanceState>;

export const HistoryEntry = z.object({
  actor: z.string().min(1), // user:rob | expert:jane | ai:reviewer | bts
  action: z.string().min(1), // created | committed | review_requested | approved | …
  at: z.string().min(1), // ISO 8601
  summary: z.string().optional(),
});

export const MethodologyCheck = z.object({
  id: z.string().min(1),
  passed: z.boolean(),
  note: z.string().optional(),
});

export const Governance = z.object({
  state: GovernanceState,
  requested_by: z.string().nullable().default(null), // who asked for review (not a reviewer)
  reviewers: z.array(z.string()).default([]), // actors who actually reviewed/decided
  methodology_checks: z.array(MethodologyCheck).default([]),
  history: z.array(HistoryEntry).default([]),
});

export const Owner = z.object({
  org_id: z.string().min(1),
  workspace_id: z.string().min(1),
});

export const ContainerManifest = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    container_id: z.string().regex(/^sdh_[a-z0-9]+$/),
    version_id: z.string().regex(/^v_\d+$/),
    parent_version_id: z.string().regex(/^v_\d+$/).nullable(),
    type: z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/), // <product>.<payload-kind>
    owner: Owner,
    product: z.object({ name: z.string().min(1), min_version: z.string().min(1) }),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    title: z.string(),
    payload: z.object({ entry: z.string().min(1) }),
    assets: z.array(AssetRef).default([]),
    secrets: z.array(SecretRef).default([]),
    governance: Governance,
  })
  .strict(); // reject unknown top-level keys — foreign manifests fail loud

export type ContainerManifest = z.infer<typeof ContainerManifest>;

/**
 * Validate a parsed manifest object. Throws with a clear message on a foreign
 * schema_version (before strict parsing) and on any shape violation.
 */
export function validateManifest(raw: unknown): ContainerManifest {
  if (raw && typeof raw === "object" && "schema_version" in raw) {
    const v = (raw as { schema_version?: unknown }).schema_version;
    if (v !== SCHEMA_VERSION) {
      throw new Error(
        `SDH: unsupported schema_version "${String(v)}" — this build speaks ${SCHEMA_VERSION}`,
      );
    }
  }
  return ContainerManifest.parse(raw);
}

/** Next version id in the v_000001 sequence. */
export function nextVersionId(current: string): string {
  const n = Number(current.replace(/^v_/, "")) + 1;
  return "v_" + String(n).padStart(6, "0");
}
