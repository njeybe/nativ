import { ContractPatch, RuleEvaluationResult } from '../types.js';

export function evaluateApiPatch(patch: ContractPatch, currentContracts: any): RuleEvaluationResult {
  const violations: string[] = [];
  const { operation, path, value } = patch;
  const normalizedPath = path.trim().toLowerCase();

  const endpoints: any[] = currentContracts?.endpoints || [];

  // Parse path: e.g. "endpoints.user-login" or "endpoints./users.get.responses.200.body.avatar"
  const segments = normalizedPath.split('.').filter(Boolean);
  const endpointIdOrPath = segments[0] === 'endpoints' ? segments[1] : segments[0];

  const existingEndpoint = endpoints.find(
    (ep: any) =>
      ep.id?.toLowerCase() === endpointIdOrPath?.toLowerCase() ||
      ep.path?.toLowerCase() === endpointIdOrPath?.toLowerCase() ||
      `${ep.method?.toLowerCase()} ${ep.path?.toLowerCase()}` === endpointIdOrPath?.toLowerCase()
  );

  // Rule 1: Path Collision & Target Checks
  if (operation === 'ADD') {
    const isNewEndpoint = segments.length <= 2 && (!existingEndpoint || (value?.method && value?.path));
    if (isNewEndpoint && existingEndpoint && value?.method?.toUpperCase() === existingEndpoint.method?.toUpperCase()) {
      violations.push(`PATH_COLLISION: Endpoint '${existingEndpoint.method} ${existingEndpoint.path}' already exists. Use ALTER.`);
    }
  } else if (operation === 'ALTER' || operation === 'DROP') {
    if (!existingEndpoint && segments[0] === 'endpoints' && segments.length <= 2) {
      violations.push(`TARGET_NOT_FOUND: Cannot ${operation.toLowerCase()} non-existent endpoint '${endpointIdOrPath}'.`);
    }
  }

  if (violations.length > 0) {
    return {
      approved: false,
      blastRadius: 'HIGH_DESTRUCTIVE',
      ruleId: 'API_COLLISION_OR_TARGET_MISMATCH',
      message: violations[0],
      violations,
    };
  }

  // Rule 2: DROP operations
  if (operation === 'DROP') {
    const isDroppingEndpoint = segments.length <= 2;
    const msg = isDroppingEndpoint
      ? `CANNOT_DROP_ENDPOINT: Dropping endpoint '${existingEndpoint?.method || ''} ${existingEndpoint?.path || endpointIdOrPath}' causes immediate 404 client breakage.`
      : `CANNOT_DROP_RESPONSE_FIELD: Dropping field on '${path}' causes client runtime deserialization failures.`;
    violations.push(msg);
    return {
      approved: false,
      blastRadius: 'HIGH_DESTRUCTIVE',
      ruleId: 'API_DROP_FORBIDDEN',
      message: msg,
      violations,
    };
  }

  // Rule 3: RENAME operations
  if (operation === 'RENAME') {
    const msg = `CANNOT_RENAME_API_ROUTE: Renaming route/path '${endpointIdOrPath}' breaks consumer integration.`;
    violations.push(msg);
    return {
      approved: false,
      blastRadius: 'HIGH_DESTRUCTIVE',
      ruleId: 'API_RENAME_FORBIDDEN',
      message: msg,
      violations,
    };
  }

  // Rule 4: ALTER operations
  if (operation === 'ALTER') {
    // Auth policy mutation (unauthorized client break)
    if (segments.includes('auth') && existingEndpoint) {
      if (existingEndpoint.auth === false && (value === true || value?.auth === true)) {
        violations.push(`CANNOT_RESTRICT_AUTH: Changing endpoint from public to authenticated breaks unauthenticated consumers.`);
      }
    }

    // Changing HTTP method
    if (segments.includes('method') && existingEndpoint && value && value.toUpperCase() !== existingEndpoint.method?.toUpperCase()) {
      violations.push(`CANNOT_ALTER_HTTP_METHOD: Changing HTTP method from ${existingEndpoint.method} to ${value} breaks client calls.`);
    }

    if (violations.length > 0) {
      return {
        approved: false,
        blastRadius: 'HIGH_DESTRUCTIVE',
        ruleId: 'API_ALTER_DESTRUCTIVE',
        message: violations[0],
        violations,
      };
    }
  }

  // Rule 5: ADD operations
  if (operation === 'ADD') {
    // Adding a brand new endpoint
    const isNewEndpoint = (segments.length <= 2 && !existingEndpoint) || (value?.path && value?.method);
    if (isNewEndpoint) {
      return {
        approved: true,
        blastRadius: 'LOW_ADDITIVE',
        ruleId: 'API_ADD_ENDPOINT_APPROVED',
        message: `Approved: Adding new endpoint '${value?.method || 'GET'} ${value?.path || endpointIdOrPath}' is backward-compatible.`,
        violations: [],
      };
    }

    // Adding request parameter/field
    const isRequestMutation = segments.includes('request') || segments.includes('queryparams') || segments.includes('headers') || segments.includes('body');
    if (isRequestMutation) {
      // Check if required
      const isRequired =
        value?.required === true ||
        (typeof value === 'string' && value.toLowerCase().includes('required')) ||
        (value?.nullable === false && value?.default === undefined);

      if (isRequired) {
        const msg = `CANNOT_ADD_REQUIRED_REQUEST_FIELD: Adding a required parameter or field to '${path}' causes existing client requests to fail with 400 Bad Request.`;
        violations.push(msg);
        return {
          approved: false,
          blastRadius: 'HIGH_DESTRUCTIVE',
          ruleId: 'API_ADD_REQUIRED_FORBIDDEN',
          message: msg,
          violations,
        };
      }

      return {
        approved: true,
        blastRadius: 'LOW_ADDITIVE',
        ruleId: 'API_ADD_OPTIONAL_REQUEST_FIELD_APPROVED',
        message: `Approved: Adding optional request field to '${path}'.`,
        violations: [],
      };
    }

    // Adding response field or response status code (Postel's Law)
    const isResponseMutation = segments.includes('responses') || segments.includes('response') || segments.includes('body');
    if (isResponseMutation) {
      return {
        approved: true,
        blastRadius: 'LOW_ADDITIVE',
        ruleId: 'API_ADD_RESPONSE_FIELD_APPROVED',
        message: `Approved: Adding response property or status code to '${path}' (conforms to Postel's Law).`,
        violations: [],
      };
    }
  }

  return {
    approved: true,
    blastRadius: 'LOW_ADDITIVE',
    ruleId: 'API_DEFAULT_ADDITIVE',
    message: `API operation '${operation}' on '${path}' approved as safe.`,
    violations: [],
  };
}
