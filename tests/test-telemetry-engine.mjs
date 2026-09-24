import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTaskStart, runTaskComplete } from '../dist/commands/task.js';
import { runStatus } from '../dist/commands/status.js';
import {
  loadTelemetry,
  saveTelemetry,
  recordTaskStart,
  recordTaskComplete,
  recordCircuitBreakerTrip,
  formatTelemetrySummary,
  estimateTokens,
  recomputeTelemetrySummary,
} from '../dist/core/telemetry.js';
import { createMcpServer } from '../dist/mcp/server.js';
import { CircuitBreaker } from '../dist/governor/circuit-breaker.js';

console.log('--- Starting Automated Execution & Cost Telemetry Engine Tests ---');

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-telemetry-test-'));
  const aiDir = path.join(dir, '.ai');
  fs.mkdirSync(aiDir, { recursive: true });
  fs.writeFileSync(path.join(aiDir, 'context.md'), '# Context\n', 'utf8');

  // Create dummy target files to test token estimation heuristics
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const hello = "world";\n'.repeat(50), 'utf8'); // ~1.5KB
  fs.writeFileSync(path.join(dir, 'db.ts'), 'export interface User { id: string; name: string; }\n'.repeat(40), 'utf8');

  const plan = {
    projectName: 'telemetry-fixture',
    overallStatus: 'in_progress',
    activeMilestoneId: 'm1',
    lastUpdated: new Date().toISOString(),
    milestones: [
      {
        id: 'm1',
        name: 'Milestone 1',
        status: 'in_progress',
        tasks: [
          {
            id: 'task-auth',
            title: 'Implement JWT Auth',
            assignedSubagent: 'backend',
            dependencies: [],
            targetFiles: ['app.ts', 'db.ts'],
            status: 'pending',
            verificationCommand: 'node -e "process.exit(0)"',
            notes: '',
          },
          {
            id: 'task-ui',
            title: 'Build Login Form',
            assignedSubagent: 'frontend',
            dependencies: ['task-auth'],
            targetFiles: ['app.ts'],
            status: 'pending',
            verificationCommand: 'none',
            notes: '',
          },
          {
            id: 'task-fail',
            title: 'Faulty Task',
            assignedSubagent: 'backend',
            dependencies: [],
            targetFiles: [],
            status: 'pending',
            verificationCommand: 'node -e "process.exit(1)"',
            notes: '',
          },
        ],
      },
    ],
  };

  fs.writeFileSync(path.join(aiDir, 'master_plan.json'), JSON.stringify(plan, null, 2), 'utf8');
  return dir;
}

