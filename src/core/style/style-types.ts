/** nativ · Types for `.ai/code_style.json`, the learned code style of a project. */

export const STYLE_LANGUAGES = ['js', 'python'] as const;
export type StyleLanguage = (typeof STYLE_LANGUAGES)[number];

export const STYLE_RULES = [
  { id: 'raw-sql', title: 'Raw SQL outside the model layer' },
  { id: 'swallowed-errors', title: 'Errors hidden in defaults' },
  { id: 'config-fallback', title: 'Required settings with fallback values' },
] as const;
export type StyleRuleId = (typeof STYLE_RULES)[number]['id'];

export const DECISION_STATUSES = ['pending', 'nativ', 'codebase'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** Share of files that follow a trait value, 0 to 1 with two decimals. */
export interface TraitEntry {
  value: string;
  share: number;
  samples: number;
  /** Set when a formatter owns this trait; it is never checked or delivered. */
  owner?: string;
}

export type TraitMap = Record<string, TraitEntry>;

export interface StyleFormatter {
  tool: string;
  config: string;
  language: StyleLanguage;
  owns: string[];
}

export interface StyleDecision {
  rule: StyleRuleId;
  status: DecisionStatus;
  evidence: { count: number; files: string[] };
  decidedAt: string | null;
  /** The git user.name of the person who decided; absent when unknown. */
  decidedBy?: string;
}

export interface StylePattern {
  id: string;
  text: string;
  evidence: string[];
  /** Empty means project-wide. */
  scope: string[];
}

export interface ScannedAt {
  commit: string;
  date: string;
  files: number;
}

export interface CodeStyleFile {
  version: 1;
  scannedAt: ScannedAt;
  languages: StyleLanguage[];
  formatters: StyleFormatter[];
  project: Partial<Record<StyleLanguage, TraitMap>>;
  folders: Record<string, Partial<Record<StyleLanguage, TraitMap>>>;
  decisions: StyleDecision[];
  patterns: StylePattern[];
}

export interface LoadedCodeStyle {
  file: CodeStyleFile | null;
  unreadable: boolean;
  problems: string[];
}

export interface Staleness {
  behind: number;
  gone: boolean;
  stale: boolean;
}

/** Commits behind HEAD after which a scan counts as stale. */
export const STALE_COMMITS = 50;
export const MAX_PATTERN_TEXT = 200;
