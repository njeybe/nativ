/**
 * nativ · Tier 1 AI Strategist Liaison (provider-agnostic, Claude by default)
 *
 * Autonomously mediates between Tier 2 (Claude Code PM) and Tier 1 (Strategy Engine / Human).
 * Inspects .ai/ specification contracts against runtime blockers and escalations,
 * classifies risk (AUTO_RESOLVE vs REQUIRE_HUMAN_DECISION), and generates either
 * verified specification patches or zero-jargon 4-part human decision cards.
 *
 * The model call goes through the provider chain in src/providers/ (Claude login, Claude API key,
 * Gemini). When no provider is reachable, or every one fails, evaluation ends at the deterministic
 * rules engine, so a rate limit or outage never blocks the pipeline.
 */

import fs from 'node:fs';
import path from 'node:path';
import { MASK } from '../db/env-parser.js';
import { escalationPath, loadEscalationFile } from '../governor/store.js';
import { applySelfHealingProposal } from '../governor/index.js';
import { notifyHuman } from './notify.js';
import { mutateJsonFileSync } from './lock-manager.js';
import type { CandidatePatch, SelfHealingEscalationRecord, SelfHealingProposal } from '../governor/circuit-breaker.js';
import {
  CLAUDE_CLI_DEFAULT_MODEL,
  completeWithChain,
  resolveAnthropicApiKey,
  resolveGeminiApiKey as resolveGeminiKey,
  resolveProviderChain,
  type ProviderConfig,
  type ProviderDeps,
  type ProviderId,
} from '../providers/index.js';

export type RiskThreshold = 'safe_contracts_only' | 'all_non_destructive';
export type TriageClassification = 'AUTO_RESOLVE' | 'REQUIRE_HUMAN_DECISION';
export type TriageSource = 'claude' | 'gemini' | 'sandbox' | 'deterministic';

export interface TriageOption {
  id: string;
  label: string;
  outcome: string;
  description?: string;
  recommended?: boolean;
}

export interface HumanDecisionCard {
  symptom: string;
  rootCause: string;
  blastRadius: string;
  options: TriageOption[];
}

export interface TriageResolution {
  summary: string;
  patch: CandidatePatch;
  proof: { passed: boolean };
  proposalId?: string;
}

export interface TriageEvaluation {
  ok: true;
  escalationId: string;
  taskId: string;
  /** Provider that answered (`claude-cli`, `claude-api`, `gemini`), or `deterministic` when none did. */
  provider: string;
  model: string;
  source: TriageSource;
  latencyMs: number;
  classification: TriageClassification;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  reasoning: string;
  autoPatchApplied: boolean;
  guardrails: string[];
  unblockedTaskId: string | null;
  resolution?: TriageResolution;
  humanCard?: HumanDecisionCard;
}

export interface TriageFailure {
  ok: false;
  escalationId: string;
  error: string;
  code?: string;
}

export interface TriageConfig {
  autoTriageEnabled: boolean;
  riskThreshold: RiskThreshold;
  model: string;
}

export interface Tier1LiaisonOptions {
  /** Pins the model. A `gemini-*` model restricts the chain to Gemini; a Claude model or alias excludes it. */
  model?: string;
  /** Legacy Gemini key override: implies the Gemini provider unless `provider` says otherwise. */
  apiKey?: string;
  /** Provider id(s) to use instead of the configured chain. */
  provider?: ProviderId | ProviderId[];
  /** Inline provider config instead of `.nativ/config.json`. */
  providerConfig?: ProviderConfig;
  /** Injectable spawn, fetch, SDK client and clock for tests. */
  deps?: ProviderDeps;
  config?: {
    autoTriageEnabled?: boolean;
    riskThreshold?: RiskThreshold;
  };
  mockEvaluation?: TriageEvaluation;
}

