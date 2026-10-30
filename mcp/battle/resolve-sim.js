/**
 * Resolve a game installation on **this** machine.
 *
 * This is the optional fast path: when the agent runs beside the server, pointing at the installation
 * avoids downloading anything. It is deliberately **explicit only** — a silent upward search would
 * pick up whatever checkout happens to sit near the working directory and quietly mask the remote
 * source, which is the opposite of what a distributed agent should do.
 *
 *   STRONGHOLD_SIM_SPEC   an explicit path to the simulation's `spec.js`
 *   STRONGHOLD_SIM_ROOT   a repository root or a `server/` directory containing `sim/spec.js`
 *   STRONGHOLD_SIM_AUTODISCOVER=1
 *                         opt in to walking up from the working directory
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Every relative location that has held `spec.js` in the layouts we have seen. */
const SPEC_SUFFIXES = [
  'server/sim/spec.js',
  'sim/spec.js',
  'spec.js',
];

function truthy(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function candidateRoots(startDir) {
  const roots = [];
  let dir = resolve(startDir);
  for (let i = 0; i < 6; i++) {
    roots.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

function rootsFor(env, startDir) {
  const roots = [];
  const configured = String(env.STRONGHOLD_SIM_ROOT || '').trim();
  if (configured) roots.push(isAbsolute(configured) ? configured : resolve(startDir, configured));
  if (truthy(env.STRONGHOLD_SIM_AUTODISCOVER)) roots.push(...candidateRoots(startDir));
  return roots;
}

/** @returns {string|null} an absolute path to `spec.js`, or null when nothing matched. */
export function resolveSpecPath(env = process.env, startDir = process.cwd()) {
  const explicit = String(env.STRONGHOLD_SIM_SPEC || '').trim();
  if (explicit) {
    const full = isAbsolute(explicit) ? explicit : resolve(startDir, explicit);
    return existsSync(full) ? full : null;
  }
  for (const root of rootsFor(env, startDir)) {
    for (const suffix of SPEC_SUFFIXES) {
      const full = join(root, suffix);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/** The paths that were tried, for an actionable error message. */
export function describeSearch(env = process.env, startDir = process.cwd()) {
  const explicit = String(env.STRONGHOLD_SIM_SPEC || '').trim();
  if (explicit) return [isAbsolute(explicit) ? explicit : resolve(startDir, explicit)];
  return rootsFor(env, startDir).flatMap((root) => SPEC_SUFFIXES.map((suffix) => join(root, suffix)));
}

/**
 * Import the game's simulation modules from disk.
 * @returns {Promise<{ spec: object, constants: object, specPath: string }>}
 */
export async function loadSimulation(env = process.env, startDir = process.cwd()) {
  const specPath = resolveSpecPath(env, startDir);
  if (!specPath) {
    const tried = describeSearch(env, startDir).slice(0, 8).map((p) => `\n  - ${p}`).join('');
    throw new Error(`could not find the game's sim/spec.js. Tried:${tried}\nSet STRONGHOLD_SIM_ROOT (repository root) or STRONGHOLD_SIM_SPEC (path to spec.js).`);
  }
  const spec = await import(pathToFileURL(specPath).href);
  const constantsPath = join(dirname(specPath), 'constants.js');
  if (!existsSync(constantsPath)) throw new Error(`found ${specPath} but not its sibling constants.js`);
  const constants = await import(pathToFileURL(constantsPath).href);
  for (const name of ['createBattleFromSpec', 'compactResult', 'battleProgress', 'attachLpMeter']) {
    if (typeof spec[name] !== 'function') throw new Error(`${specPath} does not export ${name}(); is this the expected simulation module?`);
  }
  if (typeof constants.TICK !== 'number') throw new Error(`${constantsPath} does not export a numeric TICK`);
  return { spec, constants, specPath };
}
