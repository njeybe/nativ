import { ContractPatch, RuleEvaluationResult } from '../types.js';

export function evaluateDbPatch(patch: ContractPatch, currentSchema: any): RuleEvaluationResult {
  const violations: string[] = [];
  const { operation, path, value } = patch;
  const normalizedPath = path.trim().toLowerCase();

  // Helper: Find table by name
  const tables: any[] = currentSchema?.tables || [];

  // Parse path: e.g. "tables.users.columns.bio" or "users.columns.bio" or "users.columns"
  const segments = normalizedPath.split('.').filter(Boolean);
  const tableName = segments[0] === 'tables' ? segments[1] : segments[0];
  const targetType = segments.includes('columns') ? 'column' : (segments.includes('indexes') ? 'index' : (segments.includes('foreignkeys') ? 'foreignKey' : 'table'));
  const propertyName = segments.length > 2 ? segments[segments.length - 1] : undefined;

  const existingTable = tables.find((t: any) => t.name?.toLowerCase() === tableName?.toLowerCase());
  const existingColumn = existingTable?.columns?.find((c: any) => c.name?.toLowerCase() === propertyName?.toLowerCase());

  // Rule 1: Path Collision & Existence Checks
  if (operation === 'ADD') {
    if (targetType === 'table' && existingTable) {
      violations.push(`PATH_COLLISION: Table '${tableName}' already exists in .ai/db_schema.json. Use ALTER.`);
    } else if (targetType === 'column' && existingColumn) {
      violations.push(`PATH_COLLISION: Column '${propertyName}' already exists on table '${tableName}'. Use ALTER.`);
    }
  } else if (operation === 'ALTER' || operation === 'DROP') {
    if (targetType === 'table' && !existingTable) {
      violations.push(`TARGET_NOT_FOUND: Cannot ${operation.toLowerCase()} non-existent table '${tableName}'.`);
    } else if (targetType === 'column' && !existingColumn) {
      violations.push(`TARGET_NOT_FOUND: Cannot ${operation.toLowerCase()} non-existent column '${propertyName}' on table '${tableName}'.`);
    }
  }

  // If path collision or missing target detected, exit immediately with High Destructive
  if (violations.length > 0) {
    return {
      approved: false,
      blastRadius: 'HIGH_DESTRUCTIVE',
      ruleId: 'DB_COLLISION_OR_TARGET_MISMATCH',
      message: violations[0],
      violations,
    };
  }

  // Rule 2: DROP operations are always HIGH_DESTRUCTIVE
  if (operation === 'DROP') {
    const msg = targetType === 'table'
      ? `CANNOT_DROP_TABLE: Dropping table '${tableName}' results in permanent data loss and catastrophic runtime failures.`
      : `CANNOT_DROP_COLUMN: Dropping column '${propertyName}' on table '${tableName}' causes data loss and breaks existing queries.`;
    violations.push(msg);
    return {
      approved: false,
      blastRadius: 'HIGH_DESTRUCTIVE',
      ruleId: 'DB_DROP_FORBIDDEN',
      message: msg,
      violations,
    };
  }

  // Rule 3: RENAME operations are HIGH_DESTRUCTIVE
  if (operation === 'RENAME') {
    const msg = `CANNOT_RENAME_${targetType.toUpperCase()}: Renaming '${propertyName || tableName}' breaks existing queries and ORM mappings.`;
    violations.push(msg);
    return {
      approved: false,
      blastRadius: 'HIGH_DESTRUCTIVE',
      ruleId: 'DB_RENAME_FORBIDDEN',
      message: msg,
      violations,
    };
  }

  // Rule 4: ALTER operations
  if (operation === 'ALTER') {
    if (targetType === 'column') {
      // Nullability tightening: nullable -> NOT NULL without default
      if (existingColumn && existingColumn.nullable !== false && value?.nullable === false && value?.default === undefined && existingColumn.default === undefined) {
        violations.push(`CANNOT_ENFORCE_NOT_NULL: Changing column '${propertyName}' to NOT NULL without a default value will cause runtime failures on existing rows.`);
      }

      // Column type change (narrowing or altering)
      if (existingColumn && value?.type && value.type.toUpperCase() !== existingColumn.type?.toUpperCase()) {
        violations.push(`CANNOT_MUTATE_COLUMN_TYPE: Altering column type from '${existingColumn.type}' to '${value.type}' carries data corruption or truncation risk.`);
      }

      if (violations.length > 0) {
        return {
          approved: false,
          blastRadius: 'HIGH_DESTRUCTIVE',
          ruleId: 'DB_ALTER_DESTRUCTIVE',
          message: violations[0],
          violations,
        };
      }
    }
  }

  // Rule 5: ADD operations
  if (operation === 'ADD') {
    // ADD TABLE
    if (targetType === 'table') {
      return {
        approved: true,
        blastRadius: 'LOW_ADDITIVE',
        ruleId: 'DB_ADD_TABLE_APPROVED',
        message: `Approved: Creating new table '${value?.name || tableName}' is backward-compatible.`,
        violations: [],
      };
    }

    // ADD COLUMN
    if (targetType === 'column') {
      const isNullable = value?.nullable !== false;
      const hasDefault = value?.default !== undefined && value?.default !== null;

      if (!isNullable && !hasDefault) {
        const msg = `CANNOT_ADD_REQUIRED_COLUMN_WITHOUT_DEFAULT: Column '${value?.name || propertyName}' cannot be NOT NULL without a default value.`;
        violations.push(msg);
        return {
          approved: false,
          blastRadius: 'HIGH_DESTRUCTIVE',
          ruleId: 'DB_ADD_NOT_NULL_FORBIDDEN',
          message: msg,
          violations,
        };
      }

      return {
        approved: true,
        blastRadius: 'LOW_ADDITIVE',
        ruleId: 'DB_ADD_COLUMN_APPROVED',
        message: `Approved: Adding additive column '${value?.name || propertyName}' to table '${tableName}'.`,
        violations: [],
      };
    }

    // ADD FOREIGN KEY (Referential integrity DAG check)
    if (targetType === 'foreignKey') {
      const targetTable = value?.targetTable || value?.referenceTable;
      const targetCol = value?.targetColumn || value?.referenceColumn;

      const refTableExists = tables.some((t: any) => t.name?.toLowerCase() === targetTable?.toLowerCase());
      if (!refTableExists) {
        const msg = `ORPHANED_FOREIGN_KEY: Target table '${targetTable}' does not exist in .ai/db_schema.json.`;
        violations.push(msg);
        return {
          approved: false,
          blastRadius: 'HIGH_DESTRUCTIVE',
          ruleId: 'DB_ORPHANED_FK_FORBIDDEN',
          message: msg,
          violations,
        };
      }

      // Check circular dependency: does targetTable have an existing FK back to this tableName?
      const targetTableObj = tables.find((t: any) => t.name?.toLowerCase() === targetTable?.toLowerCase());
      const hasCircularFk = targetTableObj?.foreignKeys?.some(
        (fk: any) => (fk.targetTable?.toLowerCase() === tableName?.toLowerCase() || fk.referenceTable?.toLowerCase() === tableName?.toLowerCase())
      );
      if (hasCircularFk && value?.nullable === false) {
        const msg = `CIRCULAR_DEPENDENCY: Circular non-nullable foreign key between '${tableName}' and '${targetTable}'.`;
        violations.push(msg);
        return {
          approved: false,
          blastRadius: 'HIGH_DESTRUCTIVE',
          ruleId: 'DB_CIRCULAR_FK_FORBIDDEN',
          message: msg,
          violations,
        };
      }

      return {
        approved: true,
        blastRadius: 'LOW_ADDITIVE',
        ruleId: 'DB_ADD_FOREIGN_KEY_APPROVED',
        message: `Approved: Foreign key on '${tableName}' referencing '${targetTable}' verified.`,
        violations: [],
      };
    }

    // ADD INDEX
    if (targetType === 'index') {
      return {
        approved: true,
        blastRadius: 'LOW_ADDITIVE',
        ruleId: 'DB_ADD_INDEX_APPROVED',
        message: `Approved: Adding index to table '${tableName}'.`,
        violations: [],
      };
    }
  }

  return {
    approved: true,
    blastRadius: 'LOW_ADDITIVE',
    ruleId: 'DB_DEFAULT_ADDITIVE',
    message: `Operation '${operation}' on '${path}' approved as safe.`,
    violations: [],
  };
}
