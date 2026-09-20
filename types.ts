// types.ts
// Public type surface. The definitions live in engine/types.ts.

export type {
  Bucket,
  Decision,
  DecideEngine,
  DecideInput,
  Element,
  ElementMatchHints,
  ExploreConfig,
  ExploreResult,
  FactKey,
  Facts,
  Finding,
  Flag,
  HistoryEntry,
  Journey,
  JourneySummary,
  Landmark,
  LangSwitcherTarget,
  MetricsReport,
  Option,
  OptionId,
  OptionKind,
  Outcome,
  PageMeta,
  PageState,
  PerUrlRow,
  PersonaProfile,
  RawDecision,
  ReadingLevel,
  RunIssue,
  SelectOption,
  StepTiming,
  TraceRow,
} from './engine/types';

export { ALL_BUCKETS, ALL_FLAGS, FACT_KEYS, isBucket, isFlag } from './engine/types';

// Defined by the public entry point, re-exported here so `ux-explore/types` is the one
// place a consumer needs. `export type` is erased, so this pulls in no runtime code.
export type { ExploreDeps, ExploreOptions } from './index';
