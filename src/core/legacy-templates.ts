/**
 * nativ-cli · Fingerprints of directive and role-guide templates that shipped before files carried a
 * managed marker.
 *
 * `nativ update` refreshes a file nativ wrote earlier, and keeps one a person edited. Files written since the
 * marker was introduced say so themselves (see stampManaged in setup-assets.ts). Older copies carry no marker,
 * so they are recognised here instead: a file whose normalised content matches a template nativ once shipped is
 * untouched and safe to refresh; anything else was edited and is kept.
 *
 * GENERATED from the git history of templates/CLAUDE.md, templates/GEMINI.md and templates/dot-ai/subagents/*.md
 * (as of commit 327b146). Only add hashes for versions that shipped before markers. To regenerate, for each file:
 *
 *   git log --format=%H -- <template path>          # every commit that touched it
 *   git show <commit>:<template path>               # the content at that commit
 *
 * then hash each with `legacyTemplateHash` (sha256 of the normalised text, first 16 hex characters).
 */

import crypto from 'node:crypto';

/** Line endings, a BOM and trailing whitespace differ between checkouts and editors; none of them is an edit. */
export function normalizeForHash(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

export function legacyTemplateHash(text: string): string {
  return crypto.createHash('sha256').update(normalizeForHash(text)).digest('hex').slice(0, 16);
}

/** Keyed by `CLAUDE.md`, `GEMINI.md` or `subagents/<file>`. */
export const LEGACY_TEMPLATE_HASHES: Readonly<Record<string, readonly string[]>> = {
  'CLAUDE.md': [
    '1522ccdd0a545518',
    '33e4bd039c178fd5',
    '3691651e16065c8e',
    '8c7349cdb74b7eb5',
    'd0b1c84ead870190',
    'd2c4c15cd27f836c',
    'd367e97db352f3bc',
    'd793ae4f685adcd5',
    'f2e7281fde12a1c5',
  ],
  'GEMINI.md': [
    '1d4d3812e725ef39',
    '38740208b5ace52d',
    '58fab39c4a3b6d54',
    '7daa75506dfa59d3',
    'b2a909ab7c4247ad',
    'b6d6773bcd93e3f5',
    'be5a2bf2e06166d2',
  ],
  'subagents/backend.md': ['e94062c5444507ef'],
  'subagents/database.md': ['d63d9a68aa765738'],
  'subagents/db-migration.md': ['7d9f0e865cf0ea4d'],
  'subagents/devops-agent.md': ['54e72ef616a35eab'],
  'subagents/flutter-developer.md': ['0888a76b3409f903'],
  'subagents/frontend.md': ['01bd98d7028e18fd', 'de29dab2615b95d2'],
  'subagents/qa-tester.md': ['ceb00030e68c3369'],
  'subagents/security-auditor.md': ['1656948f6f454fcb'],
};

/** True when `content` is, apart from line endings and trailing whitespace, a template nativ shipped before markers. */
export function isLegacyTemplate(key: string, content: string): boolean {
  return (LEGACY_TEMPLATE_HASHES[key] ?? []).includes(legacyTemplateHash(content));
}
