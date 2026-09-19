import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { withPlanLock, loadPlan } from './lock-manager.js';
import { ContractGovernor, ContractPatch } from '../governor/index.js';
import { executeVerification } from './verifier.js';
import {
  loadTelemetry,
  recordTaskStart,
  recordTaskComplete,
  recordCircuitBreakerTrip,
  estimateTokens,
} from './telemetry.js';
import { runTaskStart, runTaskComplete, runTaskAdd } from '../commands/task.js';
import { MasterPlan, MasterPlanTask } from '../scanner/types.js';

export interface BenchmarkScenarioResult {
  id: string;
  name: string;
  description: string;
  status: 'passed' | 'failed';
  durationMs: number;
  operations: number;
  throughputOpsPerSec: number;
  assertionsPassed: number;
  assertionsFailed: number;
  details: Record<string, any>;
  errors?: string[];
}

export interface BenchmarkSummary {
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  score: number;
  totalDurationMs: number;
  totalOperations: number;
  averageThroughputOpsPerSec: number;
}

export interface BenchmarkReport {
  version: string;
  timestamp: string;
  environment: {
    platform: string;
    nodeVersion: string;
    cpuCount: number;
    arch: string;
  };
  summary: BenchmarkSummary;
  scenarios: BenchmarkScenarioResult[];
}

export interface BenchmarkOptions {
  scenario?: string;
  concurrency?: number;
  output?: string;
  json?: boolean;
  verbose?: boolean;
}

/**
 * Creates an isolated scratch workspace for benchmarking with valid .ai/ contracts.
 */
export function createBenchmarkSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-bench-'));
  const aiDir = path.join(dir, '.ai');
  fs.mkdirSync(aiDir, { recursive: true });

  fs.writeFileSync(
    path.join(aiDir, 'context.md'),
    '# Benchmark Project\nArchitecture: Node.js / TypeScript microservices with SQLite / PostgreSQL.\n',
    'utf8'
  );

  const initialPlan: MasterPlan = {
    version: '1.0.0',
    projectName: 'benchmark-sandbox',
    overallStatus: 'in_progress',
    activeMilestoneId: 'm1',
    lastUpdated: new Date().toISOString(),
    milestones: [
      {
        id: 'm1',
        name: 'Core Infrastructure',
        status: 'in_progress',
        tasks: [
          {
            id: 'task-01',
            title: 'Setup Database Connection',
            description: 'Database setup',
            assignedSubagent: 'database',
            dependencies: [],
            targetFiles: ['src/db.ts'],
            status: 'pending',
            verificationCommand: 'node -e "process.exit(0)"',
          },
          {
            id: 'task-02',
            title: 'Implement Auth Routes',
            description: 'Authentication routes',
            assignedSubagent: 'backend',
            dependencies: ['task-01'],
            targetFiles: ['src/auth.ts'],
            status: 'pending',
            verificationCommand: 'node -e "process.exit(0)"',
          },
          {
            id: 'task-03',
            title: 'Design Login Screen',
            description: 'Login UI layout',
            assignedSubagent: 'frontend',
            dependencies: ['task-02'],
            targetFiles: ['src/views/login.html'],
            status: 'pending',
            verificationCommand: 'none',
          },
        ],
      },
      {
        id: 'm2',
        name: 'API & Gateway',
        status: 'pending',
        tasks: [
          {
            id: 'task-04',
            title: 'Build GraphQL Gateway',
            description: 'Gateway service',
            assignedSubagent: 'backend',
            dependencies: ['task-02'],
            targetFiles: ['src/gateway.ts'],
            status: 'pending',
            verificationCommand: 'node -e "process.exit(0)"',
          },
        ],
      },
    ],
  };

  fs.writeFileSync(path.join(aiDir, 'master_plan.json'), JSON.stringify(initialPlan, null, 2), 'utf8');

  const dbSchema = {
    version: '1.0.0',
    tables: [
      {
        name: 'users',
        columns: [
          { name: 'id', type: 'VARCHAR(36)', nullable: false, primaryKey: true },
          { name: 'email', type: 'VARCHAR(255)', nullable: false, unique: true },
          { name: 'password_hash', type: 'VARCHAR(255)', nullable: false },
        ],
        indexes: [{ name: 'idx_users_email', columns: ['email'], unique: true }],
      },
    ],
  };
  fs.writeFileSync(path.join(aiDir, 'db_schema.json'), JSON.stringify(dbSchema, null, 2), 'utf8');

  const apiContracts = {
    version: '1.0.0',
    endpoints: [
      {
        id: 'post-auth-login',
        path: '/api/auth/login',
        method: 'POST',
        summary: 'User login',
        requestBody: {
          contentType: 'application/json',
          schema: { email: 'string', password: 'string' },
        },
        responses: {
          '200': { description: 'Authenticated token', schema: { token: 'string' } },
          '401': { description: 'Invalid credentials' },
        },
      },
    ],
  };
  fs.writeFileSync(path.join(aiDir, 'api_contracts.json'), JSON.stringify(apiContracts, null, 2), 'utf8');

  return dir;
}

