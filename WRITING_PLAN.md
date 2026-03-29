# Kế Hoạch Viết Tài Liệu Kafka

> **Nguồn tham khảo**: `source/kafka_spring_boot_deep_dive.md` (3000 dòng, ~160KB)
> **Project path**: `/home/hieptran/Desktop/kafka-learn/content/docs/`
> **Stack**: Next.js 15 + Fumadocs + Cloudflare Pages

---

## Trạng Thái Hiện Tại

### Files đã có ✅
| File | Trạng thái |
|------|-----------|
| `fundamentals/kafka-overview.md` | ✅ Có — cần mở rộng thêm |
| `fundamentals/why-kafka.md` | ✅ Có |
| `core-concepts/topics-partitions.md` | ✅ Có — cần thêm Log abstraction |

### Files trong meta.json nhưng chưa tồn tại ⚠️
| File | Vị trí |
|------|--------|
| `fundamentals/kafka-vs-others.md` | `fundamentals/meta.json` |
| `core-concepts/brokers-cluster.md` | `core-concepts/meta.json` |
| `core-concepts/producers.md` | `core-concepts/meta.json` |
| `core-concepts/consumers.md` | `core-concepts/meta.json` |

---

## Danh Sách File Cần Tạo Mới

### 🔴 Sprint 1 — Core Concepts (Deep-dive, ưu tiên cao nhất)

- [x] `core-concepts/consumer-groups.md` ✅
- [x] `core-concepts/offsets.md` ✅
- [x] `core-concepts/partitioning-strategy.md` ✅

### 🟡 Sprint 2 — Spring Boot Integration

- [x] `setup/meta.json` ✅
- [x] `setup/spring-boot.md` ✅
- [x] `producers-consumers/producer-api.md` ✅
- [x] `producers-consumers/consumer-api.md` ✅
- [x] `producers-consumers/serialization.md` ✅

### 🟠 Sprint 3 — Advanced Topics

- [ ] `producers-consumers/transactions.md`
- [ ] `producers-consumers/exactly-once.md`
- [ ] `producers-consumers/retry-dlt.md`

### 🟢 Sprint 4 — Operations & Fill Gaps

- [ ] `operations/meta.json`
- [ ] `operations/production-checklist.md`
- [ ] `setup/testing.md`
- [ ] `core-concepts/brokers-cluster.md`
- [ ] `core-concepts/producers.md`
- [ ] `core-concepts/consumers.md`
- [ ] `fundamentals/kafka-vs-others.md`

---

## Meta.json Cần Cập Nhật

### `content/docs/meta.json` — thêm "setup"
```json
{
  "pages": [
    "fundamentals",
    "core-concepts",
    "setup",
    "producers-consumers",
    "streams",
    "connect",
    "operations"
  ]
}
```

### `core-concepts/meta.json` — thêm 3 file mới
```json
{
  "title": "Core Concepts",
  "pages": [
    "topics-partitions",
    "brokers-cluster",
    "producers",
    "consumers",
    "consumer-groups",
    "offsets",
    "partitioning-strategy"
  ]
}
```

### `producers-consumers/meta.json` — thêm 5 file mới
```json
{
  "title": "Producers & Consumers",
  "pages": [
    "producer-api",
    "consumer-api",
    "serialization",
    "transactions",
    "exactly-once",
    "retry-dlt"
  ]
}
```

### `setup/meta.json` — tạo mới
```json
{
  "title": "Setup & Cấu Hình",
  "pages": [
    "spring-boot",
    "testing"
  ]
}
```

### `operations/meta.json` — tạo/cập nhật
```json
{
  "title": "Operations",
  "pages": [
    "production-checklist"
  ]
}
```

---

## Chi Tiết Nội Dung Từng File

### `core-concepts/consumer-groups.md` ⭐
**Source**: Section 1.3 (lines 79–286)

Sections cần viết:
- Tổng quan Consumer Group — rule: 1 partition → 1 consumer within group
- Multiple Consumer Groups: Pub/Sub pattern
- Rebalancing Protocol: FindCoordinator → JoinGroup → SyncGroup
- Sequence diagram: consumer mới join trigger rebalance
- Real World: scaling từ 1 → 2 consumer trên 4 partitions
- AckMode table: `RECORD` / `BATCH` / `TIME` / `COUNT` / `MANUAL` / `MANUAL_IMMEDIATE`
- Best Practices

