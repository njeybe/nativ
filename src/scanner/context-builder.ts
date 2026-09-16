import { ProjectInfo } from './types.js';

export function buildContextContent(template: string, info: ProjectInfo): string {
  const dirsFormatted = info.keyDirectories.length > 0
    ? info.keyDirectories.map(d => `  - \`${d}/\``).join('\n')
    : '  - *(Greenfield repository / root directory)*';

  const workspaceTopology = info.monorepoWorkspaces && info.monorepoWorkspaces.length > 0
    ? `Monorepo (${info.monorepoWorkspaces.join(', ')})`
    : 'Standalone Package / Monolith';

  const manifestsFormatted = info.ecosystemManifests && info.ecosystemManifests.length > 0
    ? info.ecosystemManifests.join(', ')
    : 'None detected';

  const ormConfigFormatted = info.detectedOrmConfig || 'None detected (Contract authority)';

  return template
    .replace(/\{\{PROJECT_NAME\}\}/g, info.projectName)
    .replace(/\{\{PROJECT_TYPE\}\}/g, info.projectType)
    .replace(/\{\{REPOSITORY_TYPE\}\}/g, info.repositoryType || info.projectType)
    .replace(/\{\{WORKSPACE_TOPOLOGY\}\}/g, workspaceTopology)
    .replace(/\{\{PROJECT_GOAL\}\}/g, info.projectGoal)
    .replace(/\{\{DETECTED_RUNTIME\}\}/g, info.runtime)
    .replace(/\{\{DETECTED_FRAMEWORK\}\}/g, info.framework)
    .replace(/\{\{DETECTED_DATABASE_ORM\}\}/g, info.databaseOrm)
    .replace(/\{\{DETECTED_ORM_CONFIG\}\}/g, ormConfigFormatted)
    .replace(/\{\{DETECTED_STYLING\}\}/g, info.styling)
    .replace(/\{\{DETECTED_TESTING\}\}/g, info.testing)
    .replace(/\{\{DETECTED_PACKAGE_MANAGER\}\}/g, info.packageManager)
    .replace(/\{\{ECOSYSTEM_MANIFESTS\}\}/g, manifestsFormatted)
    .replace(/\{\{SOURCE_ROOT\}\}/g, info.sourceRoot)
    .replace(/\{\{ARCHITECTURE_PATTERN\}\}/g, info.architecturePattern)
    .replace(/\{\{KEY_DIRECTORIES\}\}/g, dirsFormatted);
}
