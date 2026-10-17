---
title: "Offset Management"
description: "Deep dive vào cơ chế lưu trữ offset trong Kafka: __consumer_offsets topic, 5 kịch bản lifecycle, CLI commands, monitoring và reset strategies"
---

# Offset Management

## Mục lục

- [Offset là gì?](#offset-là-gì)
- [Topic \_\_consumer\_offsets](#topic-__consumer_offsets)
- [Key Structure — Tại sao track theo Group?](#key-structure--tại-sao-track-theo-group)
- [Multiple Consumer Groups — Independent Offsets](#multiple-consumer-groups--independent-offsets)
- [Offset Commit Flow](#offset-commit-flow)
- [5 Kịch bản Lifecycle](#5-kịch-bản-lifecycle)
- [State Machine: Vòng Đời Consumer](#state-machine-vòng-đời-consumer)
- [Offset Behavior Matrix](#offset-behavior-matrix)
- [CLI Commands & Operations](#cli-commands--operations)
- [Consumer Lag](#consumer-lag)
- [Reset Offset Strategies](#reset-offset-strategies)
- [Monitoring trong Spring Boot](#monitoring-trong-spring-boot)
- [Common Pitfalls](#common-pitfalls)

---

## Offset là gì?

**Offset** là một số nguyên tăng dần, đánh dấu vị trí của mỗi message trong một partition. Đây là cơ chế Kafka dùng để các consumer biết "tôi đã đọc đến đâu".

```d2 title="Offset là vị trí trong commit log"
direction: right
log: "Partition 0 — commit log" {
  m0: "Offset 0\nOldest"
  m1: "Offset 1"
  m2: "Offset 2"
  m3: "Offset 3"
  m4: "Offset 4"
  m5: "Offset 5\nConsumer position"
  m6: "Offset 6"
  m7: "Offset 7"
  m8: "Offset 8"
  m9: "Offset 9\nNewest record"
  m0 -> m1 -> m2 -> m3 -> m4 -> m5 -> m6 -> m7 -> m8 -> m9: Append order
}
leo: "Log end offset (LEO): 10\nVị trí kế tiếp sau record cuối"
```

**Consumer Lag** = Log End Offset - Current Offset (= số message chưa xử lý)

---

## Topic `__consumer_offsets`

Kafka lưu toàn bộ offset của consumer trong một topic nội bộ đặc biệt: **`__consumer_offsets`**.

### Đặc điểm của topic này

| Thuộc tính | Giá trị | Ghi chú |
|-----------|---------|---------|
| Số partitions | 50 (mặc định) | `offsets.topic.num.partitions` |
| Replication Factor | 3 | `offsets.topic.replication.factor` |
| Cleanup policy | Log compaction | Chỉ giữ offset mới nhất per key |
| Ai quản lý | Kafka broker | Không ghi trực tiếp vào đây |

> [!NOTE]
> **Lịch sử**: Trước Kafka 0.9, offset được lưu trong ZooKeeper. Điều này gây ra vấn đề scalability nghiêm trọng, nên Kafka đã chuyển sang lưu trong topic thông thường (có compaction).

### Log Compaction giúp gì?

Log compaction đảm bảo `__consumer_offsets` chỉ giữ **offset mới nhất** của mỗi `(group, topic, partition)`. Các offset cũ hơn sẽ bị cleanup dần.

```d2 title="Compaction trong __consumer_offsets"
direction: right
before: "Trước compaction — key (g1,orders,P0)" {a: "50"; b: "75"; c: "100"; a -> b -> c}
after: "Sau compaction" {c: "(g1,orders,P0) → 100\nGiữ bản mới nhất"}
before -> after
```

---

## Key Structure — Tại sao track theo Group?

### Cấu trúc Key-Value trong `__consumer_offsets`

```d2 title="Key và value của committed offset"
direction: right
topic: "__consumer_offsets" {
  key: "Composite key\nConsumer group ID\nTopic name\nPartition number"
  value: "Value\nCommitted offset\nMetadata (optional)\nCommit timestamp"
  key -> value
  examples: "Ví dụ" {
    a: "(order-group, orders, 0) → 1523\n(order-group, orders, 1) → 892\n(order-group, orders, 2) → 2105"
    b: "(analytics-group, orders, 0) → 500\n(analytics-group, orders, 1) → 500"
  }
}
```

**Key = `(group.id, topic, partition)`** — KHÔNG phải per consumer instance.

### Lợi ích của Group-Level Tracking

| Lợi ích | Giải thích |
|---------|-----------|
| **Fault Tolerance** | Consumer crash → consumer khác resume từ đúng offset |
| **Elastic Scaling** | Thêm/bớt consumer không mất progress |
| **Stateless Consumers** | Consumer không cần lưu state local — Kafka là source of truth |
| **Multiple Groups** | Các group theo dõi tiến độ hoàn toàn độc lập |

### Minh họa: Consumer crash, Group không mất dữ liệu

```d2 title="Minh họa: Consumer crash, Group không mất dữ liệu"
shape: sequence_diagram
C1: "Consumer C1 (order-group)"
Kafka: "Kafka Broker"
C2: "Consumer C2 (order-group)"
C1.note1: "C1 / C2: Hoạt động bình thường"
C1 -> Kafka: "Poll Partition 0"
Kafka -> C1: "Messages offset 0-10" { style.stroke-dash: 4 }
C1 -> Kafka: "Commit offset 10\nKey: (order-group, topic, P0)"
C1.note2: "C1 / C2: 💥 C1 Crash!"
C1.note3: "C1 / C2: Rebalance Triggered"
C2 -> Kafka: "Được assigned Partition 0 — offset bắt đầu?"
Kafka -> C2: "Lookup (order-group, topic, P0)\nLast committed: offset 10" { style.stroke-dash: 4 }
C2 -> Kafka: "Poll từ offset 10"
Kafka -> C2: "Messages offset 10-20" { style.stroke-dash: 4 }
C2.note4: "✅ Không mất message!\nC2 tiếp tục từ nơi C1 dừng lại"
```

---

## Multiple Consumer Groups — Independent Offsets

```d2 title="Multiple Consumer Groups — Independent Offsets"
direction: down
g1: "Topic: orders (3 Partitions)" {
  P0: "Partition 0\nMessages 0-100"
  P1: "Partition 1\nMessages 0-100"
  P2: "Partition 2\nMessages 0-100"
}
g2: "Group A: order-service" {
  CA1: "Consumer A1"
  CA2: "Consumer A2"
}
g3: "Group B: analytics-service" {
  CB1: "Consumer B1"
}
g4: "__consumer_offsets" {
  OFF1: "(order-service, orders, P0) → 85"
  OFF2: "(order-service, orders, P1) → 92"
  OFF3: "(order-service, orders, P2) → 78"
  OFF4: "(analytics-service, orders, P0) → 45"
  OFF5: "(analytics-service, orders, P1) → 45"
  OFF6: "(analytics-service, orders, P2) → 45"
}
g1.P0 -> g2.CA1
g1.P1 -> g2.CA1
g1.P2 -> g2.CA2
g1.P0 -> g3.CB1
g1.P1 -> g3.CB1
g1.P2 -> g3.CB1
```

**Lưu ý**: Group A ở offset ~85, Group B ở offset 45. Chúng tiến hoàn toàn độc lập!

---

## Offset Commit Flow

```d2 title="Offset Commit Flow"
direction: right
g1: "Consumer Application" {
  A: "Poll Messages"
  B: "Process Messages"
  C: "Commit Strategy?" { shape: diamond }
}
g2: "Kafka Cluster" {
  I: "Coordinator Broker"
  J: "Ghi vào __consumer_offsets\npartition = hash(group.id) % 50"
  K: "Replicate đến Followers"
  L: "Ack về Consumer"
}
D: "Background Thread\nMỗi 5s mặc định"
E: "Gọi ack.acknowledge"
F: "Sau khi xử lý xong\ntoàn bộ poll batch"
G: "Build OffsetCommitRequest"
H: "Gửi đến Group Coordinator\n(broker cụ thể)"
g1.A -> g1.B
g1.B -> g1.C
g1.C -> D: "Auto-Commit"
g1.C -> E: "Manual"
g1.C -> F: "Batch"
D -> G
E -> G
F -> G
G -> H
H -> g2.I
g2.I -> g2.J
g2.J -> g2.K
g2.K -> g2.L
```

---

## 5 Kịch bản Lifecycle

### Kịch bản 1: Consumer Crash

```d2 mode=tabs title="Consumer crash — offset thuộc group không đổi"
direction: down
topic: "Topic: orders" {
  p0: "P0\nOffset: 150"
  p1: "P1\nOffset: 200"
  p2: "P2\nOffset: 175"
  p3: "P3\nOffset: 180"
}
c1: "Consumer 1"
topic.p0 -> c1
topic.p1 -> c1
c2: "Consumer 2"
topic.p2 -> c2
topic.p3 -> c2
scenarios: {
  "Sau khi C2 crash": {
    label: "C2 crash; C1 nhận tất cả partition"
    (topic.p0 -> c1)[0]: null
    (topic.p1 -> c1)[0]: null
    (topic.p2 -> c2)[0]: null
    (topic.p3 -> c2)[0]: null
    c2: null
    topic.p0 -> c1
    topic.p1 -> c1
    topic.p2 -> c1
    topic.p3 -> c1
  }
}
note: "Offsets của group không đổi: P0=150, P1=200, P2=175, P3=180"
```

**Timeline của Consumer Crash:**

```d2 title="Kịch bản 1: Consumer Crash"
shape: sequence_diagram
C1: "Consumer C1"
Coord: "Group Coordinator"
C2: "Consumer C2"
Offsets: "__consumer_offsets"
C1.note1: "C1 / C2: Hoạt động bình thường"
C2 -> Coord: "Heartbeat ❤️"
C2 -> Coord: "Heartbeat ❤️"
C2.note2: "💥 C2 Crash!"
C2 -> Coord: "✕ Không có Heartbeat ❌" { style.stroke-dash: 4; target-arrowhead.shape: cross }
Coord.note3: "Chờ session.timeout.ms\n(mặc định 45s)"
Coord -> C1: "Rebalance! Bạn nhận thêm P2, P3"
C1 -> Offsets: "Offset của P2 là bao nhiêu?"
Offsets -> C1: "(order-group, orders, P2) = 175" { style.stroke-dash: 4 }
C1 -> Offsets: "Offset của P3 là bao nhiêu?"
Offsets -> C1: "(order-group, orders, P3) = 180" { style.stroke-dash: 4 }
C1.note4: "✅ Resume từ committed offsets"
```

---

### Kịch bản 2: Consumer Mới Gia Nhập

```d2 mode=tabs title="Consumer gia nhập — resume từ offset của group"
direction: down
topic: "Topic: orders" {
  p0: "P0\nOffset: 100"
  p1: "P1\nOffset: 150"
  p2: "P2\nOffset: 200"
  p3: "P3\nOffset: 175"
}
c1: "Consumer 1"
topic.p0 -> c1
topic.p1 -> c1
topic.p2 -> c1
topic.p3 -> c1
scenarios: {
  "Sau khi C2 gia nhập": {
    label: "C2 gia nhập; C1 giữ P0,P1; C2 nhận P2,P3"
    (topic.p0 -> c1)[0]: null
    (topic.p1 -> c1)[0]: null
    (topic.p2 -> c1)[0]: null
    (topic.p3 -> c1)[0]: null
    c2: "Consumer 2 — nhận P2 từ 200, P3 từ 175"
    topic.p0 -> c1
    topic.p1 -> c1
    topic.p2 -> c2
    topic.p3 -> c2
  }
}
note: "Offsets của group không đổi: P0=100, P1=150, P2=200, P3=175"
```

**Hiểu đúng**: Khi C2 gia nhập:
1. C2 không có offset riêng — dùng **offset của group**
2. C2 tiếp tục từ nơi group đã commit (offset 200 cho P2, 175 cho P3)
3. Không message nào bị xử lý lại, không message nào bị bỏ qua

---

### Kịch bản 3: Graceful Shutdown vs Crash

| Aspect | Graceful Shutdown | Crash |
|--------|------------------|-------|
| **Cách phát hiện** | Consumer gửi `LeaveGroup` request | Coordinator phát hiện mất heartbeat |
| **Thời gian phát hiện** | Ngay lập tức | `session.timeout.ms` (mặc định 45s) |
| **Uncommitted work** | Có thể commit trước khi rời | Bị mất — sẽ bị reprocess |
| **Trigger Rebalance** | Ngay lập tức | Sau khi timeout |
| **Offset Impact** | Last offset được commit, preserved | Last committed offset preserved |

```d2 title="Kịch bản 3: Graceful Shutdown vs Crash"
direction: down
g1: "Graceful Shutdown" {
  A1: "Consumer gọi close"
  A2: "Commit pending offsets"
  A3: "Gửi LeaveGroup đến Coordinator"
  A4: "Rebalance ngay lập tức"
  A5: "✅ Không mất message\n✅ Không duplicate"
}
g2: "Crash" {
  B1: "💥 Process killed/OOM/Network"
  B2: "Không gửi heartbeat"
  B3: "Chờ session.timeout.ms\n(45 giây)"
  B4: "Coordinator đánh dấu consumer dead"
  B5: "Rebalance được trigger"
  B6: "⚠️ Uncommitted messages\nsẽ bị reprocess"
}
g1.A1 -> g1.A2
g1.A2 -> g1.A3
g1.A3 -> g1.A4
g1.A4 -> g1.A5
g2.B1 -> g2.B2
g2.B2 -> g2.B3
g2.B3 -> g2.B4
g2.B4 -> g2.B5
g2.B5 -> g2.B6
```

---

### Kịch bản 4: Tất cả Consumer Rời Đi

```d2 mode=tabs title="Consumer trở lại trước khi offset hết retention"
direction: down
topic: "Topic: orders" {
  p0: "P0\nOffset: 500"
  p1: "P1\nOffset: 600"
  p2: "P2\nOffset: 550"
  p3: "P3\nOffset: 580"
}
scenarios: {
  "Sau 3 ngày — consumer mới": {
    label: "Sau 3 ngày: consumer mới cùng group.id=order-group resume"
    c1: "Consumer mới — order-group"
    topic.p0 -> c1
    topic.p1 -> c1
    topic.p2 -> c1
    topic.p3 -> c1
  }
}
note: "Offsets của group không đổi: P0=500, P1=600, P2=550, P3=580"
retention: "Offset vẫn tồn tại khi group trống\nVí dụ retention 7 ngày (offsets.retention.minutes)"
```

**Vòng đời Offset Retention:**

```d2 title="Kịch bản 4: Tất cả Consumer Rời Đi"
direction: right
departed: "Ngày 0\nConsumer cuối cùng rời đi\nOffset lưu trong __consumer_offsets"
retained: "Ngày 1–6\nOffset còn hợp lệ\nConsumer mới có thể resume"
expired: "Ngày 7\noffsets.retention.minutes hết hạn\nOffset được xóa"
reset: "Sau ngày 7\nConsumer mới join\nauto.offset.reset chọn điểm bắt đầu"
departed -> retained -> expired -> reset
```

---

### Kịch bản 5: Consumer Group Mới (Chưa từng consume)

```d2 title="Kịch bản 5: Consumer Group Mới (Chưa từng consume)"
direction: down
A: "Consumer mới start\ngroup.id = 'new-analytics-group'"
B: "Offset tồn tại trong\n__consumer_offsets?" { shape: diamond }
C: "auto.offset.reset?" { shape: diamond }
D: "Bắt đầu từ offset 0\nXử lý TẤT CẢ messages"
E: "Bắt đầu từ cuối log\nBỏ qua tất cả messages cũ"
F: "Ném Exception!\nNoOffsetForPartitionException"
G: "Resume từ committed offset"
A -> B
B -> C: "❌ Không (lần đầu)"
C -> D: "earliest"
C -> E: "latest"
C -> F: "none"
B -> G: "✅ Có (đã từng chạy)"
```

**Ví dụ thực tế: Hai group khác nhau:**

```d2 title="Group cũ resume, group mới dùng auto.offset.reset"
direction: right
topic: "orders\nLog end offset = 1000"
old: "Group A — order-processing-group\nCommitted offset 950 → tiếp tục từ 950"
new: "Group B — new-analytics-group\nChưa có committed offset" {shape: diamond}
early: "earliest → offset 0\nĐọc lịch sử còn được giữ lại"
latest: "latest → offset 1000\nChờ message mới"
topic -> old
topic -> new
new -> early
new -> latest
```

---

## State Machine: Vòng Đời Consumer

```d2 title="State Machine: Vòng Đời Consumer"
direction: right
start: Bắt đầu { shape: circle }
NoOffset: "NoOffset"
ProcessFromEarliest: "ProcessFromEarliest"
ProcessFromLatest: "ProcessFromLatest"
Error: "Error"
Consuming: "Consuming"
OffsetCommitted: "OffsetCommitted"
Rebalancing: "Rebalancing"
AllConsumersGone: "AllConsumersGone"
OffsetsRetained: "OffsetsRetained"
OffsetsExpired: "OffsetsExpired"
start -> NoOffset: "Group ID mới"
NoOffset -> ProcessFromEarliest: "auto.offset.reset=earliest"
NoOffset -> ProcessFromLatest: "auto.offset.reset=latest"
NoOffset -> Error: "auto.offset.reset=none"
ProcessFromEarliest -> Consuming: "Bắt đầu từ offset 0"
ProcessFromLatest -> Consuming: "Bắt đầu từ LOG_END"
Consuming -> OffsetCommitted: "Commit offset"
OffsetCommitted -> Consuming: "Tiếp tục xử lý"
Consuming -> Rebalancing: "Consumer join/leave"
OffsetCommitted -> Rebalancing: "Consumer join/leave"
Rebalancing -> Consuming: "Resume từ committed offset"
Consuming -> AllConsumersGone: "Consumer cuối cùng rời"
AllConsumersGone -> OffsetsRetained: "Offset được giữ"
OffsetsRetained -> Consuming: "Consumer mới join (cùng group)"
OffsetsRetained -> OffsetsExpired: "Sau retention period"
OffsetsExpired -> NoOffset: "Xử lý như group mới"
```

---

## Offset Behavior Matrix

| Sự kiện | Ảnh hưởng đến Offset | Hành vi Recovery |
|---------|---------------------|-----------------|
| **Consumer crash** | Preserved trong `__consumer_offsets` | Consumer khác resume từ committed offset |
| **Graceful shutdown** | Offset cuối được commit, preserved | Giống crash nhưng rebalance ngay lập tức |
| **Consumer mới gia nhập** | Offset không thay đổi | Consumer mới dùng committed offset của group |
| **Consumer bị remove** | Offset vẫn còn | Partition được redistribute, dùng existing offset |
| **Tất cả consumer rời** | Giữ trong `offsets.retention.minutes` | Consumer mới resume nếu còn trong retention |
| **Consumer group mới** | Không có offset | `auto.offset.reset` quyết định |
| **Offset hết hạn** | Bị xóa khỏi `__consumer_offsets` | Xử lý như group mới |

> [!CAUTION]
> **Pitfalls phổ biến:**
> 1. **Thay đổi `group.id` giữa các deployment** → Mất toàn bộ offset progress, bắt đầu từ đầu
> 2. **Processing time > `auto.commit.interval`** → Nguy cơ xử lý duplicate khi crash
> 3. **Offset hết hạn trong maintenance dài** → Có thể reprocess hoặc skip messages không mong muốn

---

## CLI Commands & Operations

### Xem Consumer Groups

```bash
# Liệt kê tất cả consumer groups
kafka-consumer-groups.sh --bootstrap-server localhost:9092 --list

# Mô tả chi tiết một group (offset, lag, assignment)
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
    --describe --group order-group

# Output mẫu:
# GROUP        TOPIC    PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG   CONSUMER-ID
# order-group  orders   0          1523            1530            7     consumer-1-xxx
# order-group  orders   1          892             900             8     consumer-1-xxx
# order-group  orders   2          2105            2105            0     consumer-2-xxx
```

---

## Consumer Lag

**Consumer Lag** = số message mà consumer chưa xử lý được.

```d2 title="Consumer Lag"
direction: right
g1: "Partition 0 Commit Log" {
  M0: "msg 0"
  M1: "msg 1"
  M2: "msg 2"
  M3: "msg 3"
  M4: "msg 4"
  M5: "msg 5"
  M6: "msg 6"
}
CURR: "Current Offset: 3\n(Last Committed)"
LEO: "Log End Offset: 7\n(Latest Available)"
LAG: "📊 LAG = LEO - Current\n= 7 - 3 = 4 messages chưa xử lý"
g1.M0 -> g1.M1
g1.M1 -> g1.M2
g1.M2 -> g1.M3
g1.M3 -> g1.M4
g1.M4 -> g1.M5
g1.M5 -> g1.M6
CURR -> g1.M3 { style.stroke-dash: 4 }
LEO -> g1.M6 { style.stroke-dash: 4 }
```

### Giải thích Lag

| Lag | Trạng thái | Hành động |
|----|-----------|-----------|
| **0** | Consumer bắt kịp | ✅ Healthy |
| **1-100** | Fluctuation nhỏ, bình thường | 👀 Monitor |
| **100-1000** | Consumer đang chậm lại | ⚠️ Điều tra |
| **1000+** | Backlog nghiêm trọng | 🚨 Scale up hoặc fix processing |
| **Đang tăng** | Ngày càng tệ hơn | 🔥 Urgent |

---

## Reset Offset Strategies

Đôi khi cần reprocess messages (bug fix, feature mới). Kafka cho phép reset offset khi consumer group **đã dừng hoàn toàn**.

> [!CAUTION]
> **Trước khi reset offset:**
> 1. Dừng tất cả consumers trong group trước
> 2. Đảm bảo processing logic idempotent nếu reprocess
> 3. Dùng `--dry-run` để xem trước kết quả
> 4. Cân nhắc downstream effects (có gửi duplicate events không?)

```bash
# ⚠️ QUAN TRỌNG: Dừng tất cả consumers trong group trước!

# Reset về earliest (reprocess tất cả)
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
    --group order-group --reset-offsets --to-earliest \
    --topic orders --execute

# Reset về latest (bỏ qua backlog, chờ message mới)
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
    --group order-group --reset-offsets --to-latest \
    --topic orders --execute

# Reset về offset cụ thể
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
    --group order-group --reset-offsets --to-offset 1000 \
    --topic orders:0 --execute  # chỉ partition 0

# Reset về thời điểm cụ thể
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
    --group order-group --reset-offsets \
    --to-datetime 2024-01-15T10:00:00.000 \
    --topic orders --execute

# Dịch chuyển offset (lùi 100 messages)
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
    --group order-group --reset-offsets --shift-by -100 \
    --topic orders --execute
```

**Flowchart chọn Reset Strategy:**

```d2 title="Reset Offset Strategies"
direction: down
A: "Cần Reset Offset"
B: "Lý do?" { shape: diamond }
C: "--to-earliest\nhoặc --to-datetime"
D: "--to-offset N+1\nhoặc --shift-by 1"
E: "--to-latest"
F: "--to-datetime\nYYYY-MM-DDTHH:MM:SS"
G: "Processing idempotent?" { shape: diamond }
H: "✅ An toàn để reprocess"
I: "⚠️ Nguy cơ side effects!\nVD: double billing"
A -> B
B -> C: "Bug fix - cần reprocess"
B -> D: "Bỏ qua message bị lỗi"
B -> E: "Consumer mới, bỏ qua lịch sử"
B -> F: "Replay N giờ gần đây"
C -> G
G -> H: "Có"
G -> I: "Không"
```

---

## Monitoring trong Spring Boot

### Dùng KafkaListenerEndpointRegistry

```java
@Autowired
private KafkaListenerEndpointRegistry registry;

// Xem partition đang được assign
public void logConsumerPositions() {
    registry.getListenerContainers().forEach(container -> {
        container.getAssignedPartitions().forEach(tp -> {
            log.info("Assigned: topic={}, partition={}", tp.topic(), tp.partition());
        });
    });
}
```

### Dùng AdminClient để inspect Consumer Groups

```java
public void describeConsumerGroup(String groupId) {
    try (AdminClient admin = AdminClient.create(
            Map.of("bootstrap.servers", "localhost:9092"))) {

        DescribeConsumerGroupsResult result = admin
            .describeConsumerGroups(List.of(groupId));

        ConsumerGroupDescription description =
            result.describedGroups().get(groupId).get();

        description.members().forEach(member -> {
            log.info("Member: {}", member.consumerId());
            log.info("Partitions: {}", member.assignment().topicPartitions());
        });
    }
}
```

### Spring Boot Actuator Kafka Metrics

Nếu dùng Spring Boot Actuator, các metrics quan trọng được expose:

| Metric | Mô tả |
|--------|-------|
| `kafka.consumer.records.lag` | Lag hiện tại per partition |
| `kafka.consumer.records.lag.max` | Lag tối đa across partitions |
| `kafka.consumer.fetch.manager.records.consumed.total` | Tổng records đã consume |
| `kafka.consumer.coordinator.commit.latency.avg` | Latency commit trung bình |

```yaml
# Bật trong application.yml
management:
  endpoints:
    web:
      exposure:
        include: health,metrics,prometheus
  metrics:
    enable:
      kafka: true
```

---

## Common Pitfalls

> [!IMPORTANT]
> **Debug tip khi consumer reprocess messages sau restart:**
> 1. `enable.auto.commit=true` nhưng processing chậm hơn `auto.commit.interval.ms`?
> 2. `group.id` có thay đổi giữa các restart không?
> 3. `auto.offset.reset` policy có đang reset offset không?

> [!CAUTION]
> **Auto-commit risk**: Nếu app crash sau khi xử lý message nhưng **trước** khi auto-commit, message sẽ được xử lý lại. Với dữ liệu critical, luôn dùng manual commit.

```yaml
spring:
  kafka:
    consumer:
      # Tắt auto-commit cho dữ liệu critical
      enable-auto-commit: false
```

<Cards>
  <Card title="Consumer Groups" href="/core-concepts/consumer-groups/" description="Rebalancing protocol, AckMode và scaling strategies" />
  <Card title="Partitioning Strategy" href="/core-concepts/partitioning-strategy/" description="Message keys, hot partitions, key salting" />
  <Card title="Exactly-Once Semantics" href="/producers-consumers/exactly-once/" description="EOS và idempotency patterns để tránh duplicate" />
</Cards>
