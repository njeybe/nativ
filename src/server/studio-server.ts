import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { DatabaseEnv } from '../db/types.js';
import { detectExampleDbKeys, resolveConnections } from '../db/env-parser.js';
import { resolveProjectRoot } from '../core/root-resolver.js';
import { Tier1Liaison, type Tier1LiaisonOptions } from '../core/tier1-liaison.js';
import {
  AgentSupervisor,
  type AgentSupervisorOptions,
  type RunnerRecord,
  type RunnerTokenUsageEvent,
} from '../runner/agent-supervisor.js';

import {
  HttpError,
  LOOPBACK_HOSTS,
  readJsonBody,
  sendError,
  sendJson,
  sendPipelineError,
} from './http-utils.js';
import { AI_DIR } from './plan-utils.js';
import { DEFAULT_HEARTBEAT_MS, PipelineEventHub } from './event-hub.js';
import {
  StudioSession,
  handleConnect,
  handleDataDelete,
  handleDataGet,
  handleDataPost,
  handleDataPut,
  handleDiff,
  handleExportContract,
  handleSchema,
  handleStatus,
  handleTestGenerate,
} from './routes/db-routes.js';
import {
  handlePipelineStatus,
  handlePipelineTasks,
  handleTaskAbort,
  handleTaskAction,
  handleTaskDispatch,
  handleTaskLogs,
  handleTaskRuns,
  runView,
} from './routes/task-routes.js';
import {
  describeWorktrees,
  handleWorktreeAction,
  handleWorktreeDiff,
} from './routes/worktree-routes.js';
import {
  createBenchmarkRunner,
  handleBenchmarks,
  handleTelemetryDetailed,
} from './routes/telemetry-routes.js';
import {
  handleEscalationResolve,
  handleEscalations,
  handleTriageConfig,
  handleTriageEvaluate,
  runAutoTriageQueue,
  triageView,
} from './routes/triage-routes.js';

export const DEFAULT_STUDIO_PORT = 4983;

// Re-exports for backwards compatibility
export { DEFAULT_HEARTBEAT_MS, PipelineEventHub } from './event-hub.js';
export { writeContractSchema } from './routes/db-routes.js';
export { HttpError } from './http-utils.js';

export interface StudioServerOptions {
  port?: number;
  host?: string;
  cwd?: string;
  /** Dashboard HTML served at `/`. */
  html?: string | (() => string);
  /** Pre-seeded connection URLs; defaults to those resolved from .env files. */
  connections?: Partial<Record<DatabaseEnv, string | null>>;
  /** Interval between `heartbeat` events on /api/events. Defaults to 15s. */
  heartbeatMs?: number;
  /** Agent supervisor tuning (runner command, timeout budget, log buffer size). `cwd` is always the project root. */
  supervisor?: Omit<AgentSupervisorOptions, 'cwd'>;
  /** Tier 1 strategist transport (API key, model, fetch). Defaults to GEMINI_API_KEY and native fetch. */
  triage?: Tier1LiaisonOptions;
}

export interface StudioServerHandle {
  server: http.Server;
  url: string;
  port: number;
  close(): Promise<void>;
}

function hostnameOf(value: string): string {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return '';
  }
}

/** Blocks DNS-rebinding and cross-site requests: only loopback Host/Origin are accepted. */
function assertLocalRequest(req: http.IncomingMessage): void {
  const host = hostnameOf(String(req.headers.host ?? ''));
  if (!LOOPBACK_HOSTS.has(host)) throw new HttpError(403, 'FORBIDDEN_HOST', 'Studio only accepts requests addressed to localhost');
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && !LOOPBACK_HOSTS.has(hostnameOf(origin))) {
    throw new HttpError(403, 'FORBIDDEN_ORIGIN', 'Cross-origin requests are not allowed');
  }
}

