import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { importSpecifiers, normalizeUrlPath, resolveUrlPath } from '../mcp/sim/crawl.js';
import { LAYOUT, diskRelFor, materialPathFor } from '../mcp/sim/store.js';

describe('module specifier scanning', () => {
  it('finds every form of static and literal dynamic import', () => {
    const source = [
      "import a from './a.js';",
      "import './b.js';",
      "import { c } from './c.js';",
      "import * as d from '../d.js';",
      "export { e } from './e.js';",
      "export * from '/shared/f.js';",
      "const g = await import('./g.js');",
    ].join('\n');
    assert.deepEqual(importSpecifiers(source).sort(), [
      '../d.js', './a.js', './b.js', './c.js', './e.js', './g.js', '/shared/f.js',
    ].sort());
  });

  it('ignores string literals that are not module paths', () => {
    // The path-shape filter is what makes a regex safe here: none of these start with ./ and end in .js.
    const source = [
      "export const s = 'hello.js';",
      "const url = 'https://example.test/a.js';",
      "// import './commented-out.js';",
      "const t = `./template.js`;",
      "import x from 'some-package';",
      "import fs from 'node:fs';",
      "import y from './styles.css';",
    ].join('\n');
    assert.deepEqual(importSpecifiers(source), []);
  });

  it('strips a query string from a specifier', () => {
    assert.deepEqual(importSpecifiers("import z from './z.js?v=abc';"), ['./z.js']);
  });
});

describe('url path resolution', () => {
  it('resolves relative specifiers against the importer', () => {
    assert.equal(resolveUrlPath('/sim/spec.js', './Battle.js'), '/sim/Battle.js');
    assert.equal(resolveUrlPath('/sim/spec.js', '../shared/potential.js'), '/shared/potential.js');
    assert.equal(resolveUrlPath('/sim/content/support/index.js', '../../../data.js'), '/data.js');
  });

  it('keeps absolute specifiers', () => {
    assert.equal(resolveUrlPath('/sim/a.js', '/shared/b.js'), '/shared/b.js');
  });

  it('clamps at the root the way HTTP does', () => {
    // `/sim/x.js` + `../../y.js` is `/y.js` over HTTP, because there is nothing above the root.
    assert.equal(resolveUrlPath('/sim/x.js', '../../y.js'), '/y.js');
  });

  it('collapses dot segments', () => {
    assert.equal(normalizeUrlPath('/a/./b/../c.js'), '/a/c.js');
    assert.equal(normalizeUrlPath('//a//b.js'), '/a/b.js');
  });
});

describe('materialized layout', () => {
  it('reproduces the repository layout, not the url layout', () => {
    // This is load-bearing: `server/sim/simdata.js` imports `../../shared/loadoutRecord.js` and
    // `server/sim/content/support/index.js` imports `../../../data.js`, so the depth must match the
    // real repository or those specifiers escape a level too far on a filesystem.
    assert.equal(diskRelFor('/sim/spec.js'), 'server/sim/spec.js');
    assert.equal(diskRelFor('/sim/content/support/index.js'), 'server/sim/content/support/index.js');
    assert.equal(diskRelFor('/shared/loadoutRecord.js'), 'shared/loadoutRecord.js');
    assert.equal(diskRelFor('/shared/plugins/officialBounds.js'), 'shared/plugins/officialBounds.js');
    assert.equal(diskRelFor('/data.js'), 'server/data.js', 'the stand-in replaces server/data.js in the graph');
    assert.equal(diskRelFor('/data/chess.json'), 'data/chess.json');
  });

  it('joins onto a directory', () => {
    assert.equal(materialPathFor('/tmp/tree', '/sim/a.js'), join('/tmp/tree', 'server/sim/a.js'));
  });

  it('refuses a path that would escape the tree', () => {
    assert.throws(() => diskRelFor('/sim/../../../etc/passwd'), /escapes the root/);
    assert.throws(() => diskRelFor('/'), /empty path/);
  });

  it('keeps the loader layout consistent with the mapping', () => {
    assert.deepEqual(LAYOUT.spec, ['server', 'sim', 'spec.js']);
    assert.deepEqual(LAYOUT.shim, ['server', 'data.js']);
    assert.deepEqual(LAYOUT.bounds, ['shared', 'plugins', 'officialBounds.js']);
  });
});