---

### `core-concepts/offsets.md` ⭐⭐
**Source**: Section 1.3 Deep Dive (lines 158–844)

Sections cần viết:
- `__consumer_offsets` topic structure (50 partitions, log compaction)
- Key Structure: `(group.id, topic, partition)` → value: offset + timestamp
- Diagram: Multiple groups independent offsets (mermaid)
- Offset Commit Flow (flowchart)
- **5 Kịch bản Lifecycle** (mỗi kịch bản có ASCII diagram + sequence diagram):
  1. Consumer crash
  2. Consumer mới join
  3. Graceful Shutdown vs Crash (table so sánh)
  4. All Consumers Leave — offsets.retention.minutes (7 days)
  5. New Consumer Group — auto.offset.reset: earliest/latest/none
- State Machine tổng hợp (stateDiagram)
- Offset Behavior Matrix — 7 dòng tóm tắt
- CLI Commands: `kafka-consumer-groups.sh`
- Consumer Lag (formula + interpretation table)
- 5 Reset Strategies (bash commands)
- Spring Boot monitoring (Actuator metrics)
- Common Pitfalls

---

### `core-concepts/partitioning-strategy.md` ⭐⭐
**Source**: Section 9 (lines 1319–1944)

Sections cần viết:
- Decision Flowchart: dùng key hay không?
- 5 Key Strategies comparison table
- Option A: No Key — Sticky Partitioning
- Option B: With Key — `hash(key) % num_partitions`
- Trade-off Matrix (ordering vs load balance)
- **Hot Partitions Deep Dive**:
  - ASCII visualization: P2 nhận 50,000 msg/s
  - 3 nguyên nhân (flowchart)
  - 3 Real-world examples: E-Commerce Flash Sale, Viral Tweet, IoT Sensors
  - Detection: CLI + JMX + Prometheus
  - **4 Solutions** với Java code:
    1. Key Salting (`SaltedKeyProducer` + `sendEventWithConsistentSalt`)
    2. Custom Partitioner (`HotKeyAwarePartitioner`)
    3. Separate Topics (`TopicRoutingProducer`)
    4. Increase Partitions (và giới hạn — không fix single hot key)
  - Solution Comparison Matrix
  - Decision Flowchart
  - Prometheus Alert Rules YAML

---

### `setup/spring-boot.md`
**Source**: Sections 2–3 (lines 846–983)

Sections cần viết:
- Maven dependency (`spring-kafka`)
- Gradle dependency
- Basic `application.yml` + property table đầy đủ (producer + consumer)
- JSON serialization config + trusted.packages security warning
- Serializer/Deserializer comparison: String / JSON / Avro / Protobuf / Bytes
- Spring Kafka Component Reference (7 components table)
- Architecture flowchart: Producer Side / Consumer Side

---

### `producers-consumers/producer-api.md`
**Source**: Section 4 (lines 987–1041) + Section 13 (lines 2947–3000)

Sections cần viết:
- KafkaTemplate methods quick reference (table + partition selection logic)
- Simple production (async)
- Callback handling (`CompletableFuture.whenComplete`)
- 4 Send patterns code:
  - Fire and forget
  - With callback (recommended)
  - Synchronous (`.get()`)
  - With headers (`ProducerRecord`)

---

### `producers-consumers/consumer-api.md`
**Source**: Section 5 (lines 1043–1127) + Section 13

Sections cần viết:
- `@KafkaListener` annotation parameters (table)
- Simple listener → Headers injection → Manual ack → Batch (progression)
- `@Header` constants table
- Concurrency scaling table (partitions × instances × concurrency)
- Formula: `Active Threads = min(Total Threads, Total Partitions)`

---

### `producers-consumers/serialization.md`
**Source**: Section 3.3 (lines 947–983)

Sections cần viết:
- 5 Formats comparison (String / JSON / Avro / Protobuf / Bytes)
- JSON YAML config (producer + consumer)
- trusted.packages security best practices
- Avro + Schema Registry overview

---

### `producers-consumers/transactions.md`
**Source**: Section 6 (lines 1129–1235)

