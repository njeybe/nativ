# Installation Guide for Nativ (`nativ`)

This guide covers all methods to install, configure, and verify `nativ` on your development machine.

---

## 📋 Prerequisites

Before installing `nativ`, ensure your environment meets the following requirements:

| Requirement | Minimum Version | Notes |
| :--- | :--- | :--- |
| **Node.js** | `>= 22.5.0` (Recommended) or `>= 20.0.0` | Node 22.5+ includes built-in `node:sqlite` support for zero-dependency SQLite telemetry. |
| **npm** | `>= 9.0.0` | Included with Node.js. |
| **Git** | `>= 2.30.0` | Required for `nativ worktree` commands and auto-discovery. |
| **OS** | Windows, macOS, or Linux | Cross-platform compatible. |

Verify your installed versions:
```bash
node -v
npm -v
git --version
```

---

## 🚀 Installation Methods

### Method 1: Install from Source (For Developers & Contributors)

If you are developing `nativ` or working directly within its source code:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/njeybe/nativ.git
   cd nativ
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build the TypeScript binary:**
   ```bash
   npm run build
   ```

4. **Link globally to your system:**
   ```bash
   npm link
   ```

Once linked, the `nativ` command is available in any terminal window across your system.

> [!TIP]
> **Active Development:** Run `npm run watch` in a background terminal to automatically recompile TypeScript changes into the linked binary.

---

### Method 2: Global Installation via npm

If installing `nativ` as an end user from the npm registry:

```bash
# Global install
npm install -g nativ-cli
```

> **Note:** The package name is `nativ-cli`, but the CLI binary command registered on your path is `nativ`.

To verify:
```bash
nativ --version
```

To uninstall or unlink later:
```bash
npm uninstall -g nativ-cli
# Or if you used npm link:
npm unlink -g nativ-cli
```

---

### Method 3: Zero-Install via `npx` (On-Demand Execution)

You can run any `nativ` command directly without installing it globally:

```bash
# Initialize nativ in your current project
npx nativ-cli init

# Check project task status
npx nativ-cli status

# Launch database studio
npx nativ-cli studio
```

---

## ⚙️ Post-Installation Verification

Confirm that `nativ` is properly installed and accessible in your shell:

```bash
nativ --help
```

You should see the list of available commands (`init`, `status`, `task`, `db`, `mcp`, `worktree`, etc.).

---

## 🔌 Integrating `nativ` with AI Agents (MCP)

`nativ` includes a built-in Model Context Protocol (MCP) server so AI coding assistants can directly interact with project tasks, contracts, and database schema telemetry.

### 1. Claude Code CLI

Add `nativ` to your local Claude Code configuration:

```bash
# Inside your project directory:
claude mcp add nativ -- npx nativ-cli mcp
```

Or configure project-scoped `.mcp.json`:
```json
{
  "mcpServers": {
    "nativ": {
      "command": "npx",
      "args": ["-y", "nativ-cli", "mcp"]
    }
  }
}
```

### 2. Antigravity / Claude Desktop / Cursor

Add `nativ` to your MCP configuration file:

```json
{
  "mcpServers": {
    "nativ": {
      "command": "npx",
      "args": ["-y", "nativ-cli", "mcp", "/absolute/path/to/your/project"]
    }
  }
}
```

*(If you have `nativ` installed globally or linked via `npm link`, you can replace `"command": "npx"` with `"command": "nativ"` and `"args": ["mcp", "/path/to/project"]`)*.

---

## 🪟 Windows Troubleshooting & Gotchas

### 1. PowerShell Script Execution Policy
If you get a script execution error in Windows PowerShell (`nativ.ps1 cannot be loaded because running scripts is disabled`):

Run PowerShell as Administrator or for your user:
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### 2. Command Not Found After `npm link`
If PowerShell says `The term 'nativ' is not recognized`:
1. Check your global npm prefix:
   ```bash
   npm config get prefix
   ```
   *(Usually `C:\Users\<Username>\AppData\Roaming\npm`)*
2. Ensure that path is included in your system's `PATH` environment variable.
3. Restart your terminal session or VS Code / IDE.