export interface TriageStatusResponse {
  ok: true;
  /** Provider a call would use right now, or `deterministic` when none is available. */
  provider: string;
  model: string;
  autoTriageEnabled: boolean;
  hasApiKey: boolean;
  stats: {
    totalEvaluated: number;
    autoResolved: number;
    escalatedToHuman: number;
  };
}

/** Triage runs often and in the background, so it defaults to the cheapest Claude tier. */
export const DEFAULT_MODEL = CLAUDE_CLI_DEFAULT_MODEL;

/** A stalled provider aborts here and the chain moves on, so triage never hangs on one vendor. */
const TRIAGE_TIMEOUT_MS = 20_000;

const TRIAGE_SYSTEM =
  'You are Tier 1 Macro-Architect in a 3-Tier Multi-Agent Software Development Pipeline. Respond with strictly valid JSON only.';

/**
 * Resolves the Google/Gemini API key from .env files or process.env.
 * Zero-credential air-gap: the returned key is never stored in contracts or responses.
 */
export function resolveGeminiApiKey(root: string = process.cwd()): string | null {
  return resolveGeminiKey(root);
}

export function hasGeminiApiKey(root: string = process.cwd()): boolean {
  return resolveGeminiApiKey(root) !== null;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  // Connection strings: scheme://user:password@host keeps everything but the password.
  // The user may be empty (redis://:password@host) and raw passwords may contain '/'.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"']*:)[^\s@"']+@/gi, `$1${MASK}@`],
  // key=value / "key": "value" credentials, including prefixed and suffixed names such as DB_PASSWORD,
  // dbPassword or SECRET_KEY; contract field declarations such as "token": "string" stay readable.
  [/\b(\w*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\w*["']?\s*[:=]\s*["']?)(?!(?:string|number|boolean|integer|object|array|null|true|false)\b)[^\s"'&,;]+/gi, `$1${MASK}`],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, `$1${MASK}`],
  // JSON Web Tokens: header.payload.signature, each part base64url.
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, MASK],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
];

/**
 * Masks connection-string passwords, credential assignments and well-known key formats before
 * text leaves the machine. `extraSecrets` (e.g. the Gemini key itself) are masked verbatim.
 */