export function createStudioServer(options: StudioServerOptions = {}): http.Server {
  const cwd = options.cwd ?? process.cwd();
  const resolved = options.connections ? null : resolveConnections(cwd);
  const initialMeta = resolved
    ? {
        dev: resolved.dev
          ? {
              sourceKey: resolved.dev.sourceKey,
              detectedFromExample: resolved.dev.detectedFromExample,
              exampleFile: resolved.dev.exampleFile,
              synthesized: resolved.dev.synthesized,
            }
          : null,
        prod: resolved.prod
          ? {
              sourceKey: resolved.prod.sourceKey,
              detectedFromExample: resolved.prod.detectedFromExample,
              exampleFile: resolved.prod.exampleFile,
              synthesized: resolved.prod.synthesized,
            }
          : null,
      }
    : undefined;
  const session = new StudioSession(
    options.connections ?? { dev: resolved?.dev?.url ?? null, prod: resolved?.prod?.url ?? null },
    cwd,
    initialMeta,
  );

  const renderHtml = () => {
    if (typeof options.html === 'function') return options.html();
    return options.html ?? '<!doctype html><title>nativ DB Studio</title><p>Studio API is running. See /api/status.</p>';
  };

  // Pipeline endpoints read the project that owns .ai/ (climbing out of .worktrees/task-* when needed).
  const root = resolveProjectRoot(cwd);
  // Tier 1 strategist: settings and counters live for this server session only.
  const liaison = new Tier1Liaison(root, options.triage);
  const triageInFlight = new Map<string, Promise<ReturnType<typeof triageView>>>();

  let autoTriageTimer: NodeJS.Timeout | null = null;
  const scheduleAutoTriage = () => {
    if (autoTriageTimer) clearTimeout(autoTriageTimer);
    autoTriageTimer = setTimeout(() => {
      autoTriageTimer = null;
      runAutoTriageQueue(root, liaison, triageInFlight).catch(() => {});
    }, 150);
    autoTriageTimer.unref();
  };

  const heartbeatMs = options.heartbeatMs && options.heartbeatMs > 0 ? options.heartbeatMs : DEFAULT_HEARTBEAT_MS;
  const events = new PipelineEventHub(path.join(root, AI_DIR), heartbeatMs, (file) => {
    if (file === 'escalation.json') {
      scheduleAutoTriage();
    }
  });

  // Background agent runs: lifecycle phases, stdout/stderr chunks and per-turn token usage
  // (native engine) fan out over /api/events.
  const supervisor = new AgentSupervisor({ ...options.supervisor, cwd: root });
  supervisor.on('runner_status', (record: RunnerRecord) => events.publish('runner_status', runView(record)));
  supervisor.on('runner_log', (entry: unknown) => events.publish('runner_log', entry));
  supervisor.on('runner_token_usage', (usage: RunnerTokenUsageEvent) => events.publish('runner_token_usage', usage));

  // Concurrent "Run Benchmark" requests share one in-flight run.
  const runBenchmarkSuite = createBenchmarkRunner(root);

  const server = http.createServer(async (req, res) => {
    let pathname = '';
    try {
      assertLocalRequest(req);
      const url = new URL(req.url ?? '/', 'http://localhost');
      pathname = url.pathname;
      const fresh = url.searchParams.get('refresh') === '1';
      const route = `${req.method ?? 'GET'} ${url.pathname.replace(/\/+$/, '') || '/'}`;

      switch (route) {
        case 'GET /':
        case 'GET /index.html': {
          const html = renderHtml();
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': Buffer.byteLength(html),
            'Cache-Control': 'no-store',
            'X-Frame-Options': 'DENY',
            // https: images are allowed for media thumbnails; never leak the studio URL to those hosts.
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy':
              "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'",
          });
          res.end(html);
          return;
        }
        case 'GET /api/status':
          return sendJson(res, 200, await handleStatus(session, fresh));
        case 'GET /api/env-info': {
          // fragmentedConfig is display-safe: host, port, user, database, hasPassword and a masked URL only.
          const info = detectExampleDbKeys(cwd);
          return sendJson(res, 200, { ...info, fragmentedDetected: info.fragmentedDetected ?? false, fragmentedConfig: info.fragmentedConfig ?? null });
        }
        case 'GET /api/schema':
          return sendJson(res, 200, await handleSchema(session, url.searchParams.get('env'), fresh));
        case 'GET /api/diff':
          return sendJson(res, 200, await handleDiff(session, cwd, url.searchParams.get('target'), fresh));
        case 'POST /api/connect':
          return sendJson(res, 200, await handleConnect(session, await readJsonBody(req)));
        case 'POST /api/export-contract':
          return sendJson(res, 200, await handleExportContract(session, cwd, await readJsonBody(req)));
        case 'GET /api/data':
          return sendJson(res, 200, await handleDataGet(session, url.searchParams));
        case 'POST /api/data':
          return sendJson(res, 200, await handleDataPost(session, cwd, await readJsonBody(req), req));
        case 'PUT /api/data':
          return sendJson(res, 200, await handleDataPut(session, cwd, await readJsonBody(req), req));
        case 'DELETE /api/data':
          return sendJson(res, 200, await handleDataDelete(session, cwd, await readJsonBody(req), req));
        case 'POST /api/tests/generate':
          return sendJson(res, 200, handleTestGenerate(cwd, await readJsonBody(req)));
        case 'GET /api/events':
          events.subscribe(res);
          return;
        case 'GET /api/pipeline/status':
          return sendJson(res, 200, handlePipelineStatus(root));
        case 'GET /api/pipeline/tasks':
          return sendJson(res, 200, handlePipelineTasks(root));
        case 'POST /api/pipeline/tasks/action':
          return sendJson(res, 200, await handleTaskAction(root, await readJsonBody(req)));
        case 'POST /api/pipeline/tasks/dispatch':
          return sendJson(res, 200, await handleTaskDispatch(supervisor, await readJsonBody(req)));
        case 'POST /api/pipeline/tasks/abort':
          return sendJson(res, 200, await handleTaskAbort(supervisor, await readJsonBody(req)));
        case 'GET /api/pipeline/tasks/runs':
          return sendJson(res, 200, handleTaskRuns(supervisor, url.searchParams));
        case 'GET /api/pipeline/tasks/logs':
          return sendJson(res, 200, handleTaskLogs(supervisor, url.searchParams));
        case 'GET /api/pipeline/worktrees':
          return sendJson(res, 200, { ok: true, worktrees: await describeWorktrees(root) });
        case 'POST /api/pipeline/worktrees/action':
          return sendJson(res, 200, await handleWorktreeAction(root, await readJsonBody(req)));
        case 'GET /api/pipeline/worktrees/diff':
          return sendJson(res, 200, await handleWorktreeDiff(root, url.searchParams));
        case 'GET /api/pipeline/benchmarks':
          return sendJson(res, 200, handleBenchmarks(root));
        case 'POST /api/pipeline/benchmarks/run':
          return sendJson(res, 200, { ok: true, report: await runBenchmarkSuite() });
        case 'GET /api/pipeline/telemetry/detailed':
          return sendJson(res, 200, handleTelemetryDetailed(root, supervisor));
        case 'GET /api/pipeline/escalations':
          return sendJson(res, 200, handleEscalations(root, url.searchParams));
        case 'POST /api/pipeline/escalations/resolve':
          return sendJson(res, 200, await handleEscalationResolve(root, await readJsonBody(req)));
        case 'POST /api/pipeline/triage/evaluate':
          return sendJson(res, 200, await handleTriageEvaluate(root, liaison, triageInFlight, await readJsonBody(req)));
        case 'GET /api/pipeline/triage/status':
          return sendJson(res, 200, liaison.getStatus());
        case 'POST /api/pipeline/triage/config':
          return sendJson(res, 200, handleTriageConfig(liaison, await readJsonBody(req), scheduleAutoTriage));
        case 'GET /favicon.ico':
          res.writeHead(204).end();
          return;
      }

      if (url.pathname.startsWith('/api/')) {
        const known = [
          '/api/status', '/api/env-info', '/api/schema', '/api/diff', '/api/connect', '/api/export-contract', '/api/data', '/api/tests/generate',
          '/api/events', '/api/pipeline/status', '/api/pipeline/tasks', '/api/pipeline/tasks/action', '/api/pipeline/tasks/dispatch',
          '/api/pipeline/tasks/abort', '/api/pipeline/tasks/runs', '/api/pipeline/tasks/logs', '/api/pipeline/worktrees',
          '/api/pipeline/worktrees/action', '/api/pipeline/worktrees/diff', '/api/pipeline/benchmarks', '/api/pipeline/benchmarks/run',
          '/api/pipeline/telemetry/detailed', '/api/pipeline/escalations', '/api/pipeline/escalations/resolve',
          '/api/pipeline/triage/evaluate', '/api/pipeline/triage/status', '/api/pipeline/triage/config',
        ];
        if (known.includes(url.pathname.replace(/\/+$/, ''))) throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${req.method} not allowed on ${url.pathname}`);
        throw new HttpError(404, 'NOT_FOUND', `No route for ${url.pathname}`);
      }
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    } catch (err) {
      const send = pathname.startsWith('/api/pipeline/') ? sendPipelineError : sendError;
      if (err instanceof HttpError) return send(res, err.status, err.code, err.message);
      // Unexpected failures: generic message only, to avoid echoing anything credential-bearing.
      session.invalidate();
      return send(res, 500, 'INTERNAL_ERROR', 'Unexpected studio server error');
    }
  });

  // Open SSE streams and in-flight agent runners would otherwise keep close() waiting forever.
  const closeServer = server.close.bind(server);
  server.close = ((callback?: (err?: Error) => void) => {
    supervisor.shutdown('Studio server shutting down');
    events.close();
    return closeServer(callback);
  }) as typeof server.close;

  return server;
}

/** Starts the studio on loopback, trying up to 10 consecutive ports if the preferred one is busy. */
export async function startStudioServer(options: StudioServerOptions = {}): Promise<StudioServerHandle> {
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(hostnameOf(host))) throw new Error('Studio server may only bind to a loopback address');
  const basePort = options.port ?? DEFAULT_STUDIO_PORT;
  const server = createStudioServer(options);

  for (let attempt = 0; attempt < 10; attempt++) {
    const port = basePort === 0 ? 0 : basePort + attempt;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      const actualPort = (server.address() as AddressInfo).port;
      return {
        server,
        port: actualPort,
        url: `http://localhost:${actualPort}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || basePort === 0) throw err;
    }
  }
  throw new Error(`No free port found in range ${basePort}-${basePort + 9}`);
}