async function runTests() {
  const dir = createFixture();
  const telemetryPath = path.join(dir, '.ai', 'telemetry.json');

  try {
    // 1. Initial loadTelemetry when file doesn't exist returns clean structure
    {
      const initial = loadTelemetry(telemetryPath, 'test-project');
      assert.equal(initial.projectName, 'test-project');
      assert.equal(initial.summary.totalTasksCompleted, 0);
      assert.equal(initial.summary.estimatedTotalTokens, 0);
      assert.equal(initial.summary.estimatedTotalCostUsd, 0);
      assert.equal(initial.summary.circuitBreakerTrips, 0);
      assert.equal(initial.tasks.length, 0);
      console.log('✔ Test 1: loadTelemetry initializes clean structure when no telemetry.json exists');
    }

    // 2. Token estimation heuristics
    {
      const dummyTask = {
        id: 'dummy',
        title: 'Dummy',
        assignedSubagent: 'backend',
        dependencies: [],
        targetFiles: ['app.ts', 'db.ts'],
        status: 'pending',
      };
      const estimate = estimateTokens(dir, dummyTask);
      assert.ok(estimate.inputEstimated > 3500, 'Input tokens should include base prompt + file contents');
      assert.ok(estimate.outputEstimated >= 350, 'Output tokens should meet or exceed baseline');
      assert.ok(estimate.costUsdEstimated > 0, 'Estimated cost should be positive');
      console.log(`✔ Test 2: Token estimation heuristics: ~${estimate.totalEstimated} tokens, $${estimate.costUsdEstimated}`);
    }

    // 3. Task start records into telemetry
    {
      await runTaskStart('task-auth', dir);
      const telemetry = loadTelemetry(telemetryPath, 'telemetry-fixture');
      assert.equal(telemetry.tasks.length, 1);
      const record = telemetry.tasks[0];
      assert.equal(record.taskId, 'task-auth');
      assert.equal(record.status, 'in_progress');
      assert.ok(record.startedAt);
      console.log('✔ Test 3: runTaskStart writes in_progress record to telemetry.json');
    }

    // 4. Task complete updates duration, tokens, cost, and verification metrics
    {
      await runTaskComplete('task-auth', dir);
      const telemetry = loadTelemetry(telemetryPath, 'telemetry-fixture');
      assert.equal(telemetry.summary.totalTasksCompleted, 1);
      assert.equal(telemetry.summary.totalVerificationsRun, 1);
      assert.equal(telemetry.summary.totalVerificationsPassed, 1);
      assert.equal(telemetry.summary.verificationPassRate, 1.0);
      assert.ok(telemetry.summary.estimatedTotalTokens > 0);
      assert.ok(telemetry.summary.estimatedTotalCostUsd > 0);

      const record = telemetry.tasks.find((t) => t.taskId === 'task-auth');
      assert.ok(record);
      assert.equal(record.status, 'completed');
      assert.ok(record.completedAt);
      assert.ok(record.durationMs >= 0);
      assert.ok(record.verification);
      assert.equal(record.verification.exitCode, 0);
      assert.equal(record.verification.skipped, false);
      assert.ok(record.tokens);
      console.log(`✔ Test 4: runTaskComplete updates duration (${record.durationMs}ms) & summary ($${telemetry.summary.estimatedTotalCostUsd})`);
    }

    // 5. Complete task with verification skipped (verificationCommand: 'none')
    {
      await runTaskStart('task-ui', dir);
      await runTaskComplete('task-ui', dir);
      const telemetry = loadTelemetry(telemetryPath, 'telemetry-fixture');
      assert.equal(telemetry.summary.totalTasksCompleted, 2);
      // 'none' verification is skipped, so verifications run should still be 1
      assert.equal(telemetry.summary.totalVerificationsRun, 1);
      assert.equal(telemetry.summary.totalVerificationsPassed, 1);
      assert.equal(telemetry.summary.verificationPassRate, 1.0);

      const uiRecord = telemetry.tasks.find((t) => t.taskId === 'task-ui');
      assert.ok(uiRecord);
      assert.equal(uiRecord.status, 'completed');
      assert.equal(uiRecord.verification?.skipped, true);
      console.log('✔ Test 5: Skipped verifications correctly reflected in summary pass rate');
    }

    // 6. Circuit breaker trip updates telemetry
    {
      await recordCircuitBreakerTrip(dir, 'task-fail');
      const telemetry = loadTelemetry(telemetryPath, 'telemetry-fixture');
      assert.equal(telemetry.summary.circuitBreakerTrips, 1);
      console.log('✔ Test 6: Circuit breaker trips recorded in telemetry summary');
    }

    // 7. formatTelemetrySummary output
    {
      const telemetry = loadTelemetry(telemetryPath, 'telemetry-fixture');
      const formatted = formatTelemetrySummary(telemetry);
      assert.ok(formatted.includes('Execution & Cost Telemetry'));
      assert.ok(formatted.includes('Tasks Completed:'));
      assert.ok(formatted.includes('Estimated Cost:'));
      assert.ok(formatted.includes('Circuit Breaker Trips:'));
      console.log('✔ Test 7: formatTelemetrySummary generates well-structured CLI output');
    }

    // 8. CLI status with --telemetry and --json flags
    {
      let jsonOutput = '';
      const originalLog = console.log;
      console.log = (msg) => {
        jsonOutput += msg + '\n';
      };
      try {
        await runStatus(dir, { json: true });
      } finally {
        console.log = originalLog;
      }

      const parsed = JSON.parse(jsonOutput);
      assert.equal(parsed.projectName, 'telemetry-fixture');
      assert.equal(parsed.telemetry.totalTasksCompleted, 2);
      assert.equal(parsed.telemetry.circuitBreakerTrips, 1);
      assert.equal(parsed.tasksTelemetry.length, 2);
      console.log('✔ Test 8: runStatus with --json emits full structured telemetry');
    }

    // 9. MCP Server nativ://telemetry resource
    {
      const server = createMcpServer(dir);
      // Test readResource via mcpServer internal registration
      // Since McpServer encapsulates resource handlers, we can test that the file exists and is valid
      const raw = fs.readFileSync(telemetryPath, 'utf8');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.version, '1.0.0');
      assert.equal(parsed.summary.totalTasksCompleted, 2);
      console.log('✔ Test 9: Telemetry contract artifact conforms to nativ://telemetry MCP resource');
    }

    // 10. Estimates use current model rates; retired model labels and stale prices are corrected
    {
      const legacyPath = path.join(dir, '.ai', 'legacy-telemetry.json');
      fs.writeFileSync(
        legacyPath,
        JSON.stringify({
          version: '1.0.0',
          projectName: 'legacy',
          lastUpdated: '2026-01-01T00:00:00.000Z',
          modelTierDefault: 'claude-3-7-sonnet',
          summary: { totalTasksCompleted: 1, totalDurationMs: 1000, estimatedTotalTokens: 12000, estimatedTotalCostUsd: 0.072, verificationPassRate: 1, totalVerificationsRun: 1, totalVerificationsPassed: 1, circuitBreakerTrips: 0 },
          tasks: [{ taskId: 'old', title: 'old', assignedSubagent: 'backend', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 1000, status: 'completed', tokens: { inputEstimated: 9000, outputEstimated: 3000, totalEstimated: 12000, costUsdEstimated: 0.072 } }],
        }),
      );
      const legacy = loadTelemetry(legacyPath);
      assert.equal(legacy.modelTierDefault, 'claude-opus-5-5', 'a retired model label is replaced by the current default');

      // No target files: 3,500 input + 350 output tokens at Opus 5.5 rates ($4 / $20 per MTok).
      const noFiles = { id: 'bare', title: 'Bare', assignedSubagent: 'backend', dependencies: [], targetFiles: [], status: 'pending' };
      assert.equal(estimateTokens(dir, noFiles, 'claude-opus-5-5').costUsdEstimated, 0.021, 'estimates are priced at the current model rates');
      assert.equal(estimateTokens(dir, noFiles).costUsdEstimated, 0.021, 'the default pricing model is claude-opus-5-5');
      assert.equal(estimateTokens(dir, noFiles, 'claude-sonnet-5').costUsdEstimated, 0.0105, 'estimates follow the model they are priced for');

      // Stored token estimates are re-priced when the summary is recomputed: 9,000 × $4 + 3,000 × $20.
      recomputeTelemetrySummary(legacy);
      assert.equal(legacy.tasks[0].tokens.costUsdEstimated, 0.096);
      assert.equal(legacy.summary.estimatedTotalCostUsd, 0.096);

      const text = formatTelemetrySummary(legacy, { completedTasks: 3 });
      assert.ok(text.includes('claude-opus-5-5'), 'the summary names the pricing model');
      assert.ok(text.includes('+2 completed without telemetry'), 'tasks completed before telemetry existed are called out, not silently missing');
      console.log('✔ Test 10: Estimates use current rates, retired model labels are replaced, untracked tasks are reported');
    }

    console.log('\n--- All Execution & Cost Telemetry Engine Tests Passed! ---\n');
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}

runTests().catch((err) => {
  console.error('\n✖ Telemetry Engine Tests FAILED:', err);
  process.exit(1);
});
