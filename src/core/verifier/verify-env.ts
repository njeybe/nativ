// Builds the minimal environment a verification command runs with.
const BASE = ['PATH', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP'];
const WINDOWS = ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA'];
const TOOLS = ['VIRTUAL_ENV', 'GOPATH', 'GOROOT', 'GOCACHE', 'GOMODCACHE'];

/** Allowlisted variables from the parent env, plus the extra names, plus the sandbox markers. */
export function buildVerifyEnv(
  extra: string[] = [],
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const names = new Set(
    [...BASE, ...TOOLS, ...(process.platform === 'win32' ? WINDOWS : []), ...extra].map((n) =>
      n.toLowerCase(),
    ),
  );
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || !names.has(key.toLowerCase())) continue;
    if (key.startsWith('NATIV_') || key === 'CI') continue;
    out[key] = value;
  }
  out.CI = 'true';
  out.NATIV_VERIFY_SANDBOX = '1';
  return out;
}
