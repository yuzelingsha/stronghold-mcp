import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { driverConfig } from '../driver/config.mjs';
import { loadDotEnv } from '../mcp/env.js';

describe('configuration', () => {
  it('reads DRIVER_TIMEOUT in seconds, as .env.example and the Python SDK do', () => {
    assert.equal(driverConfig({ DRIVER_TIMEOUT: '180' }).timeoutMs, 180_000);
    assert.equal(driverConfig({}).timeoutMs, 180_000);
    assert.equal(driverConfig({ DRIVER_TIMEOUT: 'junk' }).timeoutMs, 180_000);
  });

  it('loads .env without overriding the environment', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'stronghold-env-')), '.env');
    writeFileSync(file, 'SH_TEST_FROM_FILE=file\nSH_TEST_SET=file\n');
    process.env.SH_TEST_SET = 'env';
    try {
      assert.equal(loadDotEnv(file), file);
      assert.equal(process.env.SH_TEST_FROM_FILE, 'file');
      assert.equal(process.env.SH_TEST_SET, 'env');
      assert.equal(loadDotEnv(join(tmpdir(), 'no-such-dir', '.env')), null, 'a missing .env is not an error');
    } finally {
      delete process.env.SH_TEST_FROM_FILE;
      delete process.env.SH_TEST_SET;
    }
  });
});
