import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

export const MCP_RESOURCES = [
  { name: 'context', uris: ['nativ://context'], file: 'context.md', mimeType: 'text/markdown', description: 'Project context, tech stack and guardrails (.ai/context.md)' },
  { name: 'master-plan', uris: ['nativ://master-plan'], file: 'master_plan.json', mimeType: 'application/json', description: 'Milestones, tasks and their status (.ai/master_plan.json)' },
  { name: 'db-schema', uris: ['nativ://db-schema'], file: 'db_schema.json', mimeType: 'application/json', description: 'Database schema contract (.ai/db_schema.json)' },
  { name: 'api-contracts', uris: ['nativ://api-contracts'], file: 'api_contracts.json', mimeType: 'application/json', description: 'API route and schema contracts (.ai/api_contracts.json)' },
  { name: 'escalation', uris: ['nativ://escalation'], file: 'escalation.json', mimeType: 'application/json', description: 'Tier-1 escalation records (.ai/escalation.json)' },
  { name: 'telemetry', uris: ['nativ://telemetry'], file: 'telemetry.json', mimeType: 'application/json', description: 'Execution duration, token usage and cost telemetry (.ai/telemetry.json)' },
] as const;

export function registerMcpResources(server: McpServer, targetDir: string): void {
  for (const res of MCP_RESOURCES) {
    for (const uriStr of res.uris) {
      server.registerResource(
        res.name,
        uriStr,
        { mimeType: res.mimeType, description: res.description },
        async (uri): Promise<ReadResourceResult> => {
          const filePath = path.join(targetDir, '.ai', res.file);
          let text: string;
          if (fs.existsSync(filePath)) {
            text = fs.readFileSync(filePath, 'utf8');
          } else if (res.name === 'escalation') {
            text = JSON.stringify({ escalations: [] }, null, 2);
          } else if (res.name === 'telemetry') {
            text = JSON.stringify(
              {
                version: '1.0.0',
                summary: {
                  totalTasksCompleted: 0,
                  totalDurationMs: 0,
                  estimatedTotalTokens: 0,
                  estimatedTotalCostUsd: 0,
                  verificationPassRate: 1.0,
                  circuitBreakerTrips: 0,
                },
                tasks: [],
              },
              null,
              2
            );
          } else {
            throw new Error(`.ai/${res.file} not found in ${targetDir}. Run nativ_init first.`);
          }
          return { contents: [{ uri: uri.href, mimeType: res.mimeType, text }] };
        },
      );
    }
  }
}
