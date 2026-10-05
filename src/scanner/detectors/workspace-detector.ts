import fs from 'node:fs';
import path from 'node:path';

export interface SubServiceInfo {
  name: string;
  dirPath: string;
  manifests: string[];
  tech: string;
  runtime?: string;
  framework?: string;
  orm?: string;
  ormConfig?: string;
}

export interface WorkspaceDetectionResult {
  monorepoIndicators: string[];
  monorepoWorkspaces: string[];
  keyDirectories: string[];
  detectedSubpackagesCount: number;
  independentServices: SubServiceInfo[];
  ecosystemManifests: string[];
}

export function detectWorkspacesAndServices(
  resolvedTarget: string,
  fileExists: (relPath: string) => boolean,
  readFileSafe: (filePath: string) => string
): WorkspaceDetectionResult {
  const monorepoIndicators: string[] = [];
  const monorepoWorkspaces: string[] = [];
  const keyDirectories: string[] = [];
  const ecosystemManifests: string[] = [];
  let detectedSubpackagesCount = 0;

  if (fileExists('pnpm-workspace.yaml')) {
    ecosystemManifests.push('pnpm-workspace.yaml');
    monorepoIndicators.push('pnpm workspaces');
    const pnpmWorkspace = readFileSafe(path.join(resolvedTarget, 'pnpm-workspace.yaml'));
    const packageLines = pnpmWorkspace
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('-'))
      .map((l) => l.replace(/^-\s*['"]?/, '').replace(/['"]?$/, '').trim());
    if (packageLines.length > 0) {
      monorepoWorkspaces.push(...packageLines);
    }
  }

  if (fileExists('turbo.json')) {
    ecosystemManifests.push('turbo.json');
    monorepoIndicators.push('Turborepo');
  }

  if (fileExists('nx.json')) {
    ecosystemManifests.push('nx.json');
    monorepoIndicators.push('Nx');
  }

  if (fileExists('lerna.json')) {
    ecosystemManifests.push('lerna.json');
    monorepoIndicators.push('Lerna');
  }

  const candidateWorkspaceDirs = ['apps', 'packages', 'services', 'libs', 'modules'];
  for (const wDir of candidateWorkspaceDirs) {
    const fullWDir = path.join(resolvedTarget, wDir);
    if (fs.existsSync(fullWDir) && fs.statSync(fullWDir).isDirectory()) {
      keyDirectories.push(wDir);
      if (!monorepoWorkspaces.includes(`${wDir}/*`)) {
        monorepoWorkspaces.push(`${wDir}/*`);
      }
      try {
        const children = fs.readdirSync(fullWDir);
        for (const child of children) {
          const childPath = path.join(fullWDir, child);
          if (fs.statSync(childPath).isDirectory()) {
            if (
              fs.existsSync(path.join(childPath, 'package.json')) ||
              fs.existsSync(path.join(childPath, 'go.mod')) ||
              fs.existsSync(path.join(childPath, 'pom.xml')) ||
              fs.existsSync(path.join(childPath, 'composer.json'))
            ) {
              detectedSubpackagesCount++;
            }
          }
        }
      } catch {
        // ignore read error
      }
    }
  }

  const independentServices: SubServiceInfo[] = [];

  try {
    const rootItems = fs.readdirSync(resolvedTarget);
    for (const item of rootItems) {
      if (
        item.startsWith('.') ||
        item === 'node_modules' ||
        item === 'vendor' ||
        item === 'dist' ||
        item === 'build' ||
        item === 'templates' ||
        item === 'bin' ||
        item === 'public'
      ) {
        continue;
      }

      const itemPath = path.join(resolvedTarget, item);
      if (fs.existsSync(itemPath) && fs.statSync(itemPath).isDirectory()) {
        const subPathItem = (filename: string) => fs.existsSync(path.join(itemPath, filename));

        const subManifests: string[] = [];
        if (subPathItem('package.json')) subManifests.push('package.json');
        if (subPathItem('composer.json')) subManifests.push('composer.json');
        if (subPathItem('go.mod')) subManifests.push('go.mod');
        if (subPathItem('Cargo.toml')) subManifests.push('Cargo.toml');
        if (subPathItem('pom.xml')) subManifests.push('pom.xml');
        if (subPathItem('build.gradle')) subManifests.push('build.gradle');
        if (subPathItem('build.gradle.kts')) subManifests.push('build.gradle.kts');
        if (subPathItem('pyproject.toml')) subManifests.push('pyproject.toml');
        if (subPathItem('requirements.txt')) subManifests.push('requirements.txt');
        if (subPathItem('pubspec.yaml')) subManifests.push('pubspec.yaml');
        if (subPathItem('Podfile')) subManifests.push('Podfile');
        if (subPathItem('AndroidManifest.xml')) subManifests.push('AndroidManifest.xml');

        if (subManifests.length > 0) {
          if (!keyDirectories.includes(item)) {
            keyDirectories.push(item);
          }

          let subTech = 'Service';
          let subRuntime = '';
          let subFramework = '';
          let subOrm = '';
          let subOrmConfig = '';

          if (subPathItem('pubspec.yaml')) {
            subTech = 'Flutter Mobile App';
            subRuntime = 'Dart / Flutter';
            subFramework = 'Flutter';
          } else if (subPathItem('Podfile') || subPathItem('Info.plist') || fs.existsSync(path.join(itemPath, 'ios'))) {
            subTech = 'Native iOS App (Swift/Obj-C)';
            subRuntime = 'Swift / Objective-C';
            subFramework = 'iOS Native';
          } else if (subPathItem('AndroidManifest.xml') || (subPathItem('build.gradle') && !subPathItem('package.json'))) {
            subTech = 'Native Android App (Kotlin/Java)';
            subRuntime = 'Kotlin / Java (Android)';
            subFramework = 'Android Native';
          } else if (subPathItem('composer.json')) {
            subRuntime = 'PHP';
            subTech = 'PHP Backend';
            try {
              const subComposer = JSON.parse(readFileSafe(path.join(itemPath, 'composer.json')));
              const allReq = { ...subComposer.require, ...subComposer['require-dev'] };
              if (allReq['laravel/framework']) {
                subFramework = 'Laravel';
                subTech = 'Laravel Backend (PHP)';
                subOrm = 'Eloquent ORM';
              } else if (allReq['symfony/framework-bundle']) {
                subFramework = 'Symfony';
                subTech = 'Symfony Backend (PHP)';
                subOrm = 'Doctrine ORM';
              }
            } catch {}
            if (fs.existsSync(path.join(itemPath, 'database/migrations'))) {
              subOrmConfig = `${item}/database/migrations`;
              if (!subOrm) subOrm = 'SQL Migrations';
            }
          } else if (subPathItem('pyproject.toml') || subPathItem('requirements.txt')) {
            subRuntime = 'Python';
            subTech = 'Python Backend';
            const pyStr = readFileSafe(path.join(itemPath, 'requirements.txt')) + readFileSafe(path.join(itemPath, 'pyproject.toml'));
            if (pyStr.includes('fastapi')) {
              subFramework = 'FastAPI';
              subTech = 'FastAPI Backend (Python)';
            } else if (pyStr.includes('django')) {
              subFramework = 'Django';
              subTech = 'Django Backend (Python)';
              subOrm = 'Django ORM';
            } else if (pyStr.includes('flask')) {
              subFramework = 'Flask';
              subTech = 'Flask Backend (Python)';
            }

            if (pyStr.includes('sqlalchemy') || fs.existsSync(path.join(itemPath, 'alembic.ini'))) {
              subOrm = 'SQLAlchemy';
              if (fs.existsSync(path.join(itemPath, 'alembic.ini'))) {
                subOrmConfig = `${item}/alembic.ini`;
              }
            }
          } else if (subPathItem('go.mod')) {
            subRuntime = 'Go';
            subTech = 'Go Backend';
            const goStr = readFileSafe(path.join(itemPath, 'go.mod'));
            if (goStr.includes('gin-gonic/gin')) {
              subFramework = 'Gin';
              subTech = 'Gin Backend (Go)';
            } else if (goStr.includes('gofiber/fiber')) {
              subFramework = 'Fiber';
              subTech = 'Fiber Backend (Go)';
            }
            if (goStr.includes('gorm.io/gorm')) subOrm = 'GORM';
          } else if (subPathItem('package.json')) {
            subRuntime = 'Node.js';
            subTech = 'Node.js Service';
            try {
              const subPkg = JSON.parse(readFileSafe(path.join(itemPath, 'package.json')));
              const subDeps = { ...subPkg.dependencies, ...subPkg.devDependencies };
              if (subDeps.typescript || fs.existsSync(path.join(itemPath, 'tsconfig.json'))) {
                subRuntime = 'Node.js (TypeScript)';
              }

              if (subDeps['react-native'] || subDeps['expo']) {
                subTech = 'React Native / Expo Mobile App';
                subFramework = subDeps.expo ? 'Expo Mobile App' : 'React Native';
              } else if (subDeps.next) {
                subTech = 'Next.js Web App';
                subFramework = 'Next.js';
              } else if (subDeps.nuxt) {
                subTech = 'Nuxt Web App';
                subFramework = 'Nuxt';
              } else if (subDeps.vite || subDeps.react || subDeps.vue) {
                subTech = 'React / Web Frontend';
                subFramework = subDeps.vite ? 'Vite Frontend' : (subDeps.react ? 'React SPA' : 'Vue SPA');
              } else if (subDeps.express || subDeps['@nestjs/core'] || subDeps.fastify) {
                subTech = 'Node.js Backend';
                subFramework = subDeps['@nestjs/core'] ? 'NestJS' : (subDeps.fastify ? 'Fastify' : 'Express.js');
              }

              if (subDeps.prisma || fs.existsSync(path.join(itemPath, 'prisma/schema.prisma'))) {
                subOrm = 'Prisma ORM';
                subOrmConfig = `${item}/prisma/schema.prisma`;
              } else if (subDeps['drizzle-orm'] || fs.existsSync(path.join(itemPath, 'drizzle.config.ts'))) {
                subOrm = 'Drizzle ORM';
                subOrmConfig = `${item}/drizzle.config.ts`;
              } else if (subDeps.typeorm) {
                subOrm = 'TypeORM';
              } else if (subDeps.mongoose) {
                subOrm = 'Mongoose';
              }
            } catch {
              subTech = 'Node.js / Web App';
            }
          }

          independentServices.push({
            name: item,
            dirPath: itemPath,
            manifests: subManifests,
            tech: subTech,
            runtime: subRuntime,
            framework: subFramework,
            orm: subOrm,
            ormConfig: subOrmConfig,
          });

          if (!monorepoWorkspaces.includes(`${item}/*`) && !candidateWorkspaceDirs.includes(item)) {
            monorepoWorkspaces.push(`${item}/*`);
          }
        }
      }
    }
  } catch {
    // ignore read error
  }

  return {
    monorepoIndicators,
    monorepoWorkspaces,
    keyDirectories,
    detectedSubpackagesCount,
    independentServices,
    ecosystemManifests,
  };
}
