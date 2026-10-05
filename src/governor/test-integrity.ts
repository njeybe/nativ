import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { RuleEvaluationResult } from './types.js';
import {
  CircuitBreaker,
  type ProofCheck,
  type TestRestorationProposal,
} from './circuit-breaker.js';

export type TestIntegrityRule =
  | 'TEST_SUITE_DELETED'
  | 'TEST_ASSERTIONS_REMOVED'
  | 'TEST_CASES_REMOVED'
  | 'TESTS_SKIPPED'
  | 'TESTS_FOCUSED'
  | 'TEST_SCRIPT_WEAKENED';

export interface TestIntegrityFinding {
  rule: TestIntegrityRule;
  /** Path relative to the project root. */
  path: string;
  detail: string;
}

export interface TestIntegrityReport extends RuleEvaluationResult {
  /** Resolved commit the working tree was compared against; null when the check was skipped. */
  baselineRef: string | null;
  /** True when the baseline came from `nativ task start` rather than falling back to HEAD. */
  baselineRecorded: boolean;
  findings: TestIntegrityFinding[];
  skippedReason?: string;
}

export interface TestSuiteMetrics {
  assertions: number;
  testCases: number;
  skipped: number;
  focused: number;
}

const TEST_CODE_EXTENSION = /\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|cs|php)$/i;