/**
 * Resilient sandbox cleanup handling Windows NTFS delayed locks.
 */
export function cleanupSandbox(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/**
 * Executes a function quietly, keeping benchmark stdout clean for reports and JSON.
 */
async function silent<T>(fn: () => Promise<T>): Promise<T> {
  const origLog = console.log;
  const origErr = console.error;
  const origInfo = console.info;
  const origWarn = console.warn;
  console.log = () => {};
  console.error = () => {};
  console.info = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.info = origInfo;
    console.warn = origWarn;
  }
}

/**
 * Scenario 1: Multi-Agent Concurrency & Lock Contention
 */
async function runConcurrencyScenario(concurrency: number = 6): Promise<BenchmarkScenarioResult> {
  const sandbox = createBenchmarkSandbox();
  const planPath = path.join(sandbox, '.ai', 'master_plan.json');
  const errors: string[] = [];
  let assertionsPassed = 0;
  let assertionsFailed = 0;

  const startTime = Date.now();
  const lockWaitTimes: number[] = [];

  try {
    // Populate 20 tasks into milestone 1
    await withPlanLock(planPath, (plan) => {
      plan.milestones[0].tasks = [];
      for (let i = 1; i <= 20; i++) {
        const id = `bench-task-${String(i).padStart(2, '0')}`;
        plan.milestones[0].tasks.push({
          id,
          title: `Synthetic Task ${i}`,
          description: `Synthetic task ${i} description`,
          assignedSubagent: i % 2 === 0 ? 'backend' : 'frontend',
          dependencies: [],
          targetFiles: [`file-${i}.ts`],
          status: 'pending',
          verificationCommand: 'node -e "process.exit(0)"',
        });
      }
    });

    const totalOps = 20 + 20 + 8; // 20 starts, 20 completes, 8 concurrent adds

    // 1. Parallel Task Starts
    const startPromises = Array.from({ length: 20 }, async (_, i) => {
      const taskId = `bench-task-${String(i + 1).padStart(2, '0')}`;
      const t0 = Date.now();
      await runTaskStart(taskId, sandbox);
      lockWaitTimes.push(Date.now() - t0);
    });
    await Promise.all(startPromises);

    // Verify all 20 in_progress
    const p1 = loadPlan(planPath);
    if (p1 && p1.milestones[0].tasks.every((t) => t.status === 'in_progress')) {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push('Not all tasks were atomically transitioned to in_progress.');
    }

    // 2. Parallel Task Completes
    const completePromises = Array.from({ length: 20 }, async (_, i) => {
      const taskId = `bench-task-${String(i + 1).padStart(2, '0')}`;
      const t0 = Date.now();
      await runTaskComplete(taskId, sandbox, { skipVerify: true });
      lockWaitTimes.push(Date.now() - t0);
    });
    await Promise.all(completePromises);

    // Verify all 20 completed
    const p2 = loadPlan(planPath);
    if (p2 && p2.milestones[0].tasks.every((t) => t.status === 'completed')) {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push('Not all tasks were atomically transitioned to completed.');
    }

    // 3. Parallel Task Adds
    const addPromises = Array.from({ length: 8 }, async (_, i) => {
      const t0 = Date.now();
      await runTaskAdd(`Dynamic Worker Task ${i + 1}`, sandbox);
      lockWaitTimes.push(Date.now() - t0);
    });
    await Promise.all(addPromises);

    const p3 = loadPlan(planPath);
    const totalTasks = p3 ? p3.milestones.reduce((acc, m) => acc + m.tasks.length, 0) : 0;
    if (totalTasks === 29) {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push(`Expected 29 tasks across milestones after concurrent adds, found ${totalTasks}`);
    }

    const durationMs = Date.now() - startTime;
    const meanLockWait =
      lockWaitTimes.length > 0
        ? Math.round((lockWaitTimes.reduce((a, b) => a + b, 0) / lockWaitTimes.length) * 100) / 100
        : 0;
    const maxLockWait = lockWaitTimes.length > 0 ? Math.max(...lockWaitTimes) : 0;
    const throughput = Math.round((totalOps / (durationMs / 1000)) * 10) / 10;

    return {
      id: 'concurrency',
      name: 'Multi-Agent Lock Contention & Throughput',
      description: 'Stresses atomic OS advisory locks and state transitions across concurrent agent workers.',
      status: assertionsFailed === 0 ? 'passed' : 'failed',
      durationMs,
      operations: totalOps,
      throughputOpsPerSec: throughput,
      assertionsPassed,
      assertionsFailed,
      details: {
        concurrentWorkers: concurrency,
        totalAtomicMutations: totalOps,
        meanLockWaitMs: meanLockWait,
        maxLockWaitMs: maxLockWait,
      },
      errors: errors.length > 0 ? errors : undefined,
    };
  } finally {
    cleanupSandbox(sandbox);
  }
}

