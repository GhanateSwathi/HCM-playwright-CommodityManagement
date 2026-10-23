import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as ts from 'typescript';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * env.ts is meant to fail loud, the moment a required key is missing, rather
 * than let Playwright type the string "undefined" into a form. It reads
 * process.env at module *import* time, and Node caches modules - so by the
 * time any other spec in this run could try to exercise that, env.ts has
 * already been imported once with a complete environment and the failure
 * path is unreachable in-process.
 *
 * So this spawns a genuinely separate Node process per case, with one
 * required key deliberately removed from an otherwise-complete environment
 * (everything else copied from this process's own process.env, which
 * playwright.config.ts has already loaded via dotenv - never a fabricated
 * environment that might accidentally miss some OTHER key and produce a
 * misleading failure).
 *
 * env.ts has no imports of its own, so it compiles standalone - the
 * TypeScript compiler API is used directly (in-process, no shelling out to
 * `npx tsc`, which is its own source of cross-platform PATH problems) to
 * produce one temp .js file, reused by every case below.
 */
test.describe('env.ts / stateEnv - fails loud on a missing key', () => {
  let compiledPath: string;

  test.beforeAll(() => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'utils', 'env.ts'),
      'utf8',
    );
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcm-env-check-'));
    compiledPath = path.join(tmpDir, 'env.js');
    fs.writeFileSync(compiledPath, outputText, 'utf8');
  });

  /**
   * Runs `code` in a fresh Node process whose environment is this process's
   * own (already-complete) process.env, minus whichever keys are named in
   * `unset`. Returns combined stdout+stderr and the exit status, rather than
   * throwing on a non-zero exit - a non-zero exit *is* the expected outcome
   * for most cases here.
   */
  function runInChildProcess(
    unset: string[],
    code: string,
  ): { output: string; status: number } {
    const childEnv = { ...process.env };
    for (const key of unset) delete childEnv[key];

    try {
      const output = execFileSync(process.execPath, ['-e', code], {
        env: childEnv,
        encoding: 'utf8',
      });
      return { output, status: 0 };
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return {
        output: (err.stdout ?? '') + (err.stderr ?? ''),
        status: err.status ?? 1,
      };
    }
  }

  test('throws immediately, naming the key, when HCM_WEB_URL is missing', () => {
    const { output, status } = runInChildProcess(
      ['HCM_WEB_URL'],
      `require(${JSON.stringify(compiledPath)});`,
    );

    expect(status).not.toBe(0);
    expect(output).toContain(
      'HCM_WEB_URL is not set. Copy .env.example to .env and fill it in.',
    );
  });

  test('rejects a non-integer HCM_SPAQ1 rather than silently coercing it', () => {
    const childEnv = { ...process.env, HCM_SPAQ1: 'not-a-number' };
    try {
      execFileSync(
        process.execPath,
        ['-e', `require(${JSON.stringify(compiledPath)});`],
        { env: childEnv, encoding: 'utf8' },
      );
      throw new Error('expected the child process to exit non-zero');
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      const output = (err.stdout ?? '') + (err.stderr ?? '');
      expect(err.status).not.toBe(0);
      expect(output).toContain(
        'HCM_SPAQ1 must be a whole number of 0 or greater, got "not-a-number"',
      );
    }
  });

  /**
   * stateEnv's fields are getters rather than plain properties specifically
   * so a project with no state-user config yet doesn't break every other
   * spec merely by importing env.ts - see env.ts's own comment. This proves
   * that design actually holds: importing the module must succeed even with
   * every HCM_STATE_* key missing, and the failure must surface only at the
   * point something reads stateEnv.userId, not before.
   */
  test('stateEnv fails lazily: import succeeds with no HCM_STATE_* set, only reading a field throws', () => {
    const { output, status } = runInChildProcess(
      [
        'HCM_STATE_USER_ID',
        'HCM_STATE_PASSWORD',
        'HCM_STATE_FROM_FACILITY',
        'HCM_STATE_LGA',
        'HCM_STATE_WARD',
        'HCM_STATE_TO_FACILITY',
      ],
      `
        const { env, stateEnv } = require(${JSON.stringify(compiledPath)});
        console.log('IMPORT_OK', typeof env.url);
        try {
          stateEnv.userId;
          console.log('DID_NOT_THROW');
        } catch (e) {
          console.log('THROWN:', e.message);
          process.exit(1);
        }
      `,
    );

    expect(output).toContain('IMPORT_OK string');
    expect(status).not.toBe(0);
    expect(output).toContain(
      'HCM_STATE_USER_ID is not set. Copy .env.example to .env and fill it in.',
    );
    expect(output).not.toContain('DID_NOT_THROW');
  });
});
