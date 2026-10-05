import path from 'node:path';

export interface EcosystemProfile {
  projectName?: string;
  projectGoal?: string;
  projectType?: string;
  runtime: string;
  framework: string;
  databaseOrm: string;
  styling: string;
  testing: string;
  packageManager: string;
  verificationCommand: string;
  ecosystemManifests: string[];
  monorepoWorkspaces: string[];
  monorepoIndicators: string[];
}

export function detectEcosystems(
  resolvedTarget: string,
  baseName: string,
  fileExists: (relPath: string) => boolean,
  readFileSafe: (filePath: string) => string
): EcosystemProfile {
  let projectName: string | undefined;
  let projectGoal: string | undefined;
  let projectType: string | undefined;
  let runtime = 'Unknown / Greenfield';
  let framework = 'None detected';
  let databaseOrm = 'None detected';
  let styling = 'None detected';
  let testing = 'None detected';
  let packageManager = 'None detected';
  let verificationCommand = 'npm test';
  const ecosystemManifests: string[] = [];
  const monorepoWorkspaces: string[] = [];
  const monorepoIndicators: string[] = [];

  // --- Ecosystem A: Node.js / JavaScript / TypeScript ---
  const pkgPath = path.join(resolvedTarget, 'package.json');
  if (fileExists('package.json')) {
    ecosystemManifests.push('package.json');
    try {
      const pkg = JSON.parse(readFileSafe(pkgPath));
      if (pkg.name) projectName = pkg.name;
      if (pkg.description) projectGoal = pkg.description;

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

      if (deps.typescript || fileExists('tsconfig.json')) {
        runtime = 'Node.js (TypeScript)';
        if (fileExists('tsconfig.json')) ecosystemManifests.push('tsconfig.json');
      } else {
        runtime = 'Node.js (JavaScript)';
      }

      if (deps['react-native'] || deps.expo) {
        framework = deps.expo ? 'Expo Mobile App' : 'React Native';
      } else if (deps.next) framework = `Next.js (${deps.next})`;
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

      if (deps.tailwindcss) styling = 'Tailwind CSS';
      else if (deps['styled-components']) styling = 'Styled Components';
      else if (deps['@emotion/react']) styling = 'Emotion';
      else if (deps.sass) styling = 'SASS / SCSS';

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
      if (composerPkg.name && !projectName) {
        projectName = composerPkg.name;
      }
      if (composerPkg.description && !projectGoal) {
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
    if (moduleMatch && !projectName) {
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

  // --- Ecosystem G: Mobile / Flutter (pubspec.yaml) ---
  if (fileExists('pubspec.yaml')) {
    ecosystemManifests.push('pubspec.yaml');
    if (runtime === 'Unknown / Greenfield') {
      runtime = 'Dart / Flutter';
      framework = 'Flutter Mobile App';
      projectType = 'Mobile Application (Flutter)';
      packageManager = 'flutter pub';
      verificationCommand = 'flutter test';
    }
  }

  return {
    projectName,
    projectGoal,
    projectType,
    runtime,
    framework,
    databaseOrm,
    styling,
    testing,
    packageManager,
    verificationCommand,
    ecosystemManifests,
    monorepoWorkspaces,
    monorepoIndicators,
  };
}