/**
 * Scenario 2: Contract Governor Invariant Engine & Circuit Breaker
 */
async function runGovernorScenario(): Promise<BenchmarkScenarioResult> {
  const sandbox = createBenchmarkSandbox();
  const errors: string[] = [];
  let assertionsPassed = 0;
  let assertionsFailed = 0;
  const startTime = Date.now();
  let operations = 0;

  try {
    // 1. Additive DB change (Valid -> should approve)
    operations++;
    const addColPatch: ContractPatch = {
      taskId: 'bench-task-gov',
      target: 'db_schema',
      operation: 'ADD',
      path: 'users.columns.bio',
      value: { name: 'bio', type: 'TEXT', nullable: true },
      reason: 'Add user bio field',
    };
    const res1 = ContractGovernor.evaluate(sandbox, addColPatch);
    if (res1.approved && res1.patchApplied) {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push(`Additive DB change was rejected: ${res1.message}`);
    }

    // 2. Destructive DB change (Drop column -> must reject)
    operations++;
    const dropColPatch: ContractPatch = {
      taskId: 'bench-task-gov',
      target: 'db_schema',
      operation: 'DROP',
      path: 'users.columns.email',
      reason: 'Drop email column',
    };
    const res2 = ContractGovernor.evaluate(sandbox, dropColPatch);
    if (!res2.approved && (res2.ruleId === 'DB_DROP_FORBIDDEN' || res2.blastRadius === 'HIGH_DESTRUCTIVE')) {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push('Destructive DB drop column was unexpectedly approved.');
    }

    // 3. Additive API change (Valid -> should approve)
    operations++;
    const addEndpointPatch: ContractPatch = {
      taskId: 'bench-task-gov',
      target: 'api_contracts',
      operation: 'ADD',
      path: 'endpoints./api/users/profile',
      value: {
        id: 'get-users-profile',
        path: '/api/users/profile',
        method: 'GET',
        summary: 'Get user profile',
      },
      reason: 'Expose profile query',
    };
    const res3 = ContractGovernor.evaluate(sandbox, addEndpointPatch);
    if (res3.approved && res3.patchApplied) {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push(`Additive API change was rejected: ${res3.message}`);
    }

    // 4. Destructive API change (Drop endpoint -> must reject)
    operations++;
    const dropEndpointPatch: ContractPatch = {
      taskId: 'bench-task-gov',
      target: 'api_contracts',
      operation: 'DROP',
      path: 'endpoints.post-auth-login',
      reason: 'Drop login route',
    };
    const res4 = ContractGovernor.evaluate(sandbox, dropEndpointPatch);
    if (!res4.approved && (res4.ruleId === 'API_DROP_FORBIDDEN' || res4.blastRadius === 'HIGH_DESTRUCTIVE')) {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push('Destructive endpoint deletion was unexpectedly approved.');
    }

    // 5. 3-Strike Circuit Breaker Tripping
    operations += 3;
    let tripped = false;
    for (let i = 0; i < 3; i++) {
      const dropAttempt: ContractPatch = {
        taskId: 'bench-task-runaway',
        target: 'db_schema',
        operation: 'DROP',
        path: 'users.columns.id',
        reason: `Repeated destructive drop attempt ${i + 1}`,
      };
      const r = ContractGovernor.evaluate(sandbox, dropAttempt);
      if (r.circuitBreaker?.tripped) {
        tripped = true;
      }
    }

    if (tripped) {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push('Governor circuit breaker did not trip after 3 consecutive destructive violations.');
    }

    const escalationPath = path.join(sandbox, '.ai', 'escalation.json');
    if (fs.existsSync(escalationPath)) {
      const esc = JSON.parse(fs.readFileSync(escalationPath, 'utf8'));
      if (esc.escalations.length > 0) {
        assertionsPassed++;
      } else {
        assertionsFailed++;
        errors.push('Escalation record was not logged by circuit breaker flight recorder.');
      }
    } else {
      assertionsFailed++;
      errors.push('No .ai/escalation.json was created upon circuit breaker trip.');
    }

    const durationMs = Date.now() - startTime;
    const throughput = Math.round((operations / (durationMs / 1000)) * 10) / 10;

    return {
      id: 'governor',
      name: 'Contract Invariant & Circuit Breaker Engine',
      description: 'Tests invariant evaluation, additive auto-approvals, destructive rejections, and 3-strike escalation.',
      status: assertionsFailed === 0 ? 'passed' : 'failed',
      durationMs,
      operations,
      throughputOpsPerSec: throughput,
      assertionsPassed,
      assertionsFailed,
      details: {
        invariantsChecked: ['NO_DESTRUCTIVE_SCHEMA', 'NO_ENDPOINT_DELETION', 'ADDITIVE_SCHEMA_APPROVAL'],
        circuitBreakerTripped: tripped,
      },
      errors: errors.length > 0 ? errors : undefined,
    };
  } finally {
    cleanupSandbox(sandbox);
  }
}

