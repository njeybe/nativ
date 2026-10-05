import fs from 'node:fs';
import path from 'node:path';
import { parseJsonLoose, type EnforcementMode } from './enforcement.js';

export type NativProfile = 'prototype' | 'solo' | 'enterprise';

export interface ProfileSettings {
  profile: NativProfile;
  enforcement: EnforcementMode;
  governorMode: 'auto_adopt' | 'guard';
  testIntegrity: 'off' | 'warn' | 'block';
  allowHeadlessBypass: boolean;
  description: string;
}

export const PROFILE_DEFAULTS: Record<NativProfile, ProfileSettings> = {
  prototype: {
    profile: 'prototype',
    enforcement: 'off',
    governorMode: 'auto_adopt',
    testIntegrity: 'off',
    allowHeadlessBypass: true,
    description: 'Hackathon & scratchpad mode: frictionless exploration, auto-adopting contracts, and relaxed scope.',
  },
  solo: {
    profile: 'solo',
    enforcement: 'warn',
    governorMode: 'auto_adopt',
    testIntegrity: 'warn',
    allowHeadlessBypass: true,
    description: 'Single-developer agility: advisory scope warnings, self-evolving contracts, and streamlined execution.',
  },
  enterprise: {
    profile: 'enterprise',
    enforcement: 'warn',
    governorMode: 'guard',
    testIntegrity: 'block',
    allowHeadlessBypass: false,
    description: 'Full team rigor: strict contract boundaries, test integrity protection, circuit breakers, and air-gap.',
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
  } catch {
    // Keep base defaults
  }
  return base;
}

export function setProfile(root: string, profile: NativProfile): ProfileSettings {
  const configPath = path.join(root, CONFIG_FILE);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    existing = parseJsonLoose<Record<string, unknown>>(fs.readFileSync(configPath, 'utf8')) || {};
  } catch {
    existing = {};
  }

  const profileSettings = PROFILE_DEFAULTS[profile];
  existing.profile = profile;
  existing.enforcement = profileSettings.enforcement;
  existing.governorMode = profileSettings.governorMode;
  existing.testIntegrity = profileSettings.testIntegrity;

  const tmp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, configPath);

  return profileSettings;
}
