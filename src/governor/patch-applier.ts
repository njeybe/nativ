import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AuditLogEntry, ContractPatch } from './types.js';

export function getContractHash(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

export function appendAuditLog(targetDir: string, entry: AuditLogEntry): void {
  const auditPath = path.join(targetDir, '.ai', 'audit_log.jsonl');
  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Non-fatal
  }
}

export function applyDbPatch(schema: any, patch: ContractPatch): any {
  const { operation, path: targetPath, value } = patch;
  const segments = targetPath.toLowerCase().split('.').filter(Boolean);
  const tableName = segments[0] === 'tables' ? segments[1] : segments[0];
  const targetType = segments.includes('columns')
    ? 'column'
    : (segments.includes('indexes') ? 'index' : (segments.includes('foreignkeys') ? 'foreignKey' : 'table'));
  const propertyName = segments.length > 2 ? segments[segments.length - 1] : undefined;

  schema.tables = schema.tables || [];

  if (operation === 'ADD') {
    if (targetType === 'table') {
      schema.tables.push(value || { name: tableName, columns: [], indexes: [], foreignKeys: [] });
    } else {
      const table = schema.tables.find((t: any) => t.name?.toLowerCase() === tableName.toLowerCase());
      if (table) {
        if (targetType === 'column') {
          table.columns = table.columns || [];
          table.columns.push(value || { name: propertyName, type: 'TEXT', nullable: true });
        } else if (targetType === 'index') {
          table.indexes = table.indexes || [];
          table.indexes.push(value);
        } else if (targetType === 'foreignKey') {
          table.foreignKeys = table.foreignKeys || [];
          table.foreignKeys.push(value);
        }
      }
    }
  } else if (operation === 'ALTER') {
    const table = schema.tables.find((t: any) => t.name?.toLowerCase() === tableName.toLowerCase());
    if (table && targetType === 'column' && propertyName) {
      const colIdx = table.columns?.findIndex((c: any) => c.name?.toLowerCase() === propertyName.toLowerCase());
      if (colIdx !== undefined && colIdx >= 0) {
        table.columns[colIdx] = { ...table.columns[colIdx], ...value };
      }
    }
  }

  schema.updatedAt = new Date().toISOString();
  return schema;
}

export function applyApiPatch(contracts: any, patch: ContractPatch): any {
  const { operation, path: targetPath, value } = patch;
  const segments = targetPath.toLowerCase().split('.').filter(Boolean);
  const endpointIdOrPath = segments[0] === 'endpoints' ? segments[1] : segments[0];

  contracts.endpoints = contracts.endpoints || [];

  if (operation === 'ADD') {
    const isEndpoint = segments.length <= 2 && value?.path && value?.method;
    if (isEndpoint) {
      contracts.endpoints.push(value);
    } else {
      const ep = contracts.endpoints.find(
        (e: any) =>
          e.id?.toLowerCase() === endpointIdOrPath.toLowerCase() ||
          e.path?.toLowerCase() === endpointIdOrPath.toLowerCase()
      );
      if (ep) {
        if (segments.includes('queryparams')) {
          ep.request = ep.request || {};
          ep.request.queryParams = ep.request.queryParams || {};
          ep.request.queryParams[segments[segments.length - 1]] = value;
        } else if (segments.includes('responses') || segments.includes('response')) {
          ep.responses = ep.responses || {};
          const status = segments.find((s: string) => /^\d{3}$/.test(s)) || '200';
          ep.responses[status] = ep.responses[status] || { description: 'Success', body: {} };
          if (typeof value === 'object' && value !== null) {
            ep.responses[status].body = { ...ep.responses[status].body, ...value };
          }
        }
      }
    }
  }

  contracts.updatedAt = new Date().toISOString();
  return contracts;
}

export function atomicWriteJson(filePath: string, data: any): boolean {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    if (fs.existsSync(tmpPath)) {
      fs.rmSync(tmpPath, { force: true });
    }
    return false;
  }
}

export function contractFileFor(target: ContractPatch['target']): string {
  return target === 'db_schema' ? 'db_schema.json' : 'api_contracts.json';
}

export function applyPatch(contract: any, patch: ContractPatch): any {
  return patch.target === 'db_schema' ? applyDbPatch(contract, patch) : applyApiPatch(contract, patch);
}