export function redactSecrets(text: string, extraSecrets: string[] = []): string {
  let out = text;
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join(MASK);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

interface ContractSet {
  context?: string;
  masterPlan?: Record<string, unknown>;
  dbSchema?: Record<string, unknown>;
  apiContracts?: Record<string, unknown>;
  uiSpecs?: string;
}

function loadContracts(root: string): ContractSet {
  const read = (name: string): string | null => {
    const p = path.join(root, '.ai', name);
    try {
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    } catch {
      return null;
    }
  };

  const readJson = (name: string): Record<string, unknown> | undefined => {
    const raw = read(name);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };

  return {
    context: read('context.md') ?? undefined,
    masterPlan: readJson('master_plan.json'),
    dbSchema: readJson('db_schema.json'),
    apiContracts: readJson('api_contracts.json'),
    uiSpecs: read('ui_specs.md') ?? undefined,
  };
}

interface NativConfigFile {
  triage?: {
    autoTriageEnabled?: boolean;
    riskThreshold?: RiskThreshold;
    model?: string;
  };
  [key: string]: unknown;
}

export function loadTriageConfig(root: string): Partial<TriageConfig> {
  const configFile = path.join(root, '.nativ', 'config.json');
  try {
    if (!fs.existsSync(configFile)) return {};
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8')) as NativConfigFile;
    if (parsed && typeof parsed === 'object' && parsed.triage) {
      const res: Partial<TriageConfig> = {};
      if (typeof parsed.triage.autoTriageEnabled === 'boolean') {
        res.autoTriageEnabled = parsed.triage.autoTriageEnabled;
      }
      if (parsed.triage.riskThreshold === 'safe_contracts_only' || parsed.triage.riskThreshold === 'all_non_destructive') {
        res.riskThreshold = parsed.triage.riskThreshold;
      }
      if (typeof parsed.triage.model === 'string' && parsed.triage.model.trim()) {
        res.model = parsed.triage.model.trim();
      }
      return res;
    }
  } catch {
    // Ignore corrupt or unreadable config file
  }
  return {};
}

/** Merges triage settings into `.nativ/config.json` under its lock. Throws when the file cannot be written. */
export function saveTriageConfig(root: string, update: Partial<TriageConfig>): void {
  mutateJsonFileSync(path.join(root, '.nativ', 'config.json'), (config) => {
    const triage = config.triage && typeof config.triage === 'object' ? (config.triage as Record<string, unknown>) : {};
    if (typeof update.autoTriageEnabled === 'boolean') triage.autoTriageEnabled = update.autoTriageEnabled;
    if (update.riskThreshold) triage.riskThreshold = update.riskThreshold;
    if (update.model) triage.model = update.model;
    config.triage = triage;
  });
}

/**
 * Tier 1 AI Strategist Liaison instance managing escalation evaluation,
 * auto-patch application, and configuration.
 */
export class Tier1Liaison {
  private config: TriageConfig;
  private stats = {
    totalEvaluated: 0,
    autoResolved: 0,
    escalatedToHuman: 0,
  };

  constructor(
    private readonly root: string,
    private readonly options: Tier1LiaisonOptions = {},
  ) {
    const saved = loadTriageConfig(root);
    this.config = {
      // Off by default: even a fix classified as safe waits for confirmation unless auto-triage is enabled.
      autoTriageEnabled: options.config?.autoTriageEnabled ?? saved.autoTriageEnabled ?? false,
      riskThreshold: options.config?.riskThreshold ?? saved.riskThreshold ?? 'safe_contracts_only',
      model: options.model ?? saved.model ?? DEFAULT_MODEL,
    };
  }

  /** Provider options after the legacy `apiKey` and `model` hints are folded in. */
  private providerOptions() {
    const { apiKey, model } = this.options;
    let provider = this.options.provider;
    if (!provider && model) {
      if (/^gemini/i.test(model)) provider = 'gemini';
      else if (/^(claude|haiku|sonnet|opus)/i.test(model)) provider = ['claude-cli', 'claude-api'];
    }
    if (!provider && apiKey) provider = 'gemini';

    const deps: ProviderDeps | undefined = apiKey
      ? { ...this.options.deps, env: { ...(this.options.deps?.env ?? process.env), GEMINI_API_KEY: apiKey } }
      : this.options.deps;
    return { provider, deps, config: this.options.providerConfig };
  }

  /** Providers that could answer right now, in order. Empty means the deterministic engine handles it. */
  private activeChain() {
    return resolveProviderChain('triage', this.root, this.providerOptions());
  }

  hasApiKey(): boolean {
    return this.activeChain().length > 0;
  }

  getStatus(): TriageStatusResponse {
    const active = this.activeChain()[0];
    return {
      ok: true,
      provider: active?.id ?? 'deterministic',
      model: this.options.model ?? active?.defaultModel ?? this.config.model,
      autoTriageEnabled: this.config.autoTriageEnabled,
      hasApiKey: active !== undefined,
      stats: { ...this.stats },
    };
  }

  updateConfig(body: Record<string, unknown>): { ok: true; config: TriageConfig } | { ok: false; error: string } {
    if (typeof body.autoTriageEnabled === 'boolean') {
      this.config.autoTriageEnabled = body.autoTriageEnabled;
    }
    if (body.riskThreshold === 'safe_contracts_only' || body.riskThreshold === 'all_non_destructive') {
      this.config.riskThreshold = body.riskThreshold;
    }
    if (typeof body.model === 'string' && body.model.trim()) {
      this.config.model = body.model.trim();
    }
    try {
      saveTriageConfig(this.root, this.config);
    } catch (err) {
      return { ok: false, error: `Could not save .nativ/config.json: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, config: { ...this.config } };
  }

  async evaluate(escalationId: string): Promise<TriageEvaluation | TriageFailure> {
    const startTime = Date.now();
    const escalationFile = escalationPath(this.root);
    if (!fs.existsSync(escalationFile)) {
      return { ok: false, escalationId, error: 'ESCALATION_FILE_NOT_FOUND' };
    }

    let record: SelfHealingEscalationRecord | null = null;
    try {
      const data = loadEscalationFile(this.root, path.basename(this.root));
      record = data.escalations.find((e) => e?.id === escalationId) ?? null;
    } catch (err) {
      return { ok: false, escalationId, error: `Could not read escalation file: ${String(err)}` };
    }

    if (!record) {
      return { ok: false, escalationId, error: `Escalation "${escalationId}" was not found.` };
    }

    const taskId = record.taskId || 'unknown';
    const details = `${record.summary || ''} ${record.details || ''}`;
    const isDestructive = /drop\s+table|drop\s+column|delete|truncate|destructive/i.test(details);
    const isDrift = /schema\s+drift|contract\s+mismatch|unknown\s+property|api\s+contracts|syntax/i.test(details);

    let classification: TriageClassification = isDestructive ? 'REQUIRE_HUMAN_DECISION' : 'AUTO_RESOLVE';
    let riskLevel: 'low' | 'medium' | 'high' | 'critical' = isDestructive ? 'high' : isDrift ? 'low' : 'medium';
    let reasoning = isDestructive
      ? 'Destructive operation detected. Paused for human authorization under zero-data-loss guardrails.'
      : 'Contract alignment evaluated. Safe additive resolution approved.';
    let humanCard: HumanDecisionCard | undefined;
    let source: TriageSource = 'deterministic';
    let provider = 'deterministic';
    let model = this.options.model ?? this.config.model;

    // 1. If any provider is reachable, ask it for a contextual evaluation; otherwise keep the deterministic verdict.
    const providerOptions = this.providerOptions();
    if (resolveProviderChain('triage', this.root, providerOptions).length > 0) {
      try {
        const contracts = loadContracts(this.root);
        // Everything below leaves the machine: mask credentials (and every provider key) first.
        const env = providerOptions.deps?.env ?? process.env;
        const secrets = [resolveGeminiKey(this.root, env), resolveAnthropicApiKey(this.root, env)].filter((k): k is string => k !== null);
        const masked = (value: unknown) => redactSecrets(JSON.stringify(value, null, 2), secrets);
        const prompt = `An autonomous agent escalated an issue:
${masked(record)}

SPECIFICATION CONTRACTS:
- API Contracts: ${masked(contracts.apiContracts || {})}
- Database Schema: ${masked(contracts.dbSchema || {})}

Respond with strictly valid JSON:
{
  "classification": "AUTO_RESOLVE" | "REQUIRE_HUMAN_DECISION",
  "riskLevel": "low" | "medium" | "high" | "critical",
  "reasoning": "...",
  "humanCard": {
    "symptom": "Plain English user experience symptom",
    "rootCause": "Plain English root cause",
    "blastRadius": "What is affected vs safe",
    "options": [
      { "id": "opt-a", "label": "Option A (Recommended)", "outcome": "...", "recommended": true },
      { "id": "opt-b", "label": "Option B", "outcome": "...", "recommended": false }
    ]
  }
}`;

        // Providers are tried in order; a rate limit puts one on cooldown and the next takes over.
        const answer = await completeWithChain(
          'triage',
          this.root,
          { system: TRIAGE_SYSTEM, prompt, json: true, timeoutMs: TRIAGE_TIMEOUT_MS, model: this.options.model },
          providerOptions,
        );
        const parsed = JSON.parse(answer.text) as {
          classification?: TriageClassification;
          riskLevel?: 'low' | 'medium' | 'high' | 'critical';
          reasoning?: string;
          humanCard?: HumanDecisionCard;
        };
        if (parsed.classification) classification = parsed.classification;
        if (parsed.riskLevel) riskLevel = parsed.riskLevel;
        if (parsed.reasoning) reasoning = parsed.reasoning;
        if (parsed.humanCard) humanCard = parsed.humanCard;
        provider = answer.provider;
        model = answer.model;
        source = answer.provider === 'gemini' ? 'gemini' : 'claude';
      } catch {
        // Every provider failed or the reply was not JSON: keep the deterministic evaluation
      }
    }

    if (classification === 'REQUIRE_HUMAN_DECISION' && !humanCard) {
      humanCard = {
        symptom: isDestructive
          ? 'An automated database migration paused to prevent removing active customer data.'
          : 'The autonomous runner encountered an architectural divergence and paused for decision.',
        rootCause: isDestructive
          ? 'The requested operation drops an existing table or column that may contain active user records.'
          : 'A contract specification requires human clarification before the builder can proceed safely.',
        blastRadius: 'All existing data and previously completed milestones remain completely intact.',
        options: [
          {
            id: 'opt-safe',
            label: 'Option A (Recommended): Safe Archive Column',
            outcome: 'Rename the affected entity instead of permanently dropping it, keeping all user data safe.',
            recommended: true,
          },
          {
            id: 'opt-drop',
            label: 'Option B: Confirm Permanent Drop',
            outcome: 'Verify that this legacy entity is obsolete and proceed with the deletion.',
            recommended: false,
          },
        ],
      };
    }

    // Check if there is an isolated sandbox proposal available
    let resolution: TriageResolution | undefined;
    let autoPatchApplied = false;
    let unblockedTaskId: string | null = null;

    if (record.proposedPatch) {
      const patch = record.proposedPatch.kind === 'contract_patch' ? record.proposedPatch.candidate : (record.proposedPatch as unknown as CandidatePatch);
      resolution = {
        summary: record.proposedPatch.strategy || 'Self-healing proposal',
        patch,
        proof: { passed: Boolean(record.proposedPatch.verificationProof?.passed) },
        proposalId: record.proposedPatch.proposalId,
      };

      // Auto-apply if autoTriageEnabled and classification is AUTO_RESOLVE
      if (this.config.autoTriageEnabled && classification === 'AUTO_RESOLVE') {
        const app = applySelfHealingProposal(this.root, taskId, record.proposedPatch);
        if (app.applied) {
          autoPatchApplied = true;
          unblockedTaskId = taskId;
        }
      }
    }

    this.stats.totalEvaluated++;
    if (autoPatchApplied) this.stats.autoResolved++;
    else if (classification === 'REQUIRE_HUMAN_DECISION') this.stats.escalatedToHuman++;

    if (classification === 'REQUIRE_HUMAN_DECISION' && !autoPatchApplied) {
      await notifyHuman(this.root, {
        event: 'human_decision',
        taskId,
        escalationId,
        summary: record.summary || 'A decision is needed',
        ...(humanCard ? { question: humanCard.symptom, options: humanCard.options.map((o) => o.label) } : {}),
      }).catch(() => {});
    }

    const latencyMs = Date.now() - startTime;

    return {
      ok: true,
      escalationId,
      taskId,
      provider,
      model,
      source,
      latencyMs,
      classification,
      riskLevel,
      reasoning,
      autoPatchApplied,
      guardrails: [
        'Zero-credential air-gap enforced',
        'Human confirmation required for destructive operations',
      ],
      unblockedTaskId,
      resolution,
      humanCard: classification === 'REQUIRE_HUMAN_DECISION' ? humanCard : undefined,
    };
  }
}

/**
 * Functional wrapper matching evaluateEscalation interface.
 */
export async function evaluateEscalation(
  root: string,
  escalationId: string,
  options: Tier1LiaisonOptions = {},
): Promise<TriageEvaluation | TriageFailure> {
  const liaison = new Tier1Liaison(root, options);
  return liaison.evaluate(escalationId);
}
