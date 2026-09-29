# Installing nativ

This guide covers installing `nativ`, connecting it to Claude Code, and checking that everything works.

## Prerequisites

| Requirement | Version | Notes |
| :--- | :--- | :--- |
| Node.js | 20 or newer (22 recommended) | |
| npm | 9 or newer | Ships with Node.js |
| Git | 2.30 or newer | Needed for `nativ worktree` |
| Claude Code | current | Optional for the CLI itself, required for the agents, hooks and MCP integration |
| OS | Windows, macOS or Linux | |

```bash
node -v
npm -v
git --version
claude --version
```

## Install the CLI

### From npm

```bash
npm install -g nativ-cli
nativ --version
```

The package is `nativ-cli`; the command is `nativ`. To remove it: `npm uninstall -g nativ-cli`.

### From GitHub (no clone needed)

```bash
npm install -g github:njeybe/nativ
nativ --version
```

npm downloads the repository and builds it during the install, which takes about a minute. Use this to get changes that are on `main` but not yet published to npm.

### From a clone (developing nativ itself)

```bash
git clone https://github.com/njeybe/nativ.git
cd nativ
npm install
npm run build
npm link
```

`npm link` makes `nativ` available everywhere and points it at your clone. Run `npm run watch` in a spare terminal to rebuild on change. To unlink: `npm unlink -g nativ-cli`.

### Without installing

```bash
npx nativ-cli init
npx nativ-cli doctor
```

If you go this way, generate the configuration with `nativ setup --command "npx -y nativ-cli"` so the hooks and MCP server use `npx` too. Note that `npx` starts more slowly, and the enforcement hook runs before every file write, so a global install is better for daily use.

## Connect a project to Claude Code

```bash
cd your-project
nativ init        # scaffolds .ai/ and runs setup
```

Or, in a project that already has `.ai/`:

```bash
nativ setup
```

This writes `.mcp.json`, `.claude/settings.json`, `.claude/agents/`, `AGENTS.md` and `.nativ/config.json`, merging into anything already there. Preview with `nativ setup --dry-run`.

Then:

1. Open Claude Code in the folder and **accept the workspace trust dialog**. Until you do, Claude Code ignores the project's `permissions.allow` entries.
2. Restart Claude Code (or run `/hooks`) if it was already open, so it loads the hooks.
3. Run `nativ doctor`.

### Or use the plugin

```text
/plugin marketplace add njeybe/nativ
/plugin install nativ@nativ
```

The plugin supplies the agents, hooks, MCP server and a skill. It needs the `nativ` command on your PATH. It cannot ship permission rules, so also run `nativ setup` in each project.

## Verify

```bash
nativ doctor
```

A healthy install reports that `nativ` runs, the MCP server, hooks, permissions and agents are in place, and (if Claude Code is installed) that Claude Code connects to the `nativ` MCP server. `nativ doctor --fix` repairs missing or out-of-date files. Warnings are informational; failures are not.

Check what the enforcement hook will do:

```bash
nativ hook status
```

## Update

```bash
npm install -g nativ-cli@latest      # or: npm install -g github:njeybe/nativ
cd your-project
nativ update
nativ doctor
```

`nativ update` refreshes what nativ wrote and you have not touched: the directives, the role guides, the agents, the hooks and the MCP entry. Files you edited are kept and listed; add `--force` to replace them. Your contracts and plan in `.ai/` are never modified. If the tools list in Claude Code looks stale after an update, restart the session, then run `nativ doctor`.

Upgrading from 1.x? Read [CHANGELOG.md](../CHANGELOG.md): the `agentj_*` tools and `agentj://` resources were removed, so any config that still calls them must use the `nativ_*` names.

## Other MCP hosts

The same server works with any MCP host. Cursor, Claude Desktop and Antigravity take a config like:

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

With a global install, use `"command": "nativ"` and `"args": ["mcp", "/absolute/path/to/your/project"]`. See `templates/GEMINI.md` for using Antigravity as the architect.

## Troubleshooting

### `nativ doctor` says a `nativ` server is defined in multiple scopes

Claude Code has a `nativ` MCP server in your local or user scope as well as the project's `.mcp.json`, and the other scope wins. Keep the one you want: `claude mcp remove nativ -s local` (or `-s user`).

### The hook or MCP tools are not loaded

Restart Claude Code, accept the workspace trust dialog, then run `nativ doctor --fix`. `claude mcp list` shows whether the `nativ` server connects.

### `nativ doctor` reports that `master_plan.json` cannot be parsed

Role enforcement cannot see the active task in a plan it cannot read. Fix the JSON syntax. (A leading byte-order mark is fine for the hook and doctor.)

### Windows: `nativ.ps1 cannot be loaded because running scripts is disabled`

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### Windows: `The term 'nativ' is not recognized`

1. Run `npm config get prefix` (usually `C:\Users\<you>\AppData\Roaming\npm`).
2. Make sure that folder is on your `PATH`.
3. Restart the terminal or your editor.

### The hook feels slow

`nativ hook check` should take well under a second. If it does not, check that `nativ` is a global install and not `npx`, and that antivirus is not scanning `node` on every launch.
