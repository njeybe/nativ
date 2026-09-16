import { ProjectInfo } from './types.js';

export function buildContextContent(template: string, info: ProjectInfo): string {
  const dirsFormatted = info.keyDirectories.length > 0
    ? info.keyDirectories.map(d => `  - \`${d}/\``).join('\n')
    : '  - *(Greenfield repository / root directory)*';

  return template
    .replace(/\{\{PROJECT_NAME\}\}/g, info.projectName)
    .replace(/\{\{PROJECT_TYPE\}\}/g, info.projectType)
    .replace(/\{\{PROJECT_GOAL\}\}/g, info.projectGoal)
    .replace(/\{\{DETECTED_RUNTIME\}\}/g, info.runtime)
    .replace(/\{\{DETECTED_FRAMEWORK\}\}/g, info.framework)
    .replace(/\{\{DETECTED_DATABASE_ORM\}\}/g, info.databaseOrm)
    .replace(/\{\{DETECTED_STYLING\}\}/g, info.styling)
    .replace(/\{\{DETECTED_TESTING\}\}/g, info.testing)
    .replace(/\{\{DETECTED_PACKAGE_MANAGER\}\}/g, info.packageManager)
    .replace(/\{\{SOURCE_ROOT\}\}/g, info.sourceRoot)
    .replace(/\{\{ARCHITECTURE_PATTERN\}\}/g, info.architecturePattern)
    .replace(/\{\{KEY_DIRECTORIES\}\}/g, dirsFormatted);
}