/**
 * Scenario 3: Verification Gatekeeper Performance & Isolation
 */
async function runVerificationScenario(): Promise<BenchmarkScenarioResult> {
  const sandbox = createBenchmarkSandbox();
  const errors: string[] = [];
  let assertionsPassed = 0;
  let assertionsFailed = 0;
  const startTime = Date.now();
  let operations = 0;

  try {
    // 1. Passing verification
    operations++;
    const passRes = await executeVerification('node -e "process.exit(0)"', sandbox);
    if (passRes.success && passRes.exitCode === 0) {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push(`Passing verification failed with exit code ${passRes.exitCode}`);
    }

    // 2. Failing verification with custom exit code
    operations++;
    const failRes = await executeVerification(
      'node -e "console.error(\\"synthetic error\\"); process.exit(42)"',
      sandbox
    );
    if (!failRes.success && failRes.exitCode === 42 && failRes.stderr.includes('synthetic error')) {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push('Failing verification did not capture exit code 42 or stderr correctly.');
    }

    // 3. Skipped verification command
    operations++;
    const skipRes = await executeVerification('none', sandbox);
    if (skipRes.success && skipRes.skipped) {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push('Verification command "none" was not recognized as skipped.');
    }

    // 4. Timeout handling (150ms timeout on a command sleeping 500ms)
    operations++;
    const timeoutRes = await executeVerification('node -e "setTimeout(() => {}, 500)"', sandbox, 150);
    if (!timeoutRes.success && (timeoutRes.exitCode === 124 || timeoutRes.exitCode === 1 || timeoutRes.durationMs >= 140)) {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push(`Timeout command did not fail as expected (exitCode ${timeoutRes.exitCode}, success: ${timeoutRes.success})`);
    }

    const durationMs = Date.now() - startTime;
    const throughput = Math.round((operations / (durationMs / 1000)) * 10) / 10;

    return {
      id: 'verification',
      name: 'Verification Gatekeeper & Regression Guard',
      description: 'Tests test command execution, error diagnostics capture, timeout isolation, and skip handling.',
      status: assertionsFailed === 0 ? 'passed' : 'failed',
      durationMs,
      operations,
      throughputOpsPerSec: throughput,
      assertionsPassed,
      assertionsFailed,
      details: {
        testsExecuted: operations,
      },
      errors: errors.length > 0 ? errors : undefined,
    };
  } finally {
    cleanupSandbox(sandbox);
  }
}

