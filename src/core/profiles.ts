import fs from 'node:fs';
import path from 'node:path';
import { parseJsonLoose, type EnforcementMode } from './enforcement.js';
import { mutateJsonFileSync } from './lock-manager.js';

export type NativProfile = 'prototype' | 'solo' | 'enterprise';

export interface ProfileSettings {
  profile: NativProfile;
  enforcement: EnforcementMode;
  governorMode: 'auto_adopt' | 'guard';
  testIntegrity: 'off' | 'warn' | 'block';
  allowHeadlessBypass: boolean;
  verifyIsolation: 'none' | 'clean';
  verifyIsolationFailure: 'warn' | 'block';
  skippedCheck: 'allow' | 'warn' | 'block';
  description: string;
}

export const PROFILE_DEFAULTS: Record<NativProfile, ProfileSettings> = {
  prototype: {
    profile: 'prototype',
    enforcement: 'off',
    governorMode: 'auto_adopt',
    testIntegrity: 'off',
    allowHeadlessBypass: true,
    verifyIsolation: 'none',
    verifyIsolationFailure: 'warn',
    skippedCheck: 'allow',
    description: 'Hackathon & scratchpad mode: frictionless exploration, auto-adopting contracts, and relaxed scope.',
  },
  solo: {
    profile: 'solo',
    enforcement: 'warn',
    governorMode: 'auto_adopt',
    testIntegrity: 'warn',
    allowHeadlessBypass: true,
    verifyIsolation: 'clean',
    verifyIsolationFailure: 'warn',
    skippedCheck: 'warn',
    description:
      'Single-developer agility: advisory scope warnings, self-evolving contracts, '
      + 'and streamlined execution.',
  },
  enterprise: {
    profile: 'enterprise',
    enforcement: 'warn',
    governorMode: 'guard',
    testIntegrity: 'block',
    allowHeadlessBypass: false,
    verifyIsolation: 'clean',
    verifyIsolationFailure: 'block',
    skippedCheck: 'block',
    description:
      'Full team rigor: strict contract boundaries, test integrity protection, '
      + 'circuit breakers, and air-gap.',
  },
};

const CONFIG_FILE = path.join('.nativ', 'config.json');

export function loadProfile(root: string): NativProfile {
  try {
    const raw = parseJsonLoose<{ profile?: unknown }>(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8'));
    if (raw.profile === 'prototype' || raw.profile === 'solo' || raw.profile === 'enterprise') {
      return raw.profile;
    }
  } catch {
    // Missing config defaults to enterprise
  }
  return 'enterprise';
}

export function resolveActiveProfileSettings(root: string): ProfileSettings {
  const profile = loadProfile(root);
  const base = { ...PROFILE_DEFAULTS[profile] };
  try {
    const raw = parseJsonLoose<{
      enforcement?: unknown;
      governorMode?: unknown;
      testIntegrity?: unknown;
      verifyIsolation?: unknown;
      verifyIsolationFailure?: unknown;
      skippedCheck?: unknown;
    }>(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8'));

    if (raw.enforcement === 'off' || raw.enforcement === 'warn' || raw.enforcement === 'block') {
      base.enforcement = raw.enforcement;
    }
    if (raw.governorMode === 'auto_adopt' || raw.governorMode === 'guard') {
      base.governorMode = raw.governorMode;
    }
    if (raw.testIntegrity === 'off' || raw.testIntegrity === 'warn' || raw.testIntegrity === 'block') {
      base.testIntegrity = raw.testIntegrity;
    }
    if (raw.verifyIsolation === 'none' || raw.verifyIsolation === 'clean') {
      base.verifyIsolation = raw.verifyIsolation;
    }
    if (raw.verifyIsolationFailure === 'warn' || raw.verifyIsolationFailure === 'block') {
      base.verifyIsolationFailure = raw.verifyIsolationFailure;
    }
    if (raw.skippedCheck === 'allow' || raw.skippedCheck === 'warn' || raw.skippedCheck === 'block') {
      base.skippedCheck = raw.skippedCheck;
    }
  } catch {
    // Keep base defaults
  }
  return base;
}

export function setProfile(root: string, profile: NativProfile): ProfileSettings {
  const profileSettings = PROFILE_DEFAULTS[profile];
  mutateJsonFileSync(path.join(root, CONFIG_FILE), (config) => {
    config.profile = profile;
    config.enforcement = profileSettings.enforcement;
    config.governorMode = profileSettings.governorMode;
    config.testIntegrity = profileSettings.testIntegrity;
    config.verifyIsolation = profileSettings.verifyIsolation;
    config.verifyIsolationFailure = profileSettings.verifyIsolationFailure;
    config.skippedCheck = profileSettings.skippedCheck;
  });
  return profileSettings;
}

export interface VerifySettings {
  verifyEnv: string[];
  verifyLinks: string[];
}

const DEFAULT_VERIFY_LINKS = ['node_modules', '.venv', 'venv'];
const BLOCKED_ENV = new Set(['CI', 'GITHUB_ACTIONS', 'GITLAB_CI']);

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

export function loadVerifySettings(root: string): VerifySettings {
  let raw: { verifyEnv?: unknown; verifyLinks?: unknown } = {};
  try {
    raw = parseJsonLoose(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8'));
  } catch {
    // Missing config keeps defaults
  }
  const verifyEnv = stringList(raw.verifyEnv, []).filter(
    (n) => !BLOCKED_ENV.has(n) && !n.startsWith('NATIV_'),
  );
  return { verifyEnv, verifyLinks: stringList(raw.verifyLinks, DEFAULT_VERIFY_LINKS) };
}