Sections cần viết:
- The "Dual Write" Problem
- Solution 1: Transactional Synchronization (1PC)
  - Sequence diagram: success path + failure path
  - Caveat: DB commit OK nhưng Kafka abort fail
- Solution 2: Transactional Outbox Pattern (giới thiệu)
- Error Handling: `DefaultErrorHandler` + `DeadLetterPublishingRecoverer`
- `FixedBackOff` config
- Retry flow diagram

---

### `producers-consumers/exactly-once.md` ⭐
**Source**: Sections 10–10.5 (lines 1947–2694)

Sections cần viết:
- 3 Delivery Guarantees table (at-most / at-least / exactly-once)
- EOS Requirements + YAML config
- Consume-Transform-Produce pattern (sequence diagram)
- When EOS Works/Doesn't Work (flowchart)
- **Idempotency Deep Dive**:
  - Duplicate Problem — ASCII visualization
  - 2 Types: Producer Idempotency (built-in) vs Consumer Idempotency (app code)
  - Producer: PID + Sequence Number mechanism
  - Producer Limitations (new session = new PID)
  - Consumer Strategies:
    1. Natural Idempotency (SET, UPSERT, DELETE)
    2. Deduplication Table (`IdempotentPaymentConsumer` Java code)
    3. Idempotency Key (Stripe API Java code)
  - E-Commerce Order Processing real-world example
  - Complete Idempotency Checklist

---

### `producers-consumers/retry-dlt.md`
**Source**: Section 11 (lines 2696–2819)

Sections cần viết:
- Blocking Retry Problem (diagram)
- Non-Blocking Retry Topics solution (diagram)
- `RetryTopicConfigurationBuilder` bean config
- `@RetryableTopic` annotation + `@DltHandler`
- Topic naming convention table (`orders`, `orders-retry-0`, ..., `orders-dlt`)
- Exponential Backoff sequence diagram
- When to use vs not use retry topics

---

### `operations/production-checklist.md`
**Source**: Section 12 (lines 2822–2944)

Sections cần viết:
- Producer Config Checklist (Dev vs Prod comparison, 7 settings)
- Consumer Config Checklist (Dev vs Prod, 6 settings)
- Topic Design Best Practices (table)
- Operational Readiness Checklist:
  - ✅ Configuration
  - 📊 Monitoring
  - 🔄 Operations
  - 🧪 Testing
  - 📚 Documentation
- Common Production Issues & Solutions (6 issues table)

---

### `setup/testing.md`
**Source**: Section 7 (lines 1238–1260)

Sections cần viết:
- `@EmbeddedKafka` annotation
- `@SpringBootTest` + embedded broker setup
- Code example: send + verify consumption
- Tips: dùng Awaitility cho async assertions

---

## Quy Tắc Viết

1. **Ngôn ngữ**: Tiếng Việt toàn bộ — giữ Anh cho tên kỹ thuật, code, config
2. **Diagrams**: Giữ nguyên Mermaid và ASCII art từ source
3. **Code examples**: Giữ nguyên Java code, thêm comment tiếng Việt
4. **Frontmatter**: Bắt buộc `title` + `description`
5. **Meta.json**: Cập nhật ngay khi tạo file
6. **Deep-dive files**: 10+ H2 sections (`offsets.md`, `partitioning-strategy.md`, `exactly-once.md`)

---

## Ước Tính Khối Lượng

| File | ⭐ | Dòng ước tính |
|------|----|--------------|
| `offsets.md` | ⭐⭐⭐ | ~800 |
| `partitioning-strategy.md` | ⭐⭐⭐ | ~600 |
| `exactly-once.md` | ⭐⭐⭐ | ~600 |
| `consumer-groups.md` | ⭐⭐ | ~400 |
| `transactions.md` | ⭐⭐ | ~300 |
| `retry-dlt.md` | ⭐⭐ | ~250 |
| `spring-boot.md` | ⭐ | ~250 |
| `producer-api.md` | ⭐ | ~200 |
| `consumer-api.md` | ⭐ | ~200 |
| 6 files còn lại | ⭐ | ~100–150 mỗi file |

**Tổng: ~4,500–5,000 dòng doc**
