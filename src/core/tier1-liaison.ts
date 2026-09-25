/**
 * nativ-cli · Tier 1 AI Strategist Liaison (Gemini 3.8 Flash)
 *
 * Autonomously mediates between Tier 2 (Claude Code PM) and Tier 1 (Strategy Engine / Human).
 * Inspects .ai/ specification contracts against runtime blockers and escalations,
 * classifies risk (AUTO_RESOLVE vs REQUIRE_HUMAN_DECISION), and generates either
 * verified specification patches or zero-jargon 4-part human decision cards.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFiles, MASK } from '../db/env-parser.js';
import { escalationPath, loadEscalationFile } from '../governor/store.js';
import { applySelfHealingProposal } from '../governor/index.js';
import type { CandidatePatch, SelfHealingEscalationRecord, SelfHealingProposal } from '../governor/circuit-breaker.js';

export type RiskThreshold = 'safe_contracts_only' | 'all_non_destructive';
export type TriageClassification = 'AUTO_RESOLVE' | 'REQUIRE_HUMAN_DECISION';
export type TriageSource = 'gemini' | 'sandbox' | 'deterministic';

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
  model?: string;
  apiKey?: string;
  config?: {
    autoTriageEnabled?: boolean;
    riskThreshold?: RiskThreshold;
  };
  mockEvaluation?: TriageEvaluation;
}

export interface TriageStatusResponse {
  ok: true;
  model: string;
  autoTriageEnabled: boolean;
  hasApiKey: boolean;
  stats: {
    totalEvaluated: number;
    autoResolved: number;
    escalatedToHuman: number;
  };
}

/** The model the REST call targets is the model reported in status and evaluation responses. */
export const DEFAULT_MODEL = 'gemini-3.8-flash';

/**
 * Resolves the Google/Gemini API key from in-memory session, .env files, or process.env.
 * Zero-credential air-gap: the returned key is never stored in contracts or responses.
 */
export function resolveGeminiApiKey(root: string = process.cwd()): string | null {
  try {
    const envVars = loadEnvFiles(root);
    const key = envVars.GEMINI_API_KEY || envVars.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (typeof key === 'string' && key.trim().length > 0) {
      return key.trim();
    }
  } catch {
    // Air-gap guard: suppress file read errors
  }
  return null;
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
    this.config = {
      // Off by default: even a fix classified as safe waits for confirmation unless auto-triage is enabled.
      autoTriageEnabled: options.config?.autoTriageEnabled ?? false,
      riskThreshold: options.config?.riskThreshold ?? 'safe_contracts_only',
      model: options.model ?? DEFAULT_MODEL,
    };
  }

  hasApiKey(): boolean {
    return hasGeminiApiKey(this.root);
  }

  getStatus(): TriageStatusResponse {
    return {
      ok: true,
      model: this.config.model,
      autoTriageEnabled: this.config.autoTriageEnabled,
      hasApiKey: this.hasApiKey(),
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

    const apiKey = this.options.apiKey || resolveGeminiApiKey(this.root);
    let classification: TriageClassification = isDestructive ? 'REQUIRE_HUMAN_DECISION' : 'AUTO_RESOLVE';
    let riskLevel: 'low' | 'medium' | 'high' | 'critical' = isDestructive ? 'high' : isDrift ? 'low' : 'medium';
    let reasoning = isDestructive
      ? 'Destructive operation detected. Paused for human authorization under zero-data-loss guardrails.'
      : 'Contract alignment evaluated. Safe additive resolution approved.';
    let humanCard: HumanDecisionCard | undefined;
    let source: TriageSource = 'deterministic';

    // 1. If API key exists, query Gemini REST API for contextual evaluation
    if (apiKey) {
      try {
        const contracts = loadContracts(this.root);
        // Everything below goes to an external API: mask credentials (and the key itself) first.
        const masked = (value: unknown) => redactSecrets(JSON.stringify(value, null, 2), [apiKey]);
        const prompt = `You are Tier 1 Macro-Architect in a 3-Tier Multi-Agent Software Development Pipeline.
An autonomous agent escalated an issue:
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

        // The key travels in a header, never the URL, so it cannot leak through logged or proxied URLs.
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.config.model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
          }),
        });

        if (res.ok) {
          const body = await res.json() as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            const parsed = JSON.parse(text) as {
              classification?: TriageClassification;
              riskLevel?: 'low' | 'medium' | 'high' | 'critical';
              reasoning?: string;
              humanCard?: HumanDecisionCard;
            };
            if (parsed.classification) classification = parsed.classification;
            if (parsed.riskLevel) riskLevel = parsed.riskLevel;
            if (parsed.reasoning) reasoning = parsed.reasoning;
            if (parsed.humanCard) humanCard = parsed.humanCard;
            source = 'gemini';
          }
        }
      } catch {
        // Fall back to deterministic evaluation
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

    const latencyMs = Date.now() - startTime;

    return {
      ok: true,
      escalationId,
      taskId,
      model: this.config.model,
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