export function isTestFile(file: string): boolean {
  const p = file.replace(/\\/g, '/');
  if (!TEST_CODE_EXTENSION.test(p) || /(^|\/)node_modules\//.test(p)) return false;
  return (
    /(^|\/)(?:__tests__|tests?|specs?)\//i.test(p) ||
    /[._-](?:test|spec)\.[a-z]+$/i.test(p) ||
    /(^|\/)test[_-][^/]+$/i.test(p)
  );
}

/** Heuristic, language-agnostic counts; only deltas against the baseline matter. */
export function measureTestSuite(source: string): TestSuiteMetrics {
  const count = (re: RegExp) => (source.match(re) || []).length;
  return {
    assertions:
      count(/(?<![.\w])(?:assert(?:\.[A-Za-z]+)*|expect|self\.assert[A-Za-z]*|t\.(?:is|ok|not|truthy|falsy|equal|deepEqual|true|false|throws|throwsAsync|notThrows|regex|snapshot|like))\s*\(/g) +
      count(/^\s*assert\s+(?!\()/gm),
    testCases:
      count(/(?<![.\w])(?:it|test|describe|suite|context)(?:\.(?:each|concurrent|serial))?\s*\(/g) +
      count(/^\s*(?:async\s+)?def\s+test_/gm) +
      count(/^func\s+Test[A-Z_]/gm),
    skipped: count(
      /(?<![.\w])(?:it|test|describe|suite|context)\.(?:skip|todo)\s*\(|(?<![.\w])x(?:it|test|describe)\s*\(|@pytest\.mark\.skip|\bt\.Skip(?:Now|f)?\(/g,
    ),
    focused: count(/(?<![.\w])(?:it|test|describe|suite|context)\.only\s*\(|(?<![.\w])f(?:it|describe)\s*\(/g),
  };
}

function git(targetDir: string, args: string[]): { ok: boolean; stdout: string } {
  const res = spawnSync('git', args, {
    cwd: targetDir,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: res.status === 0, stdout: res.stdout ?? '' };
}

/** Current commit of the checkout at `targetDir`, or null outside git / before the first commit. */
export function resolveGitHead(targetDir: string): string | null {
  const res = git(targetDir, ['rev-parse', '--verify', 'HEAD']);
  return res.ok ? res.stdout.trim() || null : null;
}

/** Test files and test-named scripts referenced by `package.json` test scripts. */
function testScriptReferences(packageJson: string): { scripts: Set<string>; files: Set<string> } {
  const scripts = new Set<string>();
  const files = new Set<string>();
  try {
    const pkg = JSON.parse(packageJson);
    for (const [name, command] of Object.entries<string>(pkg?.scripts ?? {})) {
      if (!/^(?:pre|post)?test(?:[:_-]|$)/.test(name) || typeof command !== 'string') continue;
      scripts.add(name);
      for (const token of command.split(/[\s;&|'"]+/)) {
        if (token && isTestFile(token)) files.add(token.replace(/\\/g, '/').replace(/^\.\//, ''));
      }
    }
  } catch {
    // Unparseable package.json: nothing to compare.
  }
  return { scripts, files };
}

function quoteArg(value: string): string {
  return /^[\w./@:-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Enforces that a task never deletes or weakens the test suites that existed
 * when it started: no deleted test files, no fewer assertions or cases, no new
 * skip/only markers, and no test files dropped from package.json test scripts.
 */
export class TestIntegrityGuard {
  static evaluate(targetDir: string, taskId: string): TestIntegrityReport {
    const pass = (skippedReason?: string, baselineRef: string | null = null, baselineRecorded = false): TestIntegrityReport => ({
      approved: true,
      blastRadius: 'LOW_ADDITIVE',
      ruleId: skippedReason ? 'TEST_INTEGRITY_SKIPPED' : 'TEST_INTEGRITY_OK',
      message: skippedReason ?? 'Existing test suites are intact.',
      violations: [],
      baselineRef,
      baselineRecorded,
      findings: [],
      ...(skippedReason ? { skippedReason } : {}),
    });

    if (!git(targetDir, ['rev-parse', '--is-inside-work-tree']).ok) return pass('Not a git repository; test integrity cannot be checked.');

    const recorded = CircuitBreaker.getBaseline(targetDir, taskId);
    const recordedValid = recorded ? git(targetDir, ['cat-file', '-e', `${recorded}^{commit}`]).ok : false;
    const baseline = recordedValid ? recorded! : resolveGitHead(targetDir);
    if (!baseline) return pass('Repository has no commits yet; nothing to protect.');

    const diff = git(targetDir, ['diff', '--name-status', '-M', '--relative', baseline, '--']);
    if (!diff.ok) return pass(`Could not diff against ${baseline}.`, baseline, recordedValid);

    const findings: TestIntegrityFinding[] = [];
    const baselineSource = (file: string) => {
      const res = git(targetDir, ['show', `${baseline}:./${file}`]);
      return res.ok ? res.stdout : null;
    };

    for (const line of diff.stdout.split('\n')) {
      const [status, ...paths] = line.trim().split('\t');
      if (!status || !paths.length) continue;
      const kind = status[0];
      const from = paths[0];
      const to = paths[paths.length - 1];

      if (kind === 'D' && isTestFile(from)) {
        findings.push({ rule: 'TEST_SUITE_DELETED', path: from, detail: `Test file '${from}' was deleted.` });
        continue;
      }
      if (kind === 'R' && isTestFile(from) && !isTestFile(to)) {
        findings.push({ rule: 'TEST_SUITE_DELETED', path: from, detail: `Test file '${from}' was moved out of the suite to '${to}'.` });
        continue;
      }

      if ((kind === 'M' || kind === 'R') && isTestFile(to)) {
        const before = baselineSource(from);
        let after: string | null = null;
        try {
          after = fs.readFileSync(path.join(targetDir, to), 'utf8');
        } catch {
          // Unreadable now: treat like a deletion.
        }
        if (before === null) continue;
        if (after === null) {
          findings.push({ rule: 'TEST_SUITE_DELETED', path: to, detail: `Test file '${to}' can no longer be read.` });
          continue;
        }
        const was = measureTestSuite(before);
        const now = measureTestSuite(after);
        if (now.assertions < was.assertions) {
          findings.push({ rule: 'TEST_ASSERTIONS_REMOVED', path: to, detail: `'${to}' went from ${was.assertions} to ${now.assertions} assertions.` });
        }
        if (now.testCases < was.testCases) {
          findings.push({ rule: 'TEST_CASES_REMOVED', path: to, detail: `'${to}' went from ${was.testCases} to ${now.testCases} test cases.` });
        }
        if (now.skipped > was.skipped) {
          findings.push({ rule: 'TESTS_SKIPPED', path: to, detail: `'${to}' added ${now.skipped - was.skipped} skip/todo marker(s).` });
        }
        if (now.focused > was.focused) {
          findings.push({ rule: 'TESTS_FOCUSED', path: to, detail: `'${to}' added ${now.focused - was.focused} .only marker(s), silencing the rest of the suite.` });
        }
      }

      if (kind === 'M' && to === 'package.json') {
        const before = baselineSource('package.json');
        let after = '';
        try {
          after = fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8');
        } catch {
          // Treated as an empty package.json below.
        }
        if (before !== null) {
          const was = testScriptReferences(before);
          const now = testScriptReferences(after);
          const droppedScripts = [...was.scripts].filter((s) => !now.scripts.has(s));
          const droppedFiles = [...was.files].filter((f) => !now.files.has(f));
          if (droppedScripts.length || droppedFiles.length) {
            findings.push({
              rule: 'TEST_SCRIPT_WEAKENED',
              path: 'package.json',
              detail: `package.json test scripts dropped ${[...droppedScripts.map((s) => `script '${s}'`), ...droppedFiles].join(', ')}.`,
            });
          }
        }
      }
    }

    if (!findings.length) return pass(undefined, baseline, recordedValid);
    return {
      approved: false,
      blastRadius: 'HIGH_DESTRUCTIVE',
      ruleId: 'TEST_INTEGRITY_VIOLATION',
      message: `Task changes would delete or weaken ${findings.length === 1 ? 'an existing test suite' : `existing test suites (${findings.length} findings)`}.`,
      violations: findings.map((f) => `${f.rule}: ${f.detail}`),
      baselineRef: baseline,
      baselineRecorded: recordedValid,
      findings,
    };
  }

  /**
   * Proposal to restore every flagged file from the baseline, with proof that
   * each baseline blob exists and what the restored suite measures.
   */
  static proposeRestoration(targetDir: string, report: TestIntegrityReport): TestRestorationProposal | null {
    if (report.approved || !report.baselineRef) return null;
    const started = Date.now();
    const files = [...new Set(report.findings.map((f) => f.path))];
    const baseline = report.baselineRef;

    const checks: ProofCheck[] = files.map((file) => {
      const blob = git(targetDir, ['show', `${baseline}:./${file}`]);
      if (!blob.ok) return { name: `baseline:${file}`, passed: false, detail: `No copy of '${file}' at ${baseline.slice(0, 12)}` };
      if (!isTestFile(file)) return { name: `baseline:${file}`, passed: true, detail: `Baseline copy available (${blob.stdout.length} bytes)` };
      const m = measureTestSuite(blob.stdout);
      return {
        name: `baseline:${file}`,
        passed: true,
        detail: `Restores ${m.assertions} assertions and ${m.testCases} test cases (${m.skipped} skipped, ${m.focused} focused)`,
      };
    });

    return {
      kind: 'restore_tests',
      proposalId: `heal-${crypto.randomUUID().slice(0, 8)}`,
      strategy: 'restore_test_suite',
      rationale: 'Restore the flagged test files from the task baseline, then make the implementation pass the original suite.',
      requiresHumanApproval: true,
      candidatesEvaluated: 1,
      verificationProof: {
        isolated: true,
        method: 'baseline_blob_check',
        passed: checks.length > 0 && checks.every((c) => c.passed),
        checks,
        verifiedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      },
      generatedAt: new Date().toISOString(),
      baselineRef: baseline,
      files,
      commands: [`git checkout ${baseline} -- ${files.map(quoteArg).join(' ')}`],
    };
  }
}
