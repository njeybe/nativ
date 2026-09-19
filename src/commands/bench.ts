import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { runBenchmarks, formatBenchmarkReport, BenchmarkOptions, BenchmarkReport } from '../core/benchmark.js';

export interface BenchCommandOptions extends BenchmarkOptions {
  output?: string;
  json?: boolean;
  scenario?: string;
  concurrency?: number;
}

export async function runBench(targetDirArg?: string, options: BenchCommandOptions = {}) {
  const targetDir = path.resolve(targetDirArg || process.cwd());

  try {
    if (!options.json) {
      console.log(pc.bold(pc.cyan('\n🚀 Initiating Nativ Synthetic Benchmark Matrix...')));
      if (options.scenario) {
        console.log(pc.dim(`  Target Scenario: `) + pc.yellow(options.scenario));
      }
      if (options.concurrency) {
        console.log(pc.dim(`  Simulated Workers: `) + pc.yellow(String(options.concurrency)));
      }
    }

    const report = await runBenchmarks(options);

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatBenchmarkReport(report));
    }

    // Write to output file if requested or if inside an existing .ai project
    let outputPath = options.output;
    if (!outputPath) {
      const aiDir = path.join(targetDir, '.ai');
      if (fs.existsSync(aiDir)) {
        outputPath = path.join(aiDir, 'benchmark_report.json');
      }
    }

    if (outputPath) {
      const resolvedOutput = path.resolve(outputPath);
      const outDir = path.dirname(resolvedOutput);
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }
      fs.writeFileSync(resolvedOutput, JSON.stringify(report, null, 2) + '\n', 'utf8');
      if (!options.json) {
        console.log(pc.dim(`📁 Benchmark report saved to: `) + pc.white(resolvedOutput) + '\n');
      }
    }

    if (report.summary.failedScenarios > 0) {
      process.exitCode = 1;
    }

    return report;
  } catch (err: any) {
    console.error(pc.red(`\n✖ Benchmark suite failed: ${err.message}`));
    process.exitCode = 1;
  }
}
