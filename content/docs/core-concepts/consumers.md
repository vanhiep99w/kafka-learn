---
title: "Consumers (Fundamentals)"
description: "Cách Kafka Consumer hoạt động: poll loop, consumer groups, partition assignment, heartbeat mechanism và auto.offset.reset — kiến thức nền trước @KafkaListener"
---

# Consumers (Fundamentals)

## Mục lục

- [Consumer là gì?](#consumer-là-gì)
- [Pull Model — Consumer tự lấy data](#pull-model--consumer-tự-lấy-data)
- [Consumer Group](#consumer-group)
- [Partition Assignment Rules](#partition-assignment-rules)
- [Heartbeat & Session Timeout](#heartbeat--session-timeout)
- [auto.offset.reset](#autooffsetreset)
- [Fan-Out vs Load Balancing](#fan-out-vs-load-balancing)
- [Common Misconceptions](#common-misconceptions)

---

## Consumer là gì?

**Consumer** là ứng dụng **đọc (subscribe) messages** từ Kafka topic. Không giống message queue truyền thống, Kafka Consumer **tự kiểm soát** việc đọc — quyết định đọc từ offset nào, tốc độ nào.

```d2 title="Consumer poll và xử lý record"
direction: down
topic: "Topic: orders" {
  p0: "P0"
  p1: "P1"
  p2: "P2"
  p3: "P3"
}
c1: "Consumer 1"
topic.p0 -> c1
topic.p1 -> c1
topic.p2 -> c1
topic.p3 -> c1
c1.label: "Consumer — Your App\npoll() → process(record)"
```

---

## Pull Model — Consumer tự lấy data

Kafka dùng **Pull model** (Consumer tự poll), không phải Push model (Broker push data):

```d2 title="Pull Model — Consumer tự lấy data"
direction: right
g1: "Pull Model (Kafka)" {
  C1: "Consumer\n(Your App)"
  B1: "Kafka Broker"
  Note1: "Consumer kiểm soát pace\nBackpressure tự nhiên"
}
g2: "Push Model (Truyền thống)" {
  B2: "Message Broker"
  C2: "Consumer"
  Note2: "Broker quyết định tốc độ\nConsumer có thể bị overwhelm"
}
g1.C1 -> g1.B1: "poll(timeout)"
g1.B1 -> g1.C1: "records batch"
g2.B2 -> g2.C2: "push when available"
```

**Lợi ích của Pull model:**
- Consumer tự quyết định tốc độ xử lý → **natural backpressure**
- Consumer slow → chỉ poll ít hơn, không bị broker overwhelm
- Cho phép **batch processing**: poll nhiều records cùng lúc
- Consumer có thể replay bất kỳ offset nào

---

## Consumer Group

**Consumer Group** = nhóm consumers cùng chia sẻ load của một topic.

```d2 title="Assignment của order-service với 6 partition"
direction: down
topic: "Topic: orders" {
  p0: "P0"
  p1: "P1"
  p2: "P2"
  p3: "P3"
  p4: "P4"
  p5: "P5"
}
c1: "Consumer 1"
topic.p0 -> c1
topic.p1 -> c1
c2: "Consumer 2"
topic.p2 -> c2
topic.p3 -> c2
c3: "Consumer 3"
topic.p4 -> c3
topic.p5 -> c3
```

**Rule bất biến**: Trong một consumer group, **một partition chỉ được xử lý bởi đúng một consumer** tại một thời điểm → đảm bảo ordering per partition.

---

## Partition Assignment Rules

```d2 title="Partition Assignment Rules"
direction: down
A: "Topic: N Partitions\nGroup: M Consumers"
B: "So sánh N vs M" { shape: diamond }
C: "Một số consumers\nxử lý nhiều hơn 1 partition\n✅ Tất cả partitions được xử lý"
D: "Mỗi consumer xử lý\nđúng 1 partition\n✅ Optimal"
E: "Một số consumers IDLE\n❌ Lãng phí resources"
A -> B
B -> C: "N > M\n(more partitions)"
B -> D: "N = M\n(equal)"
B -> E: "N < M\n(more consumers)"
```

| Partitions | Consumers | Phân phối | Nhận xét |
|-----------|----------|----------|---------|
| 4 | 1 | C1: P0,P1,P2,P3 | ✅ Hoạt động |
| 4 | 2 | C1: P0,P1 / C2: P2,P3 | ✅ Balanced |
| 4 | 4 | C1:P0 / C2:P1 / C3:P2 / C4:P3 | ✅ Optimal |
| 4 | 6 | 4 active, **2 idle** | ⚠️ Lãng phí |

> [!TIP]
> **Thiết kế topic:** Chọn số partition = bội số của số consumer instances dự kiến. Ví dụ: 3 instances × 4 threads = 12 consumers → tạo 12 partitions.

---

## Heartbeat & Session Timeout

Consumer duy trì **heartbeat** để báo với Broker rằng nó vẫn sống:

```d2 title="Heartbeat & Session Timeout"
shape: sequence_diagram
C: "Consumer"
Coord: "Group Coordinator"
loop1: "Lặp: Every heartbeat.interval.ms (15s)" {
  C -> Coord: "❤️ Heartbeat"
  Coord -> C: "OK" { style.stroke-dash: 4 }
}
C.note1: "Consumer bị hang (long processing)"
loop2: "Lặp: Tiếp tục heartbeat dù đang process" {
  C -> Coord: "❤️ Heartbeat (background thread)"
  Coord -> C: "OK" { style.stroke-dash: 4 }
}
C.note2: "Consumer crash / network down"
C -> Coord: "✕ Không có heartbeat" { style.stroke-dash: 4; target-arrowhead.shape: cross }
Coord.note3: "Chờ session.timeout.ms (45s)"
Coord -> Coord: "Mark consumer as DEAD"
Coord -> Coord: "Trigger REBALANCE"
```

### Cấu hình timeout quan trọng

```yaml
spring:
  kafka:
    consumer:
      properties:
        # Heartbeat — báo "tôi sống" với Coordinator
        heartbeat.interval.ms: 15000     # 15 giây — nên = 1/3 session timeout

        # Session — thời gian tối đa không nhận heartbeat trước khi coi là dead
        session.timeout.ms: 45000        # 45 giây

        # Poll interval — thời gian tối đa giữa 2 lần poll()
        # Nếu processing mất quá lâu → tăng giá trị này
        max.poll.interval.ms: 300000     # 5 phút

        # Số records tối đa mỗi poll() — tune theo processing time
        max.poll.records: 100
```

**Hai loại timeout khác nhau:**

| Timeout | Điều kiện trigger | Hậu quả |
|---------|-----------------|--------|
| `session.timeout.ms` | Không nhận heartbeat trong X ms | Consumer bị coi là dead, rebalance |
| `max.poll.interval.ms` | Khoảng cách giữa 2 poll() quá lớn | Consumer bị kicked khỏi group, rebalance |

> [!WARNING]
> **`max.poll.interval.ms` trap phổ biến:** Nếu xử lý 1 batch (100 records) mất 400 giây nhưng `max.poll.interval.ms=300000` (5 phút = 300s) → consumer bị kicked khỏi group, rebalance → lặp lại mãi.
>
> **Fix:** Giảm `max.poll.records` hoặc tăng `max.poll.interval.ms`.

---

## auto.offset.reset

Khi consumer lần đầu đọc một partition (không có committed offset), **`auto.offset.reset`** quyết định đọc từ đâu:

```d2 title="auto.offset.reset"
direction: down
A: "Consumer start\ngroup.id = 'my-group'"
B: "Có committed offset\ntrong __consumer_offsets?" { shape: diamond }
C: "Resume từ\ncommitted offset"
D: "auto.offset.reset?" { shape: diamond }
E: "Đọc từ Offset 0\nProcess TẤT CẢ messages\n(kể cả cũ)"
F: "Đọc từ cuối log\nChỉ nhận messages MỚI\n(bỏ qua existing)"
G: "Throw Exception!\nNoOffsetForPartitionException"
A -> B
B -> C: "✅ Có"
B -> D: "❌ Không có (group mới)"
D -> E: "earliest"
D -> F: "latest"
D -> G: "none"
```

**Chọn giá trị nào?**

| Giá trị | Dùng khi | Rủi ro |
|---------|---------|-------|
| `earliest` | Cần xử lý tất cả dữ liệu, ETL, reprocessing | Có thể xử lý data cũ không mong muốn |
| `latest` | Chỉ quan tâm events mới (notifications, realtime) | Bỏ qua backlog data |
| `none` | Muốn fail rõ ràng nếu không có offset | Exception khi start |

---

## Fan-Out vs Load Balancing

Đây là concept quan trọng nhất về Consumer Group:

```d2 title="Fan-Out vs Load Balancing"
direction: down
g1: "Topic: orders (4 Partitions)" {
  P0: "P0"
  P1: "P1"
  P2: "P2"
  P3: "P3"
}
g2: "Group A: order-processing-service" {
  CA1: "Consumer A1\n(P0, P1)"
  CA2: "Consumer A2\n(P2, P3)"
}
g3: "Group B: analytics-service" {
  CB1: "Consumer B1\n(P0, P1, P2, P3)"
}
g4: "Group C: notification-service" {
  CC1: "Consumer C1\n(P0, P1)"
  CC2: "Consumer C2\n(P2, P3)"
}
g1.P0 -> g2.CA1
g1.P1 -> g2.CA1
g1.P2 -> g2.CA2
g1.P3 -> g2.CA2
g1.P0 -> g3.CB1
g1.P1 -> g3.CB1
g1.P2 -> g3.CB1
g1.P3 -> g3.CB1
g1.P0 -> g4.CC1
g1.P1 -> g4.CC1
g1.P2 -> g4.CC2
g1.P3 -> g4.CC2
```

**Kết quả:**
- **Trong Group A**: Load balanced — mỗi consumer xử lý 2 partitions
- **Across Groups**: Fan-Out — cùng 1 message được xử lý bởi cả 3 services
- Group A, B, C đều nhận **toàn bộ** messages → Kafka như Pub/Sub system

> [!NOTE]
> Đây là sức mạnh cốt lõi của Kafka: **một topic, nhiều consumers độc lập**. Không cần fanout queue hay routing logic phức tạp. Thêm service mới? Chỉ cần tạo consumer group mới với group.id mới.

---

## Common Misconceptions

### "Một partition chỉ kết nối 1 consumer?"

**Trả lời**: Đúng VÀ Sai — phụ thuộc vào **Consumer Group**.

| Scope | Behavior | Ví dụ |
|-------|----------|-------|
| **Trong 1 Group** | 1 partition → đúng 1 consumer | Group A: P0 chỉ được xử lý bởi C1 |
| **Across Groups** | 1 partition → nhiều consumers, mỗi group 1 bản copy | Group A + Group B đều đọc P0 |

```d2 title="'Một partition chỉ kết nối 1 consumer?'"
direction: down
g1: "Topic: orders" {
  P0: "Partition 0"
}
g2: "Group A: Billing Service" {
  C1: "Consumer A-1 ✅"
  C2: "Consumer A-2 (IDLE)"
}
g3: "Group B: Analytics Service" {
  C3: "Consumer B-1 ✅"
}
note: "Trong Group A: CHỈ 1 consumer nhận message\nNhưng Group B cũng nhận BẢN COPY độc lập"
g1.P0 -> g2.C1: "Load Balanced" { style.stroke-dash: 4 }
g1.P0 -> g2.C2: "Không nhận" { style.stroke-dash: 4 }
g1.P0 -> g3.C3: "Fan Out"
```

---

### "Kafka guarantee global ordering?"

**Sai** — Kafka chỉ guarantee ordering **trong 1 partition**, không phải across toàn bộ topic.

```d2 title="Không có ordering giữa hai partition"
direction: right
p: Producer
a: "P0\nmsg-A, key=user1"
b: "P1\nmsg-B, key=user2"
c: "Consumer\nĐọc P1 trước P0 → thấy B trước A"
p -> a
p -> b
b -> c: Đọc trước
a -> c: Đọc sau
```

**Fix**: Dùng cùng **Key** cho các events cần ordering (ví dụ: `orderId`, `userId`).

> [!TIP]
> Nếu không dùng key → round-robin partitioning → **không có ordering guarantee**.

---

### "Kafka push data cho consumer?"

**Sai** — Kafka Consumer **POLL** (pull), không phải push.

```d2 title="Push và pull — ai kiểm soát tốc độ"
direction: right
push: "Push — RabbitMQ" {b: Broker; c: Consumer; b -> c: Broker quyết định pace}
pull: "Pull — Kafka" {c: Consumer; b: Broker; c -> b: Consumer quyết định pace}
```

**Lợi ích của Pull model**:
- Consumer slow → poll ít hơn → **natural backpressure**
- Consumer fast → poll nhiều hơn → tự động scale
- Consumer có thể replay từ bất kỳ offset nào

---

### "Thêm consumer để xử lý nhanh hơn?"

**Trap** — "Idle Consumer Problem": không thể có nhiều active consumers hơn số partitions.

```d2 title="6 partition, 8 consumer — hai consumer idle"
direction: down
topic: "Topic: orders" {
  p0: "P0"
  p1: "P1"
  p2: "P2"
  p3: "P3"
  p4: "P4"
  p5: "P5"
}
c1: "Consumer 1"
topic.p0 -> c1
c2: "Consumer 2"
topic.p1 -> c2
c3: "Consumer 3"
topic.p2 -> c3
c4: "Consumer 4"
topic.p3 -> c4
c5: "Consumer 5"
topic.p4 -> c5
c6: "Consumer 6"
topic.p5 -> c6
c7: "Consumer 7 (IDLE)"
c8: "Consumer 8 (IDLE)"
```

**Formula**: `Active Consumers = min(Total Consumers, Total Partitions)`

| Partitions | Consumers | Active | Idle | Nhận xét |
|-----------|----------|--------|------|---------|
| 6 | 3 | 3 | 0 | ✅ Có thể scale thêm |
| 6 | 6 | 6 | 0 | ✅ Optimal |
| 6 | 8 | 6 | **2** | ❌ 2 consumers lãng phí |

> [!WARNING]
> Thêm consumer instance mà không tăng partitions → consumer mới sẽ **idle**, không giúp xử lý nhanh hơn.

---

### "Auto-commit an toàn rồi?"

**Không** — auto-commit có thể gây duplicate processing.

```d2 title="Auto-commit và cửa sổ crash"
direction: down
loss: "Commit trước khi xử lý xong" {
  poll: poll nhận message
  commit: Auto-commit offset +1
  process: Đang xử lý
  crash: Crash trước khi xong
  restart: "Restart từ offset đã commit\nMessage bị SKIP"
  poll -> commit -> process -> crash -> restart
}
dup: "Xử lý xong trước khi commit" {
  poll: poll nhận message
  process: Xử lý thành công
  crash: Crash trước auto-commit
  restart: "Restart đọc lại message\nMessage bị DUPLICATE"
  poll -> process -> crash -> restart
}
```

**Fix**: Dùng `enable.auto.commit=false` + manual acknowledge.

---

### "Kafka hoạt động như queue (FIFO)?"

**Không hoàn toàn** — Kafka là **log** (append-only), không phải queue.

| Aspect | Queue (RabbitMQ) | Kafka (Log) |
|--------|-----------------|-------------|
| **Message sau khi consume** | Bị xóa (ack → delete) | Giữ lại (consumer tự track offset) |
| **Replay** | Không thể | Dễ dàng (reset offset) |
| **Multiple consumers** | Cần fanout exchange | Tự nhiên (multiple groups) |
| **Ordering** | Queue-level FIFO | Partition-level FIFO |

> [!TIP]
> Kafka KHÔNG xóa message khi consumer xử lý xong. Message chỉ bị xóa khi hết retention (time/size) hoặc compact.

<Cards>
  <Card title="Consumer Groups" href="/core-concepts/consumer-groups/" description="Rebalancing protocol và AckMode deep dive" />
  <Card title="Offset Management" href="/core-concepts/offsets/" description="__consumer_offsets internals và 5 lifecycle scenarios" />
  <Card title="Consumer API" href="/producers-consumers/consumer-api/" description="@KafkaListener, headers, concurrency trong Spring Boot" />
</Cards>
