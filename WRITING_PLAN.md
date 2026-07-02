# Kế Hoạch Viết Tài Liệu Kafka

> **Nguồn tham khảo**: `source/kafka_spring_boot_deep_dive.md` (3000 dòng, ~160KB)
> **Project path**: `/home/hieptran/Desktop/kafka-learn/content/docs/`
> **Stack**: Next.js 15 + Fumadocs + Cloudflare Pages

---

## Trạng Thái Hiện Tại

> ✅ **Tất cả nội dung đã hoàn thành.** Tổng cộng **29 file** / **~11.225 dòng** doc (vượt ~2x mục tiêu ban đầu).

### Tổng quan theo mục

| Mục | Số trang | Trạng thái |
|------|----------|-----------|
| Fundamentals | 3 | ✅ Hoàn thành |
| Core Concepts | 7 | ✅ Hoàn thành |
| Setup | 3 | ✅ Hoàn thành |
| Producers & Consumers | 7 | ✅ Hoàn thành |
| Streams | 2 | ✅ Hoàn thành |
| Connect | 2 | ✅ Hoàn thành |
| Operations | 4 | ✅ Hoàn thành |
| Quick Reference | 1 | ✅ Hoàn thành |

### Danh sách file đầy đủ

| File | Dòng | Trạng thái |
|------|------|-----------|
| `fundamentals/kafka-overview.md` | 228 | ✅ |
| `fundamentals/why-kafka.md` | 128 | ✅ |
| `fundamentals/kafka-vs-others.md` | 235 | ✅ |
| `core-concepts/topics-partitions.md` | 184 | ✅ |
| `core-concepts/brokers-cluster.md` | 301 | ✅ |
| `core-concepts/producers.md` | 229 | ✅ |
| `core-concepts/consumers.md` | 388 | ✅ |
| `core-concepts/consumer-groups.md` | 342 | ✅ |
| `core-concepts/offsets.md` | 709 | ✅ |
| `core-concepts/partitioning-strategy.md` | 603 | ✅ |
| `setup/spring-boot.md` | 268 | ✅ |
| `setup/docker-setup.md` | 225 | ✅ |
| `setup/testing.md` | 729 | ✅ |
| `producers-consumers/producer-api.md` | 299 | ✅ |
| `producers-consumers/consumer-api.md` | 419 | ✅ |
| `producers-consumers/serialization.md` | 398 | ✅ |
| `producers-consumers/transactions.md` | 483 | ✅ |
| `producers-consumers/exactly-once.md` | 296 | ✅ |
| `producers-consumers/idempotency.md` | 528 | ✅ |
| `producers-consumers/retry-dlt.md` | 516 | ✅ |
| `streams/streams-overview.md` | 304 | ✅ |
| `streams/streams-api.md` | 613 | ✅ |
| `connect/connect-overview.md` | 394 | ✅ |
| `connect/connectors.md` | 611 | ✅ |
| `operations/monitoring.md` | 532 | ✅ |
| `operations/security.md` | 434 | ✅ |
| `operations/performance-tuning.md` | 213 | ✅ |
| `operations/production-checklist.md` | 366 | ✅ |
| `quick-reference.md` | 250 | ✅ |

---

## Meta.json — Đã cập nhật đầy đủ

Tất cả entry trong sidebar (`meta.json`) đều khớp với file trên disk, không có broken link.

- `content/docs/meta.json` — 7 mục (fundamentals → core-concepts → setup → producers-consumers → streams → connect → operations)
- `core-concepts/meta.json` — 7 trang
- `producers-consumers/meta.json` — 7 trang (đã thêm `idempotency`)
- `setup/meta.json` — 3 trang
- `operations/meta.json` — 4 trang
- `fundamentals/meta.json` / `streams/meta.json` / `connect/meta.json` — tương ứng

---

## Quy Tắc Viết (đã tuân thủ)

1. **Ngôn ngữ**: Tiếng Việt toàn bộ — giữ Anh cho tên kỹ thuật, code, config ✅
2. **Diagrams**: Mermaid (client-side render) và ASCII art từ source ✅
3. **Code examples**: Java code + comment tiếng Việt ✅
4. **Frontmatter**: `title` + `description` bắt buộc (100% file đạt) ✅
5. **Meta.json**: Cập nhật ngay khi tạo file ✅
6. **Deep-dive files**: 10+ H2 sections (`offsets.md`, `partitioning-strategy.md`, `exactly-once.md`) ✅

---

## Bước Tiếp Theo (tùy chọn)

Vì nội dung đã hoàn thành, các hướng phát triển tiếp theo có thể:

- **Polish**: Rà soát lại diagram Mermaid, cross-link giữa các bài, typo
- **Build verification**: `npm run build` đảm bảo static export không lỗi
- **SEO/Meta**: Bổ sung Open Graph image, description tối ưu cho từng trang
- **UX**: Dark mode, anchor link, "Edit on GitHub" link, breadcrumbs
- **Mở rộng nội dung**: Schema Registry, Kafka Streams Interactive Queries, KRaft mode, Migration guide