/**
 * Scenario 4: Telemetry & Cost Accounting Integrity
 */
async function runTelemetryScenario(): Promise<BenchmarkScenarioResult> {
  const sandbox = createBenchmarkSandbox();
  const errors: string[] = [];
  let assertionsPassed = 0;
  let assertionsFailed = 0;
  const startTime = Date.now();
  let operations = 0;

  try {
    const telemetryPath = path.join(sandbox, '.ai', 'telemetry.json');

    // Create synthetic target files for token weight calculation
    fs.writeFileSync(path.join(sandbox, 'service.ts'), 'export function execute() { return true; }\n'.repeat(40), 'utf8');

    const syntheticTask: MasterPlanTask = {
      id: 'telemetry-task-01',
      title: 'Implement Core Service',
      description: 'Core service implementation',
      assignedSubagent: 'backend',
      dependencies: [],
      targetFiles: ['service.ts'],
      status: 'pending',
      verificationCommand: 'npm test',
    };

    // 1. Estimate tokens
    operations++;
    const tokens = estimateTokens(sandbox, syntheticTask);
    if (tokens.inputEstimated > 3500 && tokens.costUsdEstimated > 0) {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push('Token estimation heuristics failed to compute input tokens or cost.');
    }

    // 2. Record task start
    operations++;
    await recordTaskStart(sandbox, syntheticTask);
    let tel = loadTelemetry(telemetryPath, 'bench-proj');
    if (tel.tasks.length === 1 && tel.tasks[0].status === 'in_progress') {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push('Telemetry recordTaskStart did not register in_progress record.');
    }

    // 3. Record task complete with verification
    operations++;
    await recordTaskComplete(sandbox, syntheticTask, {
      command: 'npm test',
      durationMs: 45,
      exitCode: 0,
      stdout: 'All tests passed',
      stderr: '',
      skipped: false,
      success: true,
    });

    tel = loadTelemetry(telemetryPath, 'bench-proj');
    if (
      tel.summary.totalTasksCompleted === 1 &&
      tel.summary.totalVerificationsRun === 1 &&
      tel.summary.verificationPassRate === 1.0 &&
      tel.summary.estimatedTotalCostUsd > 0
    ) {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push('Telemetry recordTaskComplete failed to compute summary metrics correctly.');
    }

    // 4. Circuit breaker trip recording
    operations++;
    await recordCircuitBreakerTrip(sandbox, 'telemetry-task-01');
    tel = loadTelemetry(telemetryPath, 'bench-proj');
    if (tel.summary.circuitBreakerTrips === 1) {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push('Telemetry recordCircuitBreakerTrip did not increment trip counter.');
    }

    const durationMs = Date.now() - startTime;
    const throughput = Math.round((operations / (durationMs / 1000)) * 10) / 10;

    return {
      id: 'telemetry',
      name: 'Telemetry & Cost Accounting Integrity',
      description: 'Tests live recording of durations, token heuristics, cost estimates, and pass rates.',
      status: assertionsFailed === 0 ? 'passed' : 'failed',
      durationMs,
      operations,
      throughputOpsPerSec: throughput,
      assertionsPassed,
      assertionsFailed,
      details: {
        totalCostUsd: tel.summary.estimatedTotalCostUsd,
        totalTokens: tel.summary.estimatedTotalTokens,
        circuitBreakersRecorded: tel.summary.circuitBreakerTrips,
      },
      errors: errors.length > 0 ? errors : undefined,
    };
  } finally {
    cleanupSandbox(sandbox);
  }
}

/**
 * Scenario 5: End-to-End Autonomous Multi-Agent Pipeline
 */
