import fs from 'node:fs';
import path from 'node:path';
import { ProjectInfo } from './types.js';
import { detectWorkspacesAndServices } from './detectors/workspace-detector.js';
import { detectEcosystems } from './detectors/ecosystem-detector.js';
import { detectOrm } from './detectors/orm-detector.js';

export function detectProject(targetDir: string): ProjectInfo {
  const resolvedTarget = path.resolve(targetDir);
  const baseName = path.basename(resolvedTarget);

  let projectName = baseName;
  let projectType = 'Generic Application';
  let projectGoal = 'Awaiting specification from the architect intake interview';
  let runtime = 'Unknown / Greenfield';
  let framework = 'None detected';
  let databaseOrm = 'None detected';
  let styling = 'None detected';
  let testing = 'None detected';
  let packageManager = 'None detected';
  let sourceRoot = '.';
  let architecturePattern = 'Modular / Layered';
  let verificationCommand = 'npm test';
  let repositoryType = 'Standard Monolith';

  const readFileSafe = (filePath: string): string => {
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8');
      }
    } catch {
      // ignore
    }
    return '';
  };

  const fileExists = (relPath: string): boolean => {
    return fs.existsSync(path.join(resolvedTarget, relPath));
  };

  // 1. Structure & Workspace Detection
  const wsResult = detectWorkspacesAndServices(resolvedTarget, fileExists, readFileSafe);
  const monorepoIndicators = [...wsResult.monorepoIndicators];
  const monorepoWorkspaces = [...wsResult.monorepoWorkspaces];
  const keyDirectories = [...wsResult.keyDirectories];
  const ecosystemManifests = [...wsResult.ecosystemManifests];
  const { detectedSubpackagesCount, independentServices } = wsResult;

  // 2. Language & Framework Profiling
  const ecoResult = detectEcosystems(resolvedTarget, baseName, fileExists, readFileSafe);
  if (ecoResult.projectName) projectName = ecoResult.projectName;
  if (ecoResult.projectGoal) projectGoal = ecoResult.projectGoal;
  if (ecoResult.projectType) projectType = ecoResult.projectType;
  if (ecoResult.runtime !== 'Unknown / Greenfield') runtime = ecoResult.runtime;
  if (ecoResult.framework !== 'None detected') framework = ecoResult.framework;
  if (ecoResult.databaseOrm !== 'None detected') databaseOrm = ecoResult.databaseOrm;
  if (ecoResult.styling !== 'None detected') styling = ecoResult.styling;
  if (ecoResult.testing !== 'None detected') testing = ecoResult.testing;
  if (ecoResult.packageManager !== 'None detected') packageManager = ecoResult.packageManager;
  if (ecoResult.verificationCommand) verificationCommand = ecoResult.verificationCommand;

  ecosystemManifests.push(...ecoResult.ecosystemManifests.filter((m) => !ecosystemManifests.includes(m)));
  monorepoWorkspaces.push(...ecoResult.monorepoWorkspaces.filter((w) => !monorepoWorkspaces.includes(w)));
  monorepoIndicators.push(...ecoResult.monorepoIndicators.filter((i) => !monorepoIndicators.includes(i)));

  // 3. Database & ORM Config Detection
  const ormResult = detectOrm(resolvedTarget, fileExists, databaseOrm);
  let detectedOrmConfig = ormResult.detectedOrmConfig;
  databaseOrm = ormResult.databaseOrm;

  // 4. Resolve Repository Type & Workspaces
  if (monorepoIndicators.length > 0 || detectedSubpackagesCount > 0) {
    const toolLabel = monorepoIndicators.length > 0 ? monorepoIndicators.join(' + ') : 'Directory Workspaces';
    repositoryType = `Monorepo (${toolLabel})`;
    if (detectedSubpackagesCount > 0) {
      architecturePattern = 'Monorepo / Multi-Package Modular';
    }
  } else if (ecosystemManifests.length === 0 && independentServices.length > 0) {
    repositoryType = 'Polyrepo / Multi-Service Workspace';
    projectType = 'Multi-Service Application Suite';
    architecturePattern = 'Polyrepo (Independent Sub-services)';

    const serviceRuntimes = [...new Set(independentServices.map((s) => s.runtime).filter(Boolean))];
    runtime = serviceRuntimes.length > 0 ? serviceRuntimes.join(' + ') : 'Polyglot / Multi-Runtime';

    const serviceSummaries = independentServices.map((s) => `${s.name} (${s.tech})`);
    framework = `Services detected: ${serviceSummaries.join(' | ')}`;

    const serviceOrms = [...new Set(independentServices.map((s) => s.orm).filter(Boolean))];
    if (serviceOrms.length > 0) {
      databaseOrm = serviceOrms.join(' + ');
    }

    const serviceConfigs = independentServices.map((s) => s.ormConfig).filter(Boolean);
    if (serviceConfigs.length > 0 && !detectedOrmConfig) {
      detectedOrmConfig = serviceConfigs.join(', ');
    }

    const allSubManifests = independentServices.flatMap((s) => s.manifests.map((m) => `${s.name}/${m}`));
    ecosystemManifests.push(...allSubManifests);

    verificationCommand = independentServices.map((s) => `cd ${s.name} && test`).join('; ');
  } else if (ecosystemManifests.length > 0) {
    repositoryType = 'Standard Monolith';
  } else {
    repositoryType = 'Generic Application (Greenfield)';
  }

  // 5. Check Key Directories & Source Root
  const candidateDirs = [
    'src', 'app', 'pages', 'components', 'lib', 'api',
    'controllers', 'routes', 'models', 'tests', 'test',
    'public', 'prisma', 'templates', 'bin',
  ];
  for (const dir of candidateDirs) {
    if (fileExists(dir) && !keyDirectories.includes(dir)) {
      keyDirectories.push(dir);
      if (dir === 'src' || dir === 'app') {
        sourceRoot = `./${dir}`;
      }
    }
  }

  return {
    projectName,
    projectType,
    projectGoal,
    runtime,
    framework,
    databaseOrm,
    styling,
    testing,
    packageManager,
    sourceRoot,
    architecturePattern,
    keyDirectories,
    verificationCommand,
    repositoryType,
    monorepoWorkspaces,
    detectedOrmConfig,
    ecosystemManifests,
  };
}
