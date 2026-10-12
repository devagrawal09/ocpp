// Test entry for a host (OC++ core) that runs Specter's contracts on its own database: Specter's conformance
// programs, which hold an implementation to the contract it declares.
export { eventLogConformance, sliceSnapshotStoreConformance } from "@specter-ts/core/testing"
export {
  type ReactionOutboxConformancePayload,
  reactionOutboxStoreConformance,
} from "@specter-ts/reaction-outbox/testing"