async function runE2EPipelineScenario(): Promise<BenchmarkScenarioResult> {
  const sandbox = createBenchmarkSandbox();
  const errors: string[] = [];
  let assertionsPassed = 0;
  let assertionsFailed = 0;
  const startTime = Date.now();
  let operations = 0;

  try {
    const planPath = path.join(sandbox, '.ai', 'master_plan.json');

    // 1. Task 1 lifecycle
    operations++;
    await runTaskStart('task-01', sandbox);
    await runTaskComplete('task-01', sandbox);

    // 2. Task 2 lifecycle
    operations++;
    await runTaskStart('task-02', sandbox);
    await runTaskComplete('task-02', sandbox);

    // 3. Task 3 lifecycle (completes Milestone 1)
    operations++;
    await runTaskStart('task-03', sandbox);
    await runTaskComplete('task-03', sandbox);

    // Check if Milestone 1 completed and active milestone advanced to m2
    const planAfterM1 = loadPlan(planPath);
    if (
      planAfterM1 &&
      planAfterM1.milestones[0].status === 'completed' &&
      planAfterM1.activeMilestoneId === 'm2'
    ) {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push(`Active milestone failed to advance to m2. Current: ${planAfterM1?.activeMilestoneId}`);
    }

    // 4. Task 4 lifecycle (completes Milestone 2 & overall project)
    operations++;
    await runTaskStart('task-04', sandbox);
    await runTaskComplete('task-04', sandbox);

    const finalPlan = loadPlan(planPath);
    if (
      finalPlan &&
      finalPlan.milestones[1].status === 'completed' &&
      finalPlan.overallStatus === 'completed'
    ) {
      assertionsPassed++;
    } else {
      assertionsFailed++;
      errors.push(`Overall project status failed to mark completed. Status: ${finalPlan?.overallStatus}`);
    }

    const durationMs = Date.now() - startTime;
    const throughput = Math.round((operations / (durationMs / 1000)) * 10) / 10;

    return {
      id: 'e2e_pipeline',
      name: 'Autonomous Multi-Agent Lifecycle & Milestone Graph',
      description: 'Simulates complete multi-agent lifecycle across dependency graph and milestone advancement.',
      status: assertionsFailed === 0 ? 'passed' : 'failed',
      durationMs,
      operations,
      throughputOpsPerSec: throughput,
      assertionsPassed,
      assertionsFailed,
      details: {
        milestonesResolved: 2,
        tasksCompleted: 4,
        projectStatus: finalPlan?.overallStatus || 'unknown',
      },
      errors: errors.length > 0 ? errors : undefined,
    };
  } finally {
    cleanupSandbox(sandbox);
  }
}

/**
 * Main benchmark execution coordinator.
 */
export async function runBenchmarks(options: BenchmarkOptions = {}): Promise<BenchmarkReport> {
  const scenarioFilter = options.scenario ? options.scenario.toLowerCase().trim() : 'all';
  const concurrency = options.concurrency || 6;

  const scenariosToRun: Array<() => Promise<BenchmarkScenarioResult>> = [];

  if (scenarioFilter === 'all' || scenarioFilter === 'concurrency') {
    scenariosToRun.push(() => runConcurrencyScenario(concurrency));
  }
  if (scenarioFilter === 'all' || scenarioFilter === 'governor') {
    scenariosToRun.push(() => runGovernorScenario());
  }
  if (scenarioFilter === 'all' || scenarioFilter === 'verification') {
    scenariosToRun.push(() => runVerificationScenario());
  }
  if (scenarioFilter === 'all' || scenarioFilter === 'telemetry') {
    scenariosToRun.push(() => runTelemetryScenario());
  }
  if (scenarioFilter === 'all' || scenarioFilter === 'e2e' || scenarioFilter === 'e2e_pipeline') {
    scenariosToRun.push(() => runE2EPipelineScenario());
  }

  const results: BenchmarkScenarioResult[] = [];
  const overallStart = Date.now();

  for (const runner of scenariosToRun) {
    const res = await silent(() => runner());
    results.push(res);
  }

  const totalDurationMs = Date.now() - overallStart;
  const passedCount = results.filter((r) => r.status === 'passed').length;
  const totalOps = results.reduce((acc, r) => acc + r.operations, 0);
  const avgThroughput =
    results.length > 0
      ? Math.round((results.reduce((acc, r) => acc + r.throughputOpsPerSec, 0) / results.length) * 10) / 10
      : 0;
  const score = results.length > 0 ? Math.round((passedCount / results.length) * 100) : 0;

  const report: BenchmarkReport = {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    environment: {
      platform: process.platform,
      nodeVersion: process.version,
      cpuCount: os.cpus().length,
      arch: process.arch,
    },
    summary: {
      totalScenarios: results.length,
      passedScenarios: passedCount,
      failedScenarios: results.length - passedCount,
      score,
      totalDurationMs,
      totalOperations: totalOps,
      averageThroughputOpsPerSec: avgThroughput,
    },
    scenarios: results,
  };

  return report;
}

