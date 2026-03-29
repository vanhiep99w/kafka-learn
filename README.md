# Kafka Learn

Tài liệu học Kafka và Spring Boot bằng tiếng Việt, xây dựng bằng Next.js + Fumadocs và triển khai trên Cloudflare Pages.

## Nội Dung

- **Fundamentals** — Kafka overview, tại sao dùng Kafka, so sánh với các hệ thống khác
- **Core Concepts** — Topics, Partitions, Brokers, Consumer Groups, Offsets, Partitioning Strategy
- **Setup** — Cấu hình Spring Boot, Testing
- **Producers & Consumers** — API, Serialization, Transactions, Exactly-Once, Retry & DLT
- **Streams** — Kafka Streams
- **Connect** — Kafka Connect
- **Operations** — Production Checklist

## Tech Stack

- **Framework**: Next.js 15 + React 19
- **Docs Engine**: [Fumadocs](https://fumadocs.vercel.app/) (fumadocs-mdx + fumadocs-ui)
- **Diagrams**: Mermaid
- **Hosting**: Cloudflare Pages
- **Language**: TypeScript

## Getting Started

```bash
# Install dependencies
npm install

# Run dev server
npm run dev

# Build for production
npm run build

# Preview production build locally
npm run preview

# Deploy to Cloudflare Pages
npm run deploy
```

## Project Structure

```
├── content/docs/          # MDX documentation files
│   ├── fundamentals/      # Kafka basics
│   ├── core-concepts/     # Deep-dive concepts
│   ├── setup/             # Spring Boot setup
│   ├── producers-consumers/# Producer/Consumer APIs
│   ├── streams/           # Kafka Streams
│   ├── connect/           # Kafka Connect
│   └── operations/        # Production ops
├── source/                # Reference source material
├── src/                   # Next.js app source
├── source.config.ts       # Fumadocs MDX config
├── wrangler.toml          # Cloudflare Pages config
└── WRITING_PLAN.md        # Writing progress tracker
```

## License

MIT
