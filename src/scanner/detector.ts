import fs from 'node:fs';
import path from 'node:path';
import { ProjectInfo } from './types.js';

export function detectProject(targetDir: string): ProjectInfo {
  const baseName = path.basename(path.resolve(targetDir));
  
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
  const keyDirectories: string[] = [];

  // Check Node.js / JavaScript / TypeScript
  const pkgPath = path.join(targetDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.name) projectName = pkg.name;
      if (pkg.description) projectGoal = pkg.description;

      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      
      // Runtime & Language
      if (deps.typescript || fs.existsSync(path.join(targetDir, 'tsconfig.json'))) {
        runtime = 'Node.js (TypeScript)';
      } else {
        runtime = 'Node.js (JavaScript)';
      }

      // Frameworks
      if (deps.next) framework = `Next.js (${deps.next})`;
      else if (deps.nuxt) framework = `Nuxt (${deps.nuxt})`;
      else if (deps.remix || deps['@remix-run/react']) framework = 'Remix';
      else if (deps.vite) framework = 'Vite / React/Vue';
      else if (deps.express) framework = 'Express.js';
      else if (deps.fastify) framework = 'Fastify';
      else if (deps['@nestjs/core']) framework = 'NestJS';
      else if (deps.react) framework = 'React SPA';
      else if (deps.vue) framework = 'Vue.js SPA';
      else if (deps.svelte || deps['@sveltejs/kit']) framework = 'Svelte / SvelteKit';

      // Database & ORMs
      if (deps.prisma || deps['@prisma/client']) databaseOrm = 'Prisma ORM';
      else if (deps['drizzle-orm']) databaseOrm = 'Drizzle ORM';
      else if (deps.typeorm) databaseOrm = 'TypeORM';
      else if (deps.mongoose) databaseOrm = 'Mongoose / MongoDB';
      else if (deps.sequelize) databaseOrm = 'Sequelize';
      else if (deps['@supabase/supabase-js']) databaseOrm = 'Supabase Client';

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

      // Package manager detection
      if (fs.existsSync(path.join(targetDir, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
      else if (fs.existsSync(path.join(targetDir, 'yarn.lock'))) packageManager = 'yarn';
      else if (fs.existsSync(path.join(targetDir, 'bun.lockb')) || fs.existsSync(path.join(targetDir, 'bun.lock'))) packageManager = 'bun';
      else if (fs.existsSync(path.join(targetDir, 'package-lock.json'))) packageManager = 'npm';
      else packageManager = 'npm';

      // Update verification command based on scripts
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        verificationCommand = `${packageManager === 'npm' ? 'npm test' : `${packageManager} test`}`;
      } else if (pkg.scripts?.build) {
        verificationCommand = `${packageManager === 'npm' ? 'npm run build' : `${packageManager} build`}`;
      }

      projectType = framework !== 'None detected' ? `Web Application (${framework})` : 'Node.js Application';
    } catch {
      // Ignore parse error, proceed with fallback
    }
  }

  // Check Python
  const pyprojectPath = path.join(targetDir, 'pyproject.toml');
  const reqsPath = path.join(targetDir, 'requirements.txt');
  if (fs.existsSync(pyprojectPath) || fs.existsSync(reqsPath)) {
    runtime = 'Python 3.x';
    projectType = 'Python Service / Application';
    packageManager = fs.existsSync(path.join(targetDir, 'poetry.lock')) ? 'Poetry' : (fs.existsSync(path.join(targetDir, 'uv.lock')) ? 'uv' : 'pip');
    verificationCommand = 'pytest';
    
    let pyContent = '';
    if (fs.existsSync(reqsPath)) pyContent += fs.readFileSync(reqsPath, 'utf8');
    if (fs.existsSync(pyprojectPath)) pyContent += fs.readFileSync(pyprojectPath, 'utf8');

    if (pyContent.includes('fastapi')) framework = 'FastAPI';
    else if (pyContent.includes('django')) framework = 'Django';
    else if (pyContent.includes('flask')) framework = 'Flask';

    if (pyContent.includes('sqlalchemy')) databaseOrm = 'SQLAlchemy';
    else if (pyContent.includes('tortoise-orm')) databaseOrm = 'Tortoise ORM';

    if (pyContent.includes('pytest')) testing = 'pytest';
  }

  // Check Go
  const goModPath = path.join(targetDir, 'go.mod');
  if (fs.existsSync(goModPath)) {
    runtime = 'Go';
    projectType = 'Go Service';
    packageManager = 'go modules';
    verificationCommand = 'go test ./...';
    const modContent = fs.readFileSync(goModPath, 'utf8');
    if (modContent.includes('gin-gonic/gin')) framework = 'Gin';
    else if (modContent.includes('gofiber/fiber')) framework = 'Fiber';
    if (modContent.includes('gorm.io/gorm')) databaseOrm = 'GORM';
  }

  // Check Rust
  const cargoPath = path.join(targetDir, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    runtime = 'Rust';
    projectType = 'Rust Application';
    packageManager = 'cargo';
    verificationCommand = 'cargo test';
  }

  // Check Directory Structure
  const candidateDirs = ['src', 'app', 'pages', 'components', 'lib', 'api', 'controllers', 'routes', 'models', 'tests', 'test', 'public', 'prisma'];
  for (const dir of candidateDirs) {
    if (fs.existsSync(path.join(targetDir, dir))) {
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
  };
}
