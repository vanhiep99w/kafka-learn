import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { remarkD2 } from '@vanhiep99w/docs-kit/d2';
import { remarkTerminalSession } from '@vanhiep99w/docs-kit/terminal-session';
import { remarkCodeDiff } from '@vanhiep99w/docs-kit/code-diff';
import { remarkCodeWalkthrough } from '@vanhiep99w/docs-kit/code-walkthrough';
import { remarkProtocolExchange } from '@vanhiep99w/docs-kit/protocol-exchange';
import { remarkSpanWaterfall } from '@vanhiep99w/docs-kit/span-waterfall';

const fenceComponents = new Map([
  ['d2', ['D2Diagram', 'D2InteractiveDiagram']],
  ['terminal-session', ['TerminalSession']],
  ['code-diff', ['CodeDiff']],
  ['code-walkthrough', ['CodeWalkthrough']],
  ['protocol-exchange', ['ProtocolExchange']],
  ['span-waterfall', ['SpanWaterfall']],
]);

async function* documents(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* documents(file);
    else if (/\.mdx?$/.test(file)) yield file;
  }
}

function collect(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  for (const child of node.children ?? []) collect(child, predicate, found);
  return found;
}

// Use the real build-time plugins, not snapshots of their serialized internals.
// remark-parse is enough to find fences; the production build additionally checks MDX.
const processor = unified().use(remarkParse)
  .use(remarkD2, {
    sketch: false,
    scale: 1,
    interactive: true,
    defaultCaption: 'Sơ đồ',
    assetsRoot: 'content/assets/d2',
    cacheDir: '.next/cache/docs-kit/d2',
  })
  .use(remarkTerminalSession)
  .use(remarkCodeDiff)
  .use(remarkCodeWalkthrough)
  .use(remarkProtocolExchange)
  .use(remarkSpanWaterfall);

test('docs-kit fences compile to the registered components', async (t) => {
  const totals = new Map([...fenceComponents.keys()].map((lang) => [lang, 0]));
  for await (const file of documents('content/docs')) {
    await t.test(file, async () => {
      const value = await readFile(file, 'utf8');
      const tree = processor.parse(value);
      const fences = collect(tree, (node) => node.type === 'code');
      assert.equal(fences.filter((node) => node.lang === 'mermaid').length, 0,
        `${file}: migrate new diagrams to D2`);
      const expected = new Map();
      for (const node of fences) {
        if (!fenceComponents.has(node.lang)) continue;
        totals.set(node.lang, totals.get(node.lang) + 1);
        expected.set(node.lang, (expected.get(node.lang) ?? 0) + 1);
      }
      const output = await processor.run(tree, { path: file, value });
      for (const [lang, count] of expected) {
        const names = fenceComponents.get(lang);
        const rendered = collect(output,
          (node) => node.type === 'mdxJsxFlowElement' && names.includes(node.name));
        assert.equal(rendered.length, count, `${file}: ${lang} fences must render`);
      }
      assert.equal(collect(output,
        (node) => node.type === 'code' && fenceComponents.has(node.lang)).length, 0);
    });
  }
  for (const [lang, count] of totals) {
    assert.ok(count > 0, `${lang} integration needs a real documentation example`);
    t.diagnostic(`${lang}: ${count} fences`);
  }
});

test('all docs-kit fence components and styles stay registered', async () => {
  const components = await readFile('src/mdx-components.tsx', 'utf8');
  const styles = await readFile('src/app/globals.css', 'utf8');
  const config = await readFile('source.config.ts', 'utf8');
  for (const [lang, names] of fenceComponents) {
    for (const name of names) assert.match(components, new RegExp(`\\b${name}\\b`));
    assert.ok(styles.includes(`@vanhiep99w/docs-kit/styles/${lang}.css`));
    assert.ok(config.includes(`@vanhiep99w/docs-kit/${lang}`));
  }
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.ok(!pkg.dependencies.mermaid, 'do not ship the old Mermaid renderer');
});
