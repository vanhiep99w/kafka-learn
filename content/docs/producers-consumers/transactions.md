---
title: "Kafka Transactions"
description: "Deep dive vào Kafka Transactions: Dual Write Problem, DB+Kafka transaction synchronization, và Transactional Outbox Pattern — giải pháp đảm bảo consistency giữa Database và Kafka"
---

# Kafka Transactions

## Mục lục

- [The Dual Write Problem](#the-dual-write-problem)
- [Solution 1: Transactional Synchronization (1PC)](#solution-1-transactional-synchronization-1pc)
- [Sequence Diagram: Thành công và Thất bại](#sequence-diagram-thành-công-và-thất-bại)
- [Caveat: The Last-Mile Problem](#caveat-the-last-mile-problem)
- [Solution 2: Transactional Outbox Pattern](#solution-2-transactional-outbox-pattern)
- [Implementation: Outbox Pattern trong Spring Boot](#implementation-outbox-pattern-trong-spring-boot)
- [Consume-Transform-Produce (Kafka → Kafka)](#consume-transform-produce-kafka--kafka)
- [Zombie Fencing & Epoch — chống producer "xác sống"](#zombie-fencing--epoch--chống-producer-xác-sống)
- [So sánh các Approaches](#so-sánh-các-approaches)

---

## The Dual Write Problem

Đây là bài toán xảy ra mọi lúc trong microservices: bạn muốn **lưu dữ liệu vào DB** VÀ **gửi event lên Kafka** trong cùng một "business operation".

```d2 title="Dual write không atomic giữa DB và Kafka"
direction: right
service: Order Service
db: Database
kafka: Kafka
service -> db: 1. Save order
service -> kafka: 2. Send event
cases: "Các cửa sổ lỗi" {
  a: "DB thành công, Kafka lỗi\nOrder tồn tại nhưng inventory / email / payment không biết"
  b: "Kafka thành công, DB rollback\nDownstream xử lý ghost order"
  c: "Crash giữa bước 1 và 2\nDB commit, Kafka chưa send — mất event"
}
note: "Mong muốn: cả hai thành công hoặc cả hai thất bại\nHai thao tác độc lập không tự có atomicity"
```

> [!CAUTION]
> **Không có "true distributed transaction"** giữa Database và Kafka (XA transactions tồn tại nhưng rất chậm và phức tạp). Kafka không hỗ trợ XA. Thay vào đó, dùng các patterns được thiết kế cho distributed systems.

---

## Solution 1: Transactional Synchronization (1PC)

Spring Kafka cho phép **synchronize** Kafka transaction với DB transaction. Đây không phải true XA nhưng xử lý được 99% cases.

### Cách hoạt động

```d2 title="Cách hoạt động"
direction: right
g1: "@Transactional Method" {
  A: "Begin DB Tx"
  B: "DB Operations"
  C: "Send to Kafka\n(Tx Pending - invisible)"
  D: "DB Commit?" { shape: diamond }
}
E: "Kafka Tx Commit\nMsg visible"
F: "DB Rollback\nKafka Tx Abort\nMsg discarded"
g1.A -> g1.B
g1.B -> g1.C
g1.C -> g1.D
g1.D -> E: "Success"
g1.D -> F: "Failure"
```

### Setup

**Bước 1: Enable transactional producer**

```yaml
spring:
  kafka:
    producer:
      transaction-id-prefix: tx-order-service-
      acks: all
```

**Bước 2: Dùng `@Transactional`**

```java
@Service
public class OrderService {

    private final KafkaTemplate<String, OrderEvent> kafkaTemplate;
    private final OrderRepository orderRepo;

    @Transactional  // ← Spring DB transaction
    public OrderDto createOrder(CreateOrderRequest request) {
        // Step 1: Save to DB — trong DB transaction
        Order order = Order.from(request);
        orderRepo.save(order);

        // Step 2: Send to Kafka — join DB transaction "logically"
        // Message được broker lưu nhưng status = PENDING (consumers không thấy)
        // Chỉ trở thành COMMITTED khi DB transaction commit thành công
        kafkaTemplate.send("orders.created", order.getId(), OrderEvent.from(order));

        // Nếu exception xảy ra ở đây:
        // → DB rollback
        // → Kafka abort transaction → message bị discard
        return OrderDto.from(order);
    }
}
```

> [!NOTE]
> **Điều kiện**: `KafkaTemplate` phải được cấu hình với `transaction-id-prefix`. Spring sẽ tự động phát hiện và join transaction của DB.

---

## Sequence Diagram: Thành công và Thất bại

### Happy Path

```d2 title="Happy Path"
shape: sequence_diagram
Client: "Client"
App: "Order Service"
DB: "Database"
Kafka: "Kafka Broker"
Consumer: "Downstream Consumer"
Client -> App: "POST /orders"
App -> DB: "BEGIN TRANSACTION"
App -> DB: "INSERT INTO orders (id='ord-123', ...)"
App -> Kafka: "Begin Kafka Tx (txId=tx-order-1-0)"
App -> Kafka: "ProducerRecord(topic=orders.created, key=ord-123)"
Kafka.note1: "Message stored but PENDING\nconsumers see nothing yet"
App -> DB: "COMMIT ✅"
App -> Kafka: "COMMIT Transaction ✅"
Kafka.note2: "Message now VISIBLE"
Kafka -> Consumer: "Deliver message" { style.stroke-dash: 4 }
App -> Client: "201 Created" { style.stroke-dash: 4 }
```

### Error Path

```d2 title="Error Path"
shape: sequence_diagram
App: "Order Service"
DB: "Database"
Kafka: "Kafka Broker"
App -> DB: "BEGIN TRANSACTION"
App -> DB: "INSERT INTO orders (id='ord-123', ...)"
App -> Kafka: "ProducerRecord(topic=orders.created, ...)"
Kafka.note1: "Message stored PENDING"
App.note2: "💥 Exception! (e.g. inventory check fails)"
App -> DB: "ROLLBACK ❌"
App -> Kafka: "ABORT Transaction ❌"
Kafka.note3: "Message DISCARDED"
App.note4: "✅ Consistent — neither DB nor Kafka has the data"
```

---

## Caveat: The Last-Mile Problem

> [!WARNING]
> **Vấn đề không thể tránh khỏi với 1PC**: Nếu DB commit **thành công** nhưng Kafka commit **thất bại** (network down, broker crash), bạn vẫn có inconsistency.

```d2 title="Cửa sổ lỗi sau DB commit"
direction: right
db: DB COMMIT thành công
request: Kafka commit request
failure: Network failure
state: "Trạng thái không chắc chắn\nDB có order; commit Kafka có thể chưa tới broker"
impact: "Nếu transaction Kafka không commit:\ninventory không nhận event, không gửi email\nHai hệ thống không nhất quán"
db -> request -> failure -> state -> impact
```

**Xác suất xảy ra**: Nhỏ nhưng không phải zero. Với traffic cao (millions/day), điều này xảy ra.

**Giải pháp**: Transactional Outbox Pattern.

---

## Solution 2: Transactional Outbox Pattern

**Ý tưởng cốt lõi**: Thay vì gửi message *trực tiếp* lên Kafka, lưu message vào một **bảng `outbox`** trong *cùng database transaction* với business data. Một poller riêng đọc bảng này và gửi lên Kafka.

```d2 title="Transactional outbox — atomic DB write, at-least-once publish"
direction: right
tx: "Phase 1 — một DB transaction ACID" {
  begin: BEGIN
  orders: INSERT orders
  outbox: INSERT outbox — event_id, topic, payload, PENDING
  commit: COMMIT
  begin -> orders -> outbox -> commit
}
poller: "Phase 2 — process riêng" {
  select: SELECT outbox WHERE status = PENDING
  send: kafkaTemplate.send — chờ broker ACK
  mark: UPDATE outbox SET status = SENT
  select -> send -> mark
}
kafka: Kafka
tx.commit -> poller.select
poller.send -> kafka
poller.send -> poller.select: Broker down → giữ PENDING, retry {style.stroke-dash: 4}
note: "Publish at-least-once — crash sau send, trước mark có thể duplicate\nConsumer cần idempotency"
```

---

## Implementation: Outbox Pattern trong Spring Boot

### Database Schema

```sql
CREATE TABLE outbox_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id    VARCHAR(255) UNIQUE NOT NULL,   -- Business ID (deduplicate)
    topic       VARCHAR(255) NOT NULL,
    partition_key VARCHAR(255),                  -- Kafka message key
    payload     JSONB NOT NULL,
    status      VARCHAR(50) DEFAULT 'PENDING',  -- PENDING | SENT | FAILED
    created_at  TIMESTAMP DEFAULT NOW(),
    sent_at     TIMESTAMP,
    retry_count INT DEFAULT 0
);

-- Index để poller chạy nhanh
CREATE INDEX idx_outbox_status_created ON outbox_events(status, created_at)
    WHERE status = 'PENDING';
```

### Outbox Entity

```java
@Entity
@Table(name = "outbox_events")
public class OutboxEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(unique = true, nullable = false)
    private String eventId;  // Business-level dedup key

    @Column(nullable = false)
    private String topic;

    private String partitionKey;

    @Column(columnDefinition = "jsonb")
    private String payload;

    @Enumerated(EnumType.STRING)
    private OutboxStatus status = OutboxStatus.PENDING;

    private LocalDateTime createdAt = LocalDateTime.now();
    private LocalDateTime sentAt;
    private int retryCount = 0;

    public enum OutboxStatus {
        PENDING, SENT, FAILED
    }
}
```

### Service Layer: Business Logic + Outbox

```java
@Service
public class OrderService {

    private final OrderRepository orderRepo;
    private final OutboxEventRepository outboxRepo;
    private final ObjectMapper objectMapper;

    @Transactional  // ← SINGLE DB transaction
    public OrderDto createOrder(CreateOrderRequest request) {
        // Step 1: Save business data
        Order order = Order.builder()
            .id(UUID.randomUUID().toString())
            .customerId(request.getCustomerId())
            .totalAmount(request.getTotalAmount())
            .status(OrderStatus.CREATED)
            .build();
        orderRepo.save(order);

        // Step 2: Save outbox event (SAME transaction as order!)
        OutboxEvent outboxEvent = OutboxEvent.builder()
            .eventId("order-created-" + order.getId())  // Unique event ID
            .topic("orders.created")
            .partitionKey(order.getId())
            .payload(objectMapper.writeValueAsString(OrderCreatedEvent.from(order)))
            .build();
        outboxRepo.save(outboxEvent);

        // ✅ Both committed atomically by DB
        // If DB fails → both rolled back → no orphan events
        return OrderDto.from(order);
    }
}
```

### Outbox Poller

```java
@Service
@Slf4j
public class OutboxPoller {

    private final OutboxEventRepository outboxRepo;
    private final KafkaTemplate<String, String> kafkaTemplate;

    // Poll every 1 second
    @Scheduled(fixedDelay = 1000)
    @Transactional
    public void pollAndPublish() {
        List<OutboxEvent> pendingEvents = outboxRepo
            .findTop100ByStatusOrderByCreatedAtAsc(OutboxStatus.PENDING);

        for (OutboxEvent event : pendingEvents) {
            try {
                // Send to Kafka (at-least-once)
                kafkaTemplate.send(event.getTopic(), event.getPartitionKey(), event.getPayload())
                    .get(5, TimeUnit.SECONDS);  // Synchronous wait

                // Mark as sent
                event.setStatus(OutboxStatus.SENT);
                event.setSentAt(LocalDateTime.now());
                outboxRepo.save(event);

                log.info("Published event: {}", event.getEventId());

            } catch (Exception e) {
                // Don't fail the entire batch — mark as failed and retry later
                event.setRetryCount(event.getRetryCount() + 1);
                if (event.getRetryCount() >= 5) {
                    event.setStatus(OutboxStatus.FAILED);
                    log.error("Event failed after 5 retries: {}", event.getEventId());
                    // Alert ops team!
                }
                outboxRepo.save(event);
            }
        }
    }
}
```

> [!TIP]
> **Production considerations:**
> - Dùng **Debezium** (CDC) thay vì polling nếu bạn cần sub-second latency. Debezium đọc DB binlog và publish lên Kafka ngay lập tức.
> - Nếu dùng polling, batch size 100-1000 rows thường đủ. Tránh `SELECT *` không có LIMIT.
> - Cleanup old `SENT` events định kỳ (retention: 30 ngày).

### Advanced: Debezium CDC (Production Alternative)

```d2 title="Advanced: Debezium CDC (Production Alternative)"
direction: right
g1: "Outbox Polling (Simple)" {
  A1: "App"
  DB1: "PostgreSQL" { shape: cylinder; icon: ../../assets/d2/postgresql.svg }
  Poller: "Poller"
  K1: "Kafka"
  Note1: "⚠️ 1s polling delay\n⚠️ DB polling load"
}
g2: "Debezium CDC (Production)" {
  A2: "App"
  DB2: "PostgreSQL" { shape: cylinder; icon: ../../assets/d2/postgresql.svg }
  Debezium: "Debezium"
  K2: "Kafka"
  Note2: "✅ Near-realtime\n✅ Zero polling overhead\n✅ At-least-once guaranteed"
}
g1.A1 -> g1.DB1: "INSERT orders\nINSERT outbox"
g1.Poller -> g1.DB1: "SELECT PENDING\nevery 1s"
g1.Poller -> g1.K1: "Send"
g2.A2 -> g2.DB2: "INSERT orders\nINSERT outbox"
g2.DB2 -> g2.Debezium: "WAL/binlog\nchange events"
g2.Debezium -> g2.K2: "< 100ms latency"
```

---

## Consume-Transform-Produce (Kafka → Kafka)

Khi bạn cần **đọc từ một Kafka topic, transform, và ghi vào topic khác** một cách atomic — Kafka transactions hoạt động hoàn hảo.

```d2 title="Consume-Transform-Produce (Kafka → Kafka)"
shape: sequence_diagram
Input: "orders-raw"
App: "Enrichment Service"
Output: "orders-enriched"
Offsets: "__consumer_offsets"
App -> Input: "poll()"
Input -> App: "Messages [offset 0-10]" { style.stroke-dash: 4 }
App.note1: "Begin Kafka Transaction"
App -> App: "Enrich with customer data"
App -> Output: "send(enriched) [in tx]"
App -> Offsets: "sendOffsetsToTransaction([0-10]) [in tx]"
App.note2: "Commit Transaction"
App -> Output: "Commit ✅"
App -> Offsets: "Commit ✅"
Output.note3: "Output / Offsets: ATOMIC! Both writes succeed or both fail\nNo orphan messages, no re-processing"
```

```java
@Service
public class OrderEnrichmentService {

    private final KafkaTemplate<String, String> kafkaTemplate;

    @KafkaListener(
        topics = "orders-raw",
        groupId = "enrichment-group",
        containerFactory = "transactionalListenerContainerFactory"
    )
    @Transactional("kafkaTransactionManager")
    public void enrich(
            @Payload String rawOrder,
            @Header(KafkaHeaders.RECEIVED_PARTITION) int partition,
            @Header(KafkaHeaders.OFFSET) long offset,
            Acknowledgment ack) {

        // Transform
        String enriched = enrich(rawOrder);

        // Send to output topic (within same Kafka transaction)
        kafkaTemplate.send("orders-enriched", enriched);

        // Offset commit is part of the transaction
        // → If send fails, offset NOT committed → message reprocessed
        // → If all succeeds, both output message + offset committed atomically
    }

    private String enrich(String raw) {
        // Business logic: add customer info, normalize fields, etc.
        return raw + " [enriched]";
    }
}
```

---

## Zombie Fencing & Epoch — chống producer "xác sống"

Khi dùng transactional producer, có một vấn đề tinh tế nhưng nguy hiểm: **producer "xác sống" (zombie)**. Đây là kịch bản:

```d2 title="Zombie producer và transactional.id"
direction: right
p1: "P1 bắt đầu T1\ntransactional.id = tx-order"
glitch: Network glitch — coordinator coi P1 đã chết
p2: P2 init cùng transactional.id — bắt đầu T2
zombie: P1 trở lại và cố commit T1 cũ
risk: "Cần fencing để chặn producer cũ\nKhông cho P1 can thiệp transaction mới"
p1 -> glitch -> p2 -> zombie -> risk
```

### Cơ chế Epoch Fencing

Kafka giải quyết bằng **epoch** — một số tăng dần mỗi khi `transactional.id` được khởi tạo lại. Broker chỉ chấp nhận request từ producer có **epoch cao nhất**. Request từ epoch cũ hơn bị **từ chối (fenced)**:

```d2 title="Producer epoch fencing"
shape: sequence_diagram
p1: Producer P1
b: Broker — tx-order
p2: Producer P2
p1 -> b: Init — epoch 0
p1 -> b: Send epoch 0 — chấp nhận
p2 -> b: Init cùng tx-order — bump epoch lên 1
p2 -> b: Send epoch 1 — chấp nhận
p1 -> b: Cố commit epoch 0 sau khi trở lại
b -> p1: ProducerFencedException — epoch 0 < 1
p1.note: Phải close producer bị fenced
```

### Cấu hình

Cơ chế fencing **tự động bật** khi bạn set `transactional.id` (hoặc `transaction-id-prefix` trong Spring). Không cần config thêm:

```yaml
spring:
  kafka:
    producer:
      transaction-id-prefix: tx-order-service   # bật fencing tự động
      acks: all                                  # bắt buộc khi dùng transaction
      # enable.idempotence tự được bật khi có transactional.id
```

> [!IMPORTANT]
> **`transactional.id` phải ổn định qua các lần restart** — nó là danh tính của producer. Nếu dùng prefix như `tx-order-service-`, Spring sẽ tự thêm suffix để mỗi instance có ID duy nhất nhưng ổn định qua restart (vd `tx-order-service-0`, `tx-order-service-1`). Đừng dùng random/UUID làm `transactional.id` — sẽ mất tính fencing.

### Hậu quả nếu không hiểu fencing

| Tình huống | Không có fencing | Có fencing |
|------------|------------------|------------|
| Producer zombie cố commit transaction cũ | **Có thể commit** → đè lên transaction mới → data hỏng | **Bị từ chối** → `ProducerFencedException` → zombie phải chết |
| Producer restart bình thường | OK | OK (epoch bump, producer tiếp tục) |
| Hai instance dùng cùng `transactional.id` | Conflict lặng lẽ | Một instance bị fenced → phải dùng ID khác |

> [!CAUTION]
> Nếu thấy `ProducerFencedException` trong production — nghĩa là có hai instance dùng cùng `transactional.id`. Đây thường do deploy nhiều hơn số `transaction-id-prefix` slot, hoặc instance cũ chưa chết hẳn. Instance bị fenced **phải close và restart**, không nên retry.

---

## So sánh các Approaches

| Approach | Consistency | Latency | Complexity | Best For |
|---------|-------------|---------|------------|---------|
| **Direct send (no tx)** | ❌ Risk of dual write | ✅ Lowest | ✅ Simple | Dev/test, non-critical |
| **@Transactional 1PC** | ⚠️ 99% — last mile risk | ✅ Low | ✅ Medium | Low-stakes, simple setup |
| **Outbox + Poller** | ✅ High — guaranteed | ⚠️ ~1s delay | ⚠️ Medium | Monolith + Kafka |
| **Outbox + Debezium** | ✅ Highest — CDC | ✅ < 100ms | ❌ Complex | Enterprise, high throughput |
| **Kafka-to-Kafka Tx** | ✅ Full EOS | ⚠️ +100ms | ⚠️ Medium | Stream processing |

<Cards>
  <Card title="Exactly-Once Semantics" href="/producers-consumers/exactly-once/" description="Idempotent producer, consumer deduplication strategies" />
  <Card title="Retry & Dead Letter Topic" href="/producers-consumers/retry-dlt/" description="@RetryableTopic, DLT patterns, non-blocking retries" />
  <Card title="Producer API" href="/producers-consumers/producer-api/" description="KafkaTemplate, callbacks, và production config" />
</Cards>
