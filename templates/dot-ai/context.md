# Project Context & Guardrails

## 1. System Overview & Repository Profile
- **Project Name:** {{PROJECT_NAME}}
- **Repository Type:** {{REPOSITORY_TYPE}}
- **Workspace Topology:** {{WORKSPACE_TOPOLOGY}}
- **Primary Goal:** {{PROJECT_GOAL}}

## 2. Technology Stack & Ecosystem Manifests
- **Language / Runtime:** {{DETECTED_RUNTIME}}
- **Framework:** {{DETECTED_FRAMEWORK}}
- **Database / ORM:** {{DETECTED_DATABASE_ORM}}
- **ORM / Migration Config:** {{DETECTED_ORM_CONFIG}}
- **Styling / UI Library:** {{DETECTED_STYLING}}
- **Testing Framework:** {{DETECTED_TESTING}}
- **Package Manager:** {{DETECTED_PACKAGE_MANAGER}}
- **Discovered Manifests:** {{ECOSYSTEM_MANIFESTS}}

## 3. Architecture & Codebase Layout
- **Source Root:** `{{SOURCE_ROOT}}`
- **Core Pattern:** {{ARCHITECTURE_PATTERN}}
- **Key Directories:**
{{KEY_DIRECTORIES}}

## 4. Engineering Guardrails & Constraints
1. **Strict Role Pipeline (provider-agnostic):** Architect (designs contracts and resolves escalations) -> Project Manager (orchestrates the task loop) -> Workers (specialized sub-agents) -> Verifier (independent checks). Roles are fixed; the model or vendor behind a role is configurable. Claude Code is the default host for every role, and other agents can be plugged in.
2. **Zero Breaking Changes:** Avoid breaking existing public interfaces, CLI options, or database contracts without explicit migration strategies.
3. **Schema Authority:** Database modifications must strictly align with `.ai/db_schema.json`.
4. **UI Fidelity:** User interface components must strictly match `.ai/ui_specs.md`.
5. **Secrets & Security:** Never hardcode API keys, passwords, or tokens. Use environment variables. Validate all external inputs.
6. **Testing Requirement:** Every newly introduced endpoint, service, or complex component must include automated tests before marking tasks completed in `.ai/master_plan.json`.

## 5. Execution Boundaries (Sub-Agent Allocation)
- **`backend`:** Core services, CLI logic, APIs, server runtime code, and route handlers.
- **`frontend`:** Web application views, client components, or terminal UI presentation.
- **`database`:** Schema definitions, ORM models, migrations, and seed scripts matching `.ai/db_schema.json`.
- **`qa-tester`:** Unit tests, integration tests, and verification scripts.
- **Specialized Units:** `flutter-developer`, `devops-agent`, `security-auditor`, `db-migration` when required.
