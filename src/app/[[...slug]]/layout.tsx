import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import type { ReactNode } from 'react';
import { source } from '@/lib/source';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{ title: 'Kafka Learning' }}
      sidebar={{
        banner: (
          <div style={{ padding: '0.5rem', fontSize: '0.75rem', color: 'var(--fd-muted-foreground)' }}>
            Apache Kafka — Deep Dive
          </div>
        ),
      }}
    >
      {children}
    </DocsLayout>
  );
}
