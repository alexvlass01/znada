'use strict';

const path = require('path');

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const DIAGNOSTICS_ARGS = new Set(['--diagnostics', '--znada-diagnostics']);

function normalizeLaunchFlags(argv = []) {
  return String((Array.isArray(argv) ? argv.slice(1) : []).join(' '))
    .split(/\s+/)
    .map((flag) => flag.trim())
    .filter(Boolean);
}

function isEnabledEnv(value) {
  return TRUE_VALUES.has(String(value || '').trim().toLowerCase());
}

function resolveDiagnosticsBootstrap({
  isPackaged = true,
  env = process.env,
  argv = process.argv,
  localAppData = env && env.LOCALAPPDATA,
  defaultDirName = 'Znada-Diagnostics',
} = {}) {
  const flags = normalizeLaunchFlags(argv);
  const hasArg = flags.some((flag) => DIAGNOSTICS_ARGS.has(flag));
  const hasEnv = isEnabledEnv(env && env.ZNADA_DIAGNOSTICS);
  const requested = hasArg || hasEnv;

  if (isPackaged) {
    return { enabled: false, requested, reason: requested ? 'packaged' : 'not_requested', userDataPath: null };
  }
  if (!hasArg || !hasEnv) {
    return { enabled: false, requested, reason: requested ? 'partial_opt_in' : 'not_requested', userDataPath: null };
  }

  const explicitPath = String((env && env.ZNADA_DIAGNOSTICS_USER_DATA) || '').trim();
  const rawPath = explicitPath || (localAppData ? path.join(localAppData, defaultDirName) : '');
  if (!rawPath) {
    return { enabled: false, requested: true, reason: 'missing_user_data_path', userDataPath: null };
  }

  return {
    enabled: true,
    requested: true,
    reason: 'enabled',
    userDataPath: path.resolve(rawPath),
  };
}

module.exports = {
  normalizeLaunchFlags,
  resolveDiagnosticsBootstrap,
};
