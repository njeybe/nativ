import fs from 'node:fs';
import path from 'node:path';
import { ProjectInfo } from './types.js';

export function detectProject(targetDir: string): ProjectInfo {
  const resolvedTarget = path.resolve(targetDir);
  const baseName = path.basename(resolvedTarget);

  let projectName = baseName;
  let projectType = 'Generic Application';
  let projectGoal = 'Awaiting specification from Antigravity intake interview';
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
  let detectedOrmConfig = '';
  const monorepoWorkspaces: string[] = [];
  const ecosystemManifests: string[] = [];
  const keyDirectories: string[] = [];

  // Helper safely reading file content
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

  // Helper checking existence
  const fileExists = (relPath: string): boolean => {
    return fs.existsSync(path.join(resolvedTarget, relPath));
  };

  // -------------------------------------------------------------
  // 1. Structure & Workspace Detection (Monorepo / Multi-service)
  // -------------------------------------------------------------
  const monorepoIndicators: string[] = [];

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

  // Check subdirectories: apps, packages, services, libs, modules
  const candidateWorkspaceDirs = ['apps', 'packages', 'services', 'libs', 'modules'];
  let detectedSubpackagesCount = 0;
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

  // -------------------------------------------------------------
  // Dynamic Polyrepo & Multi-Service Discovery
  // -------------------------------------------------------------
  interface SubServiceInfo {
    name: string;
    dirPath: string;
    manifests: string[];
    runtime?: string;
    framework?: string;
    orm?: string;
    ormConfig?: string;
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
        const subManifests: string[] = [];
        if (fs.existsSync(path.join(itemPath, 'package.json'))) subManifests.push('package.json');
        if (fs.existsSync(path.join(itemPath, 'composer.json'))) subManifests.push('composer.json');
        if (fs.existsSync(path.join(itemPath, 'go.mod'))) subManifests.push('go.mod');
        if (fs.existsSync(path.join(itemPath, 'Cargo.toml'))) subManifests.push('Cargo.toml');
        if (fs.existsSync(path.join(itemPath, 'pom.xml'))) subManifests.push('pom.xml');
        if (fs.existsSync(path.join(itemPath, 'build.gradle'))) subManifests.push('build.gradle');
        if (fs.existsSync(path.join(itemPath, 'build.gradle.kts'))) subManifests.push('build.gradle.kts');
        if (fs.existsSync(path.join(itemPath, 'pyproject.toml'))) subManifests.push('pyproject.toml');
        if (fs.existsSync(path.join(itemPath, 'requirements.txt'))) subManifests.push('requirements.txt');

        if (subManifests.length > 0) {
          if (!keyDirectories.includes(item)) {
            keyDirectories.push(item);
          }

          let subRuntime = '';
          let subFramework = '';
          let subOrm = '';
          let subOrmConfig = '';

          // Inspect sub-service stack
          if (subManifests.includes('package.json')) {
            subRuntime = 'Node.js';
            try {
              const subPkg = JSON.parse(readFileSafe(path.join(itemPath, 'package.json')));
              const subDeps = { ...subPkg.dependencies, ...subPkg.devDependencies };
              if (subDeps.typescript || fs.existsSync(path.join(itemPath, 'tsconfig.json'))) {
                subRuntime = 'Node.js (TypeScript)';
              }
              if (subDeps.next) subFramework = 'Next.js';
              else if (subDeps.nuxt) subFramework = 'Nuxt';
              else if (subDeps.vite) subFramework = 'Vite / React/Vue';
              else if (subDeps.express) subFramework = 'Express.js';
              else if (subDeps.fastify) subFramework = 'Fastify';
              else if (subDeps['@nestjs/core']) subFramework = 'NestJS';
              else if (subDeps.react) subFramework = 'React';
              else if (subDeps.vue) subFramework = 'Vue';
              else if (subDeps.svelte || subDeps['@sveltejs/kit']) subFramework = 'Svelte';

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
            } catch {}
          } else if (subManifests.includes('composer.json')) {
            subRuntime = 'PHP';
            try {
              const subComposer = JSON.parse(readFileSafe(path.join(itemPath, 'composer.json')));
              const allReq = { ...subComposer.require, ...subComposer['require-dev'] };
              if (allReq['laravel/framework']) {
                subFramework = 'Laravel';
                subOrm = 'Eloquent ORM';
              } else if (allReq['symfony/framework-bundle']) {
                subFramework = 'Symfony';
                subOrm = 'Doctrine ORM';
              }
            } catch {}
            if (fs.existsSync(path.join(itemPath, 'database/migrations'))) {
              subOrmConfig = `${item}/database/migrations`;
              if (!subOrm) subOrm = 'SQL Migrations';
            }
          } else if (subManifests.includes('pyproject.toml') || subManifests.includes('requirements.txt')) {
            subRuntime = 'Python';
            const pyStr = readFileSafe(path.join(itemPath, 'requirements.txt')) + readFileSafe(path.join(itemPath, 'pyproject.toml'));
            if (pyStr.includes('fastapi')) subFramework = 'FastAPI';
            else if (pyStr.includes('django')) {
              subFramework = 'Django';
              subOrm = 'Django ORM';
            } else if (pyStr.includes('flask')) subFramework = 'Flask';

            if (pyStr.includes('sqlalchemy') || fs.existsSync(path.join(itemPath, 'alembic.ini'))) {
              subOrm = 'SQLAlchemy';
              if (fs.existsSync(path.join(itemPath, 'alembic.ini'))) {
                subOrmConfig = `${item}/alembic.ini`;
              }
            }
          } else if (subManifests.includes('go.mod')) {
            subRuntime = 'Go';
            const goStr = readFileSafe(path.join(itemPath, 'go.mod'));
            if (goStr.includes('gin-gonic/gin')) subFramework = 'Gin';
            else if (goStr.includes('gofiber/fiber')) subFramework = 'Fiber';
            if (goStr.includes('gorm.io/gorm')) subOrm = 'GORM';
          }

          independentServices.push({
            name: item,
            dirPath: itemPath,
            manifests: subManifests,
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

  // -------------------------------------------------------------
  // 2. Language & Framework Profiling Across Ecosystems
  // -------------------------------------------------------------

  // --- Ecosystem A: Node.js / JavaScript / TypeScript ---
  const pkgPath = path.join(resolvedTarget, 'package.json');
  if (fileExists('package.json')) {
    ecosystemManifests.push('package.json');
    try {
      const pkg = JSON.parse(readFileSafe(pkgPath));
      if (pkg.name) projectName = pkg.name;
      if (pkg.description) projectGoal = pkg.description;

      // Check package.json workspaces
      if (pkg.workspaces) {
        if (Array.isArray(pkg.workspaces)) {
          monorepoWorkspaces.push(...pkg.workspaces);
        } else if (Array.isArray(pkg.workspaces.packages)) {
          monorepoWorkspaces.push(...pkg.workspaces.packages);
        }
        if (!monorepoIndicators.includes('npm/yarn workspaces')) {
          monorepoIndicators.push('npm/yarn workspaces');
        }
      }

      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Language & Runtime
      if (deps.typescript || fileExists('tsconfig.json')) {
        runtime = 'Node.js (TypeScript)';
        if (fileExists('tsconfig.json')) ecosystemManifests.push('tsconfig.json');
      } else {
        runtime = 'Node.js (JavaScript)';
      }

      // Frameworks
      if (deps.next) framework = `Next.js (${deps.next})`;
      else if (deps.nuxt) framework = `Nuxt (${deps.nuxt})`;
      else if (deps.remix || deps['@remix-run/react']) framework = 'Remix';
      else if (deps.astro) framework = 'Astro';
      else if (deps['@sveltejs/kit'] || deps.svelte) framework = 'Svelte / SvelteKit';
      else if (deps.vite) framework = 'Vite / React/Vue';
      else if (deps['@nestjs/core']) framework = 'NestJS';
      else if (deps.hono) framework = 'Hono';
      else if (deps.fastify) framework = 'Fastify';
      else if (deps.express) framework = 'Express.js';
      else if (deps['@angular/core']) framework = 'Angular';
      else if (deps.react) framework = 'React SPA';
      else if (deps.vue) framework = 'Vue.js SPA';

      // Database & ORMs in deps
      if (deps.prisma || deps['@prisma/client']) databaseOrm = 'Prisma ORM';
      else if (deps['drizzle-orm']) databaseOrm = 'Drizzle ORM';
      else if (deps.typeorm) databaseOrm = 'TypeORM';
      else if (deps.mongoose) databaseOrm = 'Mongoose / MongoDB';
      else if (deps.sequelize) databaseOrm = 'Sequelize';
      else if (deps.knex) databaseOrm = 'Knex';
      else if (deps['@supabase/supabase-js']) databaseOrm = 'Supabase Client';
      else if (deps.pg) databaseOrm = 'pg (node-postgres)';
      else if (deps.mysql2) databaseOrm = 'mysql2';
      else if (deps['better-sqlite3'] || deps.sqlite3) databaseOrm = 'SQLite';

      // Styling
      if (deps.tailwindcss) styling = 'Tailwind CSS';
      else if (deps['styled-components']) styling = 'Styled Components';
      else if (deps['@emotion/react']) styling = 'Emotion';
      else if (deps.sass) styling = 'SASS / SCSS';

      // Testing
      if (deps.vitest) {
        testing = 'Vitest';
        verificationCommand = 'npm run test';
      } else if (deps.jest) {
        testing = 'Jest';
        verificationCommand = 'npm test';
      } else if (deps.playwright || deps['@playwright/test']) {
        testing = 'Playwright';
        verificationCommand = 'npx playwright test';
      }

      // Package Manager
      if (fileExists('pnpm-lock.yaml')) {
        packageManager = 'pnpm';
        ecosystemManifests.push('pnpm-lock.yaml');
      } else if (fileExists('yarn.lock')) {
        packageManager = 'yarn';
        ecosystemManifests.push('yarn.lock');
      } else if (fileExists('bun.lockb') || fileExists('bun.lock')) {
        packageManager = 'bun';
        ecosystemManifests.push(fileExists('bun.lockb') ? 'bun.lockb' : 'bun.lock');
      } else if (fileExists('package-lock.json')) {
        packageManager = 'npm';
        ecosystemManifests.push('package-lock.json');
      } else {
        packageManager = 'npm';
      }

      // Verification command adjustment
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        verificationCommand = `${packageManager === 'npm' ? 'npm test' : `${packageManager} test`}`;
      } else if (pkg.scripts?.build) {
        verificationCommand = `${packageManager === 'npm' ? 'npm run build' : `${packageManager} build`}`;
      }

      projectType = framework !== 'None detected' ? `Web Application (${framework})` : 'Node.js Application';
    } catch {
      // ignore parse failure
    }
  }

  // --- Ecosystem B: PHP (composer.json) ---
  if (fileExists('composer.json')) {
    ecosystemManifests.push('composer.json');
    if (runtime === 'Unknown / Greenfield') {
      runtime = 'PHP';
      packageManager = 'composer';
      projectType = 'PHP Application';
      verificationCommand = 'composer test';
    }
    const composerRaw = readFileSafe(path.join(resolvedTarget, 'composer.json'));
    try {
      const composerPkg = JSON.parse(composerRaw);
      if (composerPkg.name && projectName === baseName) {
        projectName = composerPkg.name;
      }
      if (composerPkg.description && projectGoal.includes('Awaiting specification')) {
        projectGoal = composerPkg.description;
      }
      const allPhpDeps = { ...composerPkg.require, ...composerPkg['require-dev'] };
      if (allPhpDeps['laravel/framework']) {
        framework = 'Laravel';
        projectType = 'Laravel Web Application';
        databaseOrm = 'Eloquent ORM';
        verificationCommand = 'php artisan test';
      } else if (allPhpDeps['symfony/framework-bundle'] || allPhpDeps['symfony/symfony']) {
        framework = 'Symfony';
        projectType = 'Symfony Application';
        databaseOrm = 'Doctrine ORM';
        verificationCommand = 'bin/phpunit';
      } else if (allPhpDeps['slim/slim']) {
        framework = 'Slim Framework';
      } else if (allPhpDeps['roots/bedrock'] || composerRaw.includes('wordpress')) {
        framework = 'WordPress';
      }

      if (allPhpDeps['pestphp/pest']) {
        testing = 'Pest';
      } else if (allPhpDeps['phpunit/phpunit']) {
        testing = 'PHPUnit';
      }
    } catch {
      if (composerRaw.includes('laravel/framework')) {
        framework = 'Laravel';
        databaseOrm = 'Eloquent ORM';
      }
    }
  }

  // --- Ecosystem C: Python (pyproject.toml, requirements.txt, poetry.lock, Pipfile) ---
  const hasPyproject = fileExists('pyproject.toml');
  const hasRequirements = fileExists('requirements.txt');
  const hasPipfile = fileExists('Pipfile');
  if (hasPyproject || hasRequirements || hasPipfile) {
    if (hasPyproject) ecosystemManifests.push('pyproject.toml');
    if (hasRequirements) ecosystemManifests.push('requirements.txt');
    if (hasPipfile) ecosystemManifests.push('Pipfile');
    if (fileExists('poetry.lock')) ecosystemManifests.push('poetry.lock');
    if (fileExists('uv.lock')) ecosystemManifests.push('uv.lock');

    if (runtime === 'Unknown / Greenfield') {
      runtime = 'Python 3.x';
      projectType = 'Python Service / Application';
      packageManager = fileExists('poetry.lock')
        ? 'Poetry'
        : fileExists('uv.lock')
        ? 'uv'
        : fileExists('Pipfile')
        ? 'Pipenv'
        : 'pip';
      verificationCommand = 'pytest';
    }

    let pyContent = '';
    if (hasRequirements) pyContent += readFileSafe(path.join(resolvedTarget, 'requirements.txt'));
    if (hasPyproject) pyContent += readFileSafe(path.join(resolvedTarget, 'pyproject.toml'));

    if (pyContent.includes('fastapi')) framework = 'FastAPI';
    else if (pyContent.includes('django')) {
      framework = 'Django';
      databaseOrm = 'Django ORM';
      verificationCommand = 'python manage.py test';
    } else if (pyContent.includes('flask')) framework = 'Flask';
    else if (pyContent.includes('litestar')) framework = 'Litestar';

    if (pyContent.includes('sqlalchemy')) databaseOrm = 'SQLAlchemy';
    else if (pyContent.includes('tortoise-orm')) databaseOrm = 'Tortoise ORM';
    else if (pyContent.includes('sqlmodel')) databaseOrm = 'SQLModel';

    if (pyContent.includes('pytest')) testing = 'pytest';
  }

  // --- Ecosystem D: Go (go.mod) ---
  if (fileExists('go.mod')) {
    ecosystemManifests.push('go.mod');
    if (runtime === 'Unknown / Greenfield') {
      runtime = 'Go';
      projectType = 'Go Service';
      packageManager = 'go modules';
      verificationCommand = 'go test ./...';
    }
    const modContent = readFileSafe(path.join(resolvedTarget, 'go.mod'));
    const moduleMatch = modContent.match(/module\s+([^\s\n]+)/);
    if (moduleMatch && projectName === baseName) {
      projectName = path.basename(moduleMatch[1]);
    }
    if (modContent.includes('gin-gonic/gin')) framework = 'Gin';
    else if (modContent.includes('gofiber/fiber')) framework = 'Fiber';
    else if (modContent.includes('labstack/echo')) framework = 'Echo';
    else if (modContent.includes('go-chi/chi')) framework = 'Chi';

    if (modContent.includes('gorm.io/gorm')) databaseOrm = 'GORM';
    else if (modContent.includes('entgo.io/ent')) databaseOrm = 'Ent';
    else if (modContent.includes('jmoiron/sqlx')) databaseOrm = 'sqlx';
  }

  // --- Ecosystem E: Rust (Cargo.toml) ---
  if (fileExists('Cargo.toml')) {
    ecosystemManifests.push('Cargo.toml');
    if (runtime === 'Unknown / Greenfield') {
      runtime = 'Rust';
      projectType = 'Rust Application';
      packageManager = 'cargo';
      verificationCommand = 'cargo test';
    }
    const cargoContent = readFileSafe(path.join(resolvedTarget, 'Cargo.toml'));
    if (cargoContent.includes('actix-web')) framework = 'Actix Web';
    else if (cargoContent.includes('axum')) framework = 'Axum';
    else if (cargoContent.includes('rocket')) framework = 'Rocket';
    else if (cargoContent.includes('tauri')) framework = 'Tauri';

    if (cargoContent.includes('diesel')) databaseOrm = 'Diesel';
    else if (cargoContent.includes('sqlx')) databaseOrm = 'SQLx';
    else if (cargoContent.includes('sea-orm')) databaseOrm = 'SeaORM';
  }

  // --- Ecosystem F: Java / JVM (pom.xml, build.gradle) ---
  if (fileExists('pom.xml') || fileExists('build.gradle') || fileExists('build.gradle.kts')) {
    if (fileExists('pom.xml')) ecosystemManifests.push('pom.xml');
    if (fileExists('build.gradle')) ecosystemManifests.push('build.gradle');
    if (fileExists('build.gradle.kts')) ecosystemManifests.push('build.gradle.kts');

    if (runtime === 'Unknown / Greenfield') {
      runtime = 'Java / JVM';
      projectType = 'Java Service / Application';
      packageManager = fileExists('pom.xml') ? 'Maven' : 'Gradle';
      verificationCommand = fileExists('pom.xml') ? 'mvn test' : './gradlew test';
    }

    const jvmContent = readFileSafe(path.join(resolvedTarget, fileExists('pom.xml') ? 'pom.xml' : 'build.gradle'));
    if (jvmContent.includes('spring-boot')) framework = 'Spring Boot';
    else if (jvmContent.includes('quarkus')) framework = 'Quarkus';
    else if (jvmContent.includes('micronaut')) framework = 'Micronaut';

    if (jvmContent.includes('hibernate') || jvmContent.includes('spring-boot-starter-data-jpa')) {
      databaseOrm = 'Hibernate / JPA';
    }
  }

  // -------------------------------------------------------------
  // 3. Database & ORM Layer Detection (Config files & Migrations)
  // -------------------------------------------------------------
  if (fileExists('prisma/schema.prisma')) {
    detectedOrmConfig = 'prisma/schema.prisma';
    databaseOrm = 'Prisma ORM';
  } else if (fileExists('schema.prisma')) {
    detectedOrmConfig = 'schema.prisma';
    databaseOrm = 'Prisma ORM';
  }

  if (fileExists('drizzle.config.ts')) {
    detectedOrmConfig = 'drizzle.config.ts';
    databaseOrm = 'Drizzle ORM';
  } else if (fileExists('drizzle.config.js')) {
    detectedOrmConfig = 'drizzle.config.js';
    databaseOrm = 'Drizzle ORM';
  } else if (fileExists('drizzle.config.json')) {
    detectedOrmConfig = 'drizzle.config.json';
    databaseOrm = 'Drizzle ORM';
  }

  if (fileExists('knexfile.js')) {
    detectedOrmConfig = 'knexfile.js';
    databaseOrm = 'Knex';
  } else if (fileExists('knexfile.ts')) {
    detectedOrmConfig = 'knexfile.ts';
    databaseOrm = 'Knex';
  }

  if (fileExists('alembic.ini')) {
    detectedOrmConfig = 'alembic.ini';
    databaseOrm = databaseOrm === 'None detected' ? 'SQLAlchemy (Alembic)' : `${databaseOrm} (Alembic)`;
  }

  if (fileExists('database/migrations')) {
    const isDir = fs.statSync(path.join(resolvedTarget, 'database/migrations')).isDirectory();
    if (isDir) {
      detectedOrmConfig = 'database/migrations';
      if (databaseOrm === 'None detected') databaseOrm = 'SQL Migrations';
    }
  }

  if (fileExists('ormconfig.json')) {
    detectedOrmConfig = 'ormconfig.json';
    databaseOrm = 'TypeORM';
  }

  // -------------------------------------------------------------
  // 4. Resolve Repository Type & Workspaces
  // -------------------------------------------------------------
  if (monorepoIndicators.length > 0 || detectedSubpackagesCount > 0) {
    const toolLabel = monorepoIndicators.length > 0 ? monorepoIndicators.join(' + ') : 'Directory Workspaces';
    repositoryType = `Monorepo (${toolLabel})`;
    if (detectedSubpackagesCount > 0) {
      architecturePattern = 'Monorepo / Multi-Package Modular';
    }
  } else if (ecosystemManifests.length === 0 && independentServices.length > 0) {
    // Polyrepo / Multi-Service with no root manifest
    repositoryType = 'Polyrepo / Multi-Service Workspace';
    projectType = 'Multi-Service Application Suite';
    architecturePattern = 'Polyrepo (Independent Sub-services)';

    const serviceRuntimes = [...new Set(independentServices.map((s) => s.runtime).filter(Boolean))];
    runtime = serviceRuntimes.length > 0 ? serviceRuntimes.join(' + ') : 'Polyglot / Multi-Runtime';

    const serviceSummaries = independentServices.map((s) => {
      const details = [s.framework, s.runtime].filter(Boolean).join(', ');
      return details ? `${s.name} (${details})` : s.name;
    });
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

  // -------------------------------------------------------------
  // 5. Check Key Directories & Source Root
  // -------------------------------------------------------------
  const candidateDirs = [
    'src',
    'app',
    'pages',
    'components',
    'lib',
    'api',
    'controllers',
    'routes',
    'models',
    'tests',
    'test',
    'public',
    'prisma',
    'templates',
    'bin',
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
