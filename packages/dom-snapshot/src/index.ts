export { ActionError, type ElementAction, act } from "./act.ts";
export {
  type Candidate, DEFAULT_MARGIN, DEFAULT_THRESHOLD, type Fingerprint, type Resolution, type ResolveOptions,
  fingerprintOf, pageHasText, renderFingerprint, renderTemplate, resolve, score, similarity, templatize, words,
} from "./fingerprint.ts";
export { serializeSnapshot } from "./serialize.ts";
export { MASK, type NodeHandle, type PageSnapshot, type Rect, type Snapshot, type SnapshotElement, type SnapshotOptions, captureSnapshot } from "./snapshot.ts";
export { type SettleOptions, loadingRequests, settle } from "./stable.ts";
