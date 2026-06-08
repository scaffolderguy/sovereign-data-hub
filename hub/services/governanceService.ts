import { ContainerStore } from "../store";
import { ContainerManifest, GovernanceState } from "../../schemas/container";

/**
 * GovernanceService — the draft -> in_review -> approved state machine (spec §6).
 * Every transition is recorded in history with the acting actor. No meaningful
 * state change without a record.
 *
 * Requester vs reviewer are kept distinct:
 *   - requestReview sets `requested_by` (the person asking) — NOT a reviewer.
 *   - setState adds the deciding actor to `reviewers`.
 */

interface MethodologyCheck {
  id: string;
  passed: boolean;
  note?: string;
}

const TRANSITIONS: Record<GovernanceState, GovernanceState[]> = {
  draft: ["in_review"],
  in_review: ["approved", "rejected", "changes_requested"],
  changes_requested: ["in_review"],
  rejected: ["in_review"],
  approved: ["in_review"], // re-open for a new review cycle
};

export class GovernanceService {
  constructor(private readonly store: ContainerStore) {}

  async get(id: string) {
    return (await this.store.open(id)).governance;
  }

  /** Move to in_review and record who requested it. The requester is not a reviewer. */
  async requestReview(id: string, actor: string): Promise<ContainerManifest> {
    const m = await this.store.open(id);
    this.assertTransition(m.governance.state, "in_review");
    const now = new Date().toISOString();
    const updated: ContainerManifest = {
      ...m,
      updated_at: now,
      governance: {
        ...m.governance,
        state: "in_review",
        requested_by: actor,
        history: [
          ...m.governance.history,
          { actor, action: "review_requested", at: now, summary: "state -> in_review" },
        ],
      },
    };
    await this.store.writeManifest(id, updated);
    return updated;
  }

  /** A reviewer decides. The deciding actor is added to `reviewers`. */
  async setState(
    id: string,
    to: GovernanceState,
    actor: string,
    checks: MethodologyCheck[] = [],
  ): Promise<ContainerManifest> {
    const m = await this.store.open(id);
    this.assertTransition(m.governance.state, to);
    const now = new Date().toISOString();
    const updated: ContainerManifest = {
      ...m,
      updated_at: now,
      governance: {
        ...m.governance,
        state: to,
        methodology_checks: checks.length ? checks : m.governance.methodology_checks,
        reviewers:
          actor && !m.governance.reviewers.includes(actor)
            ? [...m.governance.reviewers, actor]
            : m.governance.reviewers,
        history: [...m.governance.history, { actor, action: `set_${to}`, at: now, summary: `state -> ${to}` }],
      },
    };
    await this.store.writeManifest(id, updated);
    return updated;
  }

  private assertTransition(from: GovernanceState, to: GovernanceState): void {
    if (from !== to && !(TRANSITIONS[from] ?? []).includes(to)) {
      throw new Error(`SDH governance: illegal transition ${from} -> ${to}`);
    }
  }
}
