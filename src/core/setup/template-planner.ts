import fs from 'node:fs';
import path from 'node:path';
import {
  AssetAction,
  TemplateFilePlan,
  stampManaged,
  managedState,
} from './types.js';
import { isLegacyTemplate, normalizeForHash } from '../legacy-templates.js';

/**
 * Decides what to do with a file derived from a template (a directive or a role guide).
 * Missing files are created; files nativ wrote and nobody edited (marker intact, or matching a template nativ
 * shipped before markers existed) follow the template; anything edited by hand is kept unless `force` is set.
 * `legacyKey` names the file in LEGACY_TEMPLATE_HASHES.
 */
export function planTemplateFile(existing: string | null, template: string, legacyKey: string, force = false): TemplateFilePlan {
  const next = stampManaged(template);
  if (existing === null) return { action: 'created', content: next };
  if (existing === next) return { action: 'unchanged' };

  const state = managedState(existing);
  if (state === 'pristine') return { action: 'updated', detail: 'template updated', content: next };
  if (state === 'unmanaged') {
    if (normalizeForHash(existing) === normalizeForHash(template)) return { action: 'updated', detail: 'now tracked by nativ', content: next };
    if (isLegacyTemplate(legacyKey, existing)) return { action: 'updated', detail: 'refreshed from an earlier nativ template', content: next };
  }
  if (force) return { action: 'updated', detail: 'forced', content: next };
  return {
    action: 'skipped',
    detail:
      state === 'modified'
        ? 'edited by hand (use --force to replace)'
        : 'not an untouched nativ template, so treated as edited by hand (use --force to replace)',
  };
}
