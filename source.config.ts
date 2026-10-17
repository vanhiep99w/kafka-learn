import { remarkDirectiveAdmonition } from 'fumadocs-core/mdx-plugins';
import { defineDocs, defineConfig } from 'fumadocs-mdx/config';
import remarkGithubAdmonitions from 'remark-github-admonitions-to-directives';
import { remarkD2 } from '@vanhiep99w/docs-kit/d2';
import { remarkTerminalSession } from '@vanhiep99w/docs-kit/terminal-session';
import { remarkCodeDiff } from '@vanhiep99w/docs-kit/code-diff';
import { remarkCodeWalkthrough } from '@vanhiep99w/docs-kit/code-walkthrough';
import { remarkProtocolExchange } from '@vanhiep99w/docs-kit/protocol-exchange';
import { remarkSpanWaterfall } from '@vanhiep99w/docs-kit/span-waterfall';

export const docs = defineDocs({
  dir: 'content/docs',
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [
      remarkGithubAdmonitions,
      remarkDirectiveAdmonition,
      [remarkD2, {
        sketch: false,
        scale: 1,
        interactive: true,
        defaultCaption: 'Sơ đồ',
        assetsRoot: 'content/assets/d2',
        cacheDir: '.next/cache/docs-kit/d2',
      }],
      remarkTerminalSession,
      remarkCodeDiff,
      remarkCodeWalkthrough,
      remarkProtocolExchange,
      remarkSpanWaterfall,
    ],
  },
});
