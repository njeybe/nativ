# Project Context & Guardrails

## 1. System Overview
- **Project Name:** {{PROJECT_NAME}}
- **Project Type:** {{PROJECT_TYPE}}
- **Primary Goal:** {{PROJECT_GOAL}}

## 2. Technology Stack & Tooling
- **Language / Runtime:** {{DETECTED_RUNTIME}}
- **Framework:** {{DETECTED_FRAMEWORK}}
- **Database / ORM:** {{DETECTED_DATABASE_ORM}}
- **Styling / UI Library:** {{DETECTED_STYLING}}
- **Testing Framework:** {{DETECTED_TESTING}}
- **Package Manager:** {{DETECTED_PACKAGE_MANAGER}}

## 3. Architecture & Codebase Layout
- **Source Root:** `{{SOURCE_ROOT}}`
- **Core Pattern:** {{ARCHITECTURE_PATTERN}}
- **Key Directories:**
{{KEY_DIRECTORIES}}

## 4. Engineering Guardrails & Constraints
1. **Zero Breaking Changes:** Avoid breaking existing public interfaces or database contracts without explicit migration strategies.
2. **Schema Authority:** Database modifications must strictly align with `.ai/db_schema.json`.
3. **UI Fidelity:** User interface components must strictly match `.ai/ui_specs.md`.
4. **Secrets & Security:** Never hardcode API keys, passwords, or tokens. Use environment variables. Validate all external inputs.
5. **Testing Requirement:** Every newly introduced endpoint, service, or complex component must include automated tests before marking tasks completed in `.ai/master_plan.json`.