/**
 * Formats the benchmark report for high-readability CLI output.
 */
export function formatBenchmarkReport(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(pc.bold(pc.cyan('\n============================================================')));
  lines.push(pc.bold(pc.cyan('          NATIV LOCAL SYNTHETIC BENCHMARK SUITE             ')));
  lines.push(pc.bold(pc.cyan('============================================================')));
  lines.push(
    pc.dim('Environment: ') +
      pc.white(`${report.environment.platform} (${report.environment.arch})`) +
      pc.dim(' | Node: ') +
      pc.white(report.environment.nodeVersion) +
      pc.dim(' | CPUs: ') +
      pc.white(`${report.environment.cpuCount}`)
  );
  lines.push(pc.dim('Timestamp:   ') + pc.white(report.timestamp));
  lines.push('');

  lines.push(pc.bold('Benchmark Scenarios:'));
  for (const s of report.scenarios) {
    const badge = s.status === 'passed' ? pc.green('[PASS]') : pc.red('[FAIL]');
    const dur = (s.durationMs / 1000).toFixed(2);
    lines.push(`  ${badge} ${pc.bold(s.name)}`);
    lines.push(
      pc.dim(`         Throughput: `) +
        pc.yellow(`${s.throughputOpsPerSec} ops/sec`) +
        pc.dim(` (${s.operations} ops in ${dur}s)`)
    );
    lines.push(
      pc.dim(`         Assertions: `) +
        pc.green(`${s.assertionsPassed} passed`) +
        (s.assertionsFailed > 0 ? pc.red(`, ${s.assertionsFailed} failed`) : '')
    );

    if (s.details.meanLockWaitMs !== undefined) {
      lines.push(
        pc.dim(`         Lock Wait:  `) +
          pc.white(`mean ${s.details.meanLockWaitMs}ms | max ${s.details.maxLockWaitMs}ms`)
      );
    }
    if (s.details.totalCostUsd !== undefined) {
      lines.push(
        pc.dim(`         Telemetry:  `) +
          pc.white(`~$${s.details.totalCostUsd} USD (${s.details.totalTokens} tokens)`)
      );
    }
    if (s.errors && s.errors.length > 0) {
      for (const err of s.errors) {
        lines.push(pc.red(`         ✖ Error: ${err}`));
      }
    }
    lines.push('');
  }

  lines.push(pc.bold(pc.cyan('------------------------------------------------------------')));
  const scoreColor = report.summary.score === 100 ? pc.green : report.summary.score >= 80 ? pc.yellow : pc.red;
  lines.push(
    pc.bold('Benchmark Score:    ') +
      scoreColor(pc.bold(`${report.summary.score}%`)) +
      pc.dim(` (${report.summary.passedScenarios}/${report.summary.totalScenarios} scenarios passed)`)
  );
  lines.push(
    pc.bold('Total Operations:   ') +
      pc.white(`${report.summary.totalOperations}`) +
      pc.dim(` (${report.summary.averageThroughputOpsPerSec} avg ops/sec)`)
  );
  lines.push(
    pc.bold('Total Elapsed Time: ') +
      pc.white(`${(report.summary.totalDurationMs / 1000).toFixed(2)}s (${report.summary.totalDurationMs}ms)`)
  );
  lines.push(pc.bold(pc.cyan('============================================================\n')));

  return lines.join('\n');
}
