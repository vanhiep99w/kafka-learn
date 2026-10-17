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

- **Framework**: Next.js 16 + React 19
- **Docs Engine**: [Fumadocs](https://fumadocs.vercel.app/) (fumadocs-mdx + fumadocs-ui)
- **Diagrams & interactive examples**: D2 + [@vanhiep99w/docs-kit](https://www.npmjs.com/package/@vanhiep99w/docs-kit) (build-time rendering)
- **Hosting**: Cloudflare Pages
- **Language**: TypeScript

## Getting Started

Cần **Node.js 22+**. D2 chạy bằng WASM lúc build, không cần cài D2 CLI, Go hoặc server render.

```bash
# Install dependencies
npm ci

# Run dev server
npm run dev

# Validate diagrams / example descriptors
npm run test:docs

# Typecheck
npm run typecheck

# Build for production (also validates MDX + static export)
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
├── content/assets/d2/     # Vendored diagram icons + attribution
├── tests/                 # docs-kit integration/content checks
├── source/                # Reference source material
├── src/                   # Next.js app source
├── source.config.ts       # Fumadocs MDX config
├── wrangler.toml          # Cloudflare Pages config
└── WRITING_PLAN.md        # Writing progress tracker
```

## Viết sơ đồ và ví dụ tương tác

Plugin build-time được đăng ký trong `source.config.ts`; map component dùng chung ở `src/mdx-components.tsx`; stylesheet được import một lần ở `src/app/globals.css`. Không import các entry point build-time (`/d2`, `/code-diff`, …) vào client component.

### D2 thay cho Mermaid / ASCII diagrams

Dùng fence `d2` có tiêu đề mô tả. Source vẫn là text trong Git; SVG light/dark được dựng sẵn khi build. Mặc định có nút **Explore diagram** để mở viewer lazy-loaded: fit, zoom/pan, fullscreen, xem/copy D2 và tải SVG. Không đưa compiler/WASM vào browser.

````md
```d2 title="Producer và consumer"
direction: right
producer: Producer
kafka: Kafka topic
consumer: Consumer
producer -> kafka: Produce
kafka -> consumer: Poll
```
````

- Ưu tiên nhãn ngắn, xuống dòng bằng `\n`; dùng `shape: sequence_diagram` khi thứ tự trao đổi quan trọng.
- Các ký tự đặc biệt trong nhãn nên được quote; escape dấu dollar thành `\$` để không bị hiểu là substitution của D2.
- Đặt `interactive=false` trên fence nếu chỉ cần SVG tĩnh, hoặc `layout="dagre"` / `layout="tala"` khi sơ đồ cần bố cục khác ELK mặc định.
- Dùng `mode=tabs` + `scenarios` cho các trạng thái độc lập, `mode=steps` + `steps` cho các bước kế thừa nhau. Ví dụ thực tế: `content/docs/core-concepts/offsets.md`.
- Icon từ D2 Icons được lưu tại `content/assets/d2/`, kèm nguồn và license. Trong bài dưới `content/docs/<section>/`, dùng `icon: ../../assets/d2/postgresql.svg`. Build nhúng icon vào SVG, không hotlink lúc người đọc mở trang.
- Giữ cây thư mục, output CLI/log, payload và công thức ở dạng code/text khi vị trí ký tự có ý nghĩa. Dùng bảng cho số liệu và Callout cho các khung ghi nhớ, không biến cả đoạn văn thành node D2.
- `source/` là tài liệu tham khảo gốc, không đi qua pipeline render và không bị chuyển đổi.

### Chọn component theo nội dung

| Fence | Dùng khi | Ví dụ trong repo |
| --- | --- | --- |
| `terminal-session` | Lệnh theo bước, đúng môi trường, copy riêng từng command | `setup/docker-setup.md` |
| `code-walkthrough` | Đọc code theo vùng highlight / bước giải thích | `producers-consumers/producer-api.md` |
| `code-diff` | So sánh config/code trước và sau | `interview/rebalance-stop-the-world.md` |
| `protocol-exchange` | Request / response HTTP tĩnh | `connect/connect-overview.md` |
| `span-waterfall` | Timeline có thang thời gian chính xác | `interview/rebalance-stop-the-world.md` |

Các fence trên chứa YAML descriptor. Sao chép schema từ ví dụ tương ứng hoặc [tài liệu docs-kit](https://github.com/vanhiep99w/docs-kit#readme). Không dùng Source Explorer khi chưa có source project/manifest thực tế. Các transcript, HTTP response và timeline minh họa không thực thi lệnh, gọi dịch vụ hay chứng minh hiệu năng; luôn ghi rõ dữ liệu tổng hợp, không đưa secrets vào docs.

`npm run test:docs` chạy các plugin thực tế trên toàn bộ docs để kiểm tra D2, YAML/schema, ranges và component mapping. `npm run build` kiểm tra thêm MDX, React server rendering và static export.

### Cache và Cloudflare Pages

D2 cache nằm ở `.next/cache/docs-kit/d2`, tách khỏi output deploy `dist/` và đã được `.gitignore` bỏ qua. Bật Build Cache trên Cloudflare Pages và dùng Node.js 22+ cho môi trường build. Khi cache lạnh, docs-kit dùng một worker mặc định để giới hạn RAM; không cần tăng concurrency nếu chưa đo trên CI.

## License

MIT
