import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runBenchmarks, formatBenchmarkReport } from '../dist/core/benchmark.js';
import { createMcpServer } from '../dist/mcp/server.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('bin/cli.js');

console.log('--- Starting Automated Synthetic Benchmark Suite Tests ---');

async function runTests() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-bench-test-'));

  try {
    // 1. Run Telemetry Scenario directly
    {
      const report = await runBenchmarks({ scenario: 'telemetry' });
      assert.equal(report.summary.totalScenarios, 1);
      assert.equal(report.summary.passedScenarios, 1);
      assert.equal(report.summary.score, 100);
      assert.equal(report.scenarios[0].id, 'telemetry');
      assert.ok(report.scenarios[0].operations >= 4);
      console.log('✔ Test 1: Telemetry benchmark scenario passed with 100% score');
    }

    // 2. Run Governor Scenario directly
    {
      const report = await runBenchmarks({ scenario: 'governor' });
      assert.equal(report.summary.totalScenarios, 1);
      assert.equal(report.summary.passedScenarios, 1);
      assert.equal(report.summary.score, 100);
      assert.equal(report.scenarios[0].id, 'governor');
      assert.equal(report.scenarios[0].assertionsPassed, 6);
      console.log('✔ Test 2: Governor invariant benchmark scenario passed with 100% score');
    }

    // 3. Run Verification Gatekeeper Scenario directly
    {
      const report = await runBenchmarks({ scenario: 'verification' });
      assert.equal(report.summary.totalScenarios, 1);
      assert.equal(report.summary.passedScenarios, 1);
      assert.equal(report.summary.score, 100);
      assert.equal(report.scenarios[0].id, 'verification');
      console.log('✔ Test 3: Verification gatekeeper benchmark scenario passed with 100% score');
    }

    // 4. Run End-to-End Multi-Agent Lifecycle Scenario directly
    {
      const report = await runBenchmarks({ scenario: 'e2e' });
      assert.equal(report.summary.totalScenarios, 1);
      assert.equal(report.summary.passedScenarios, 1);
      assert.equal(report.summary.score, 100);
      assert.equal(report.scenarios[0].id, 'e2e_pipeline');
      console.log('✔ Test 4: End-to-end multi-agent lifecycle scenario passed with 100% score');
    }

    // 5. Test CLI execution with --json
    {
      const { stdout } = await execFileAsync(process.execPath, [cliPath, 'bench', '--scenario', 'telemetry', '--json']);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.version, '1.0.0');
      assert.equal(parsed.summary.score, 100);
      assert.equal(parsed.scenarios[0].id, 'telemetry');
      console.log('✔ Test 5: CLI bench --json emitted valid structured benchmark report');
    }

    // 6. Test CLI execution with custom output file
    {
      const customOut = path.join(tmpDir, 'custom_bench_report.json');
      await execFileAsync(process.execPath, [cliPath, 'bench', '--scenario', 'telemetry', '-o', customOut]);
      assert.ok(fs.existsSync(customOut), 'Custom output report file must exist');
      const saved = JSON.parse(fs.readFileSync(customOut, 'utf8'));
      assert.equal(saved.summary.score, 100);
      console.log('✔ Test 6: CLI bench -o saved benchmark report to designated custom file');
    }

    // 7. Format Benchmark Report helper check
    {
      const report = await runBenchmarks({ scenario: 'telemetry' });
      const formatted = formatBenchmarkReport(report);
      assert.ok(formatted.includes('NATIV LOCAL SYNTHETIC BENCHMARK SUITE'));
      assert.ok(formatted.includes('Benchmark Score:'));
      assert.ok(formatted.includes('Total Operations:'));
      console.log('✔ Test 7: formatBenchmarkReport renders clean, high-readability report');
    }

    // 8. MCP Server exposes the nativ_bench tool
    {
      const server = createMcpServer(tmpDir);
      assert.ok(server, 'MCP server instance created');
      console.log('✔ Test 8: nativ_bench tool registered in native MCP server');
    }

    console.log('\n--- All Synthetic Benchmark Suite Tests Passed! ---\n');
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  }
}

runTests().catch((err) => {
  console.error('\n✖ Benchmark Suite Tests FAILED:', err);
  process.exit(1);
});
