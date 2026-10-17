---
title: "Partitioning Strategy"
description: "Message keys, partition assignment, hot partitions và các giải pháp: key salting, custom partitioner, separate topics — với ví dụ thực tế Flash Sale, Twitter viral"
---

# Partitioning Strategy

## Mục lục

- [Message Key là gì?](#message-key-là-gì)
- [Decision: Có nên dùng Key không?](#decision-có-nên-dùng-key-không)
- [Option A: Không có Key](#option-a-không-có-key)
- [Option B: Có Key](#option-b-có-key)
- [Key Strategy Comparison](#key-strategy-comparison)
- [Trade-off Matrix](#trade-off-matrix)
- [Hot Partitions](#hot-partitions)
- [Phát hiện Hot Partition](#phát-hiện-hot-partition)
- [Giải pháp xử lý Hot Partition](#giải-pháp-xử-lý-hot-partition)
- [Prometheus Alerting](#prometheus-alerting)
- [Best Practices](#best-practices)

---

## Message Key là gì?

Mỗi message Kafka có thể có một **key** tùy chọn. Key quyết định message sẽ đến **partition nào**.

| Trường | Giá trị ví dụ |
| --- | --- |
| Key | `"order-123"` |
| Value | `{ orderId: 123, ... }` |
| Headers | `{ trace-id: "abc" }` |
| Timestamp | `1704067200000` |
| Partition | Tính từ hash(key) |

**Công thức phân partition:**

```
Partition = hash(key) % num_partitions
```

Nếu key là `null` → Kafka dùng **Sticky Partitioning** (gom vào một partition cho đến hết batch, rồi switch).

---

## Decision: Có nên dùng Key không?

```d2 title="Decision: Có nên dùng Key không?"
direction: down
A: "📤 Gửi Message"
B: "Các events liên quan\ncó cần được ordering không?" { shape: diamond }
C: "Dùng null key\n(Round-robin)"
D: "Key có phân phối\nđều không?" { shape: diamond }
E: "Dùng entity ID làm key\n(orderId, userId)"
F: "Ordering nghiêm ngặt\ncó bắt buộc không?" { shape: diamond }
G: "Dùng key salting\n(userId-1, userId-2...)"
H: "Chấp nhận hot partition\n+ scale partition count"
I: "✅ Load balance tốt nhất\n❌ Không đảm bảo ordering"
J: "✅ Ordering per-entity\n⚠️ Nguy cơ data skew"
K: "✅ Phân phối tốt hơn\n⚠️ Mất partial ordering"
L: "✅ Ordering nghiêm ngặt\n❌ Performance risk"
A -> B
B -> C: "❌ Không"
B -> D: "✅ Có"
D -> E: "✅ Đều"
D -> F: "⚠️ Không đều — Hot keys"
F -> G: "❌ Không"
F -> H: "✅ Có"
C -> I
E -> J
G -> K
H -> L
```

---

## Option A: Không có Key

Khi truyền `null` làm key, Kafka dùng **Sticky Partitioning**:

- Gom messages vào **một partition** cho đến hết batch
- Sau đó switch sang partition tiếp theo
- Hiệu quả gần giống Round-Robin

```java
// Gửi không có key
kafkaTemplate.send("orders", orderData);
// hoặc tường minh:
kafkaTemplate.send("orders", null, orderData);
```

**Kết quả:**

```
P0: ████████████████░░░░░░  ~25% traffic
P1: ████████████████░░░░░░  ~25% traffic
P2: ████████████████░░░░░░  ~25% traffic
P3: ████████████████░░░░░░  ~25% traffic
✅ Load balance hoàn hảo
❌ Không có ordering đảm bảo
```

**Khi nào dùng?**
- Log events, metrics, analytics
- Events độc lập không cần thứ tự (vd: "user clicked button")
- Khi throughput quan trọng hơn ordering

---

## Option B: Có Key

Khi truyền key, tất cả messages có **cùng key** luôn đến **cùng partition**:

```java
// Gửi với key — orderId quyết định partition
kafkaTemplate.send("orders", orderId, orderData);

// Template: send(topic, key, value)
kafkaTemplate.send("orders", "order-123", myOrderObj);
```

**Kết quả:**

```
hash("order-123") % 4 = 2

P0: ████░░░░░░░░░░░░░░░░░░  Các orders khác
P1: ███████░░░░░░░░░░░░░░░  Các orders khác
P2: ████████████████████░░  order-123, order-456, order-789...
P3: ████░░░░░░░░░░░░░░░░░░  Các orders khác

✅ Tất cả events của order-123 → P2 → đảm bảo ordering
⚠️ Phụ thuộc distribution của keys
```

**Khi nào dùng?**
- State machine (Created → Paid → Shipped → Delivered) — **phải dùng key**
- Events của cùng một entity cần ordering (user actions, order updates)
- Stateful processing per entity

---

## Key Strategy Comparison

| Strategy | Key Value | Partition Selection | Ordering | Load Balance | Use Case |
|----------|-----------|-------------------|----------|-------------|----------|
| **No Key** | `null` | Sticky/Round-robin | ❌ Không | ✅ Hoàn hảo | Logs, metrics, independent events |
| **Entity Key** | `orderId` | `hash % partitions` | ✅ Per-entity | ⚠️ Phụ thuộc distribution | Order events, user actions |
| **Compound Key** | `region:userId` | `hash % partitions` | ✅ Per-compound | ⚠️ Tốt hơn single | Multi-tenant systems |
| **Salted Key** | `userId-{0-9}` | Trải đều 10 partitions | ⚠️ Partial | ✅ Tốt hơn với hot keys | Celebrity/VIP users |
| **Explicit Partition** | Bất kỳ | Bạn tự chọn | ⚠️ Manual | ⚠️ Manual | Special routing |

---

## Trade-off Matrix

> **Quy tắc vàng**: Bạn đánh đổi Load Balancing để lấy Ordering.

| Yêu cầu | No Key | Entity Key | Salted Key |
|---------|--------|-----------|-----------|
| Max Throughput | ✅ Tốt nhất | ⚠️ Variable | ✅ Tốt |
| Ordering per Entity | ❌ Không có | ✅ Đảm bảo | ⚠️ Partial |
| Load Balance | ✅ Hoàn hảo | ⚠️ Nguy cơ skew | ✅ Tốt hơn |
| Độ đơn giản | ✅ Dễ | ✅ Dễ | ⚠️ Phức tạp |

---

## Hot Partitions

**Hot Partition** là partition nhận lượng traffic **không tương xứng** so với các partition khác, gây ra bottleneck, consumer lag, và nguy cơ system failure.

### Minh họa Hot Partition

Topic `user-events` có 6 partition:

| Partition | Messages/s | Consumer lag | Trạng thái |
| --- | ---: | ---: | --- |
| P0 | 500 | 0 | Bình thường |
| P1 | 400 | 0 | Bình thường |
| P2 | 50.000 | 2.500.000 | **HOT — consumer không bắt kịp** |
| P3 | 450 | 0 | Bình thường |
| P4 | 380 | 0 | Bình thường |
| P5 | 420 | 0 | Bình thường |

P2 nhận traffic khoảng 100 lần partition bình thường. Lag chỉ tập trung ở P2.

### Nguyên nhân Hot Partition

```d2 title="Nguyên nhân Hot Partition"
direction: down
A: "Nguyên nhân Hot Partition"
B: "Key Distribution Issues"
C: "Business Logic Patterns"
D: "Time-based Patterns"
B1: "Popular entities\n(celebrity users, viral products)"
B2: "Low cardinality keys\n(region: chỉ 3 giá trị)"
B3: "Poor key design"
C1: "Flash sales\n(1 product nhận toàn bộ traffic)"
C2: "Breaking news\n(1 topic trending)"
C3: "Bot attacks\n(1 IP/user flood)"
D1: "Time-based keys\n(tất cả events cùng giờ)"
D2: "Batch jobs\n(bulk inserts cùng key)"
A -> B
A -> C
A -> D
B -> B1
B -> B2
B -> B3
C -> C1
C -> C2
C -> C3
D -> D1
D -> D2
```

---

### Ví dụ Thực Tế

#### Ví dụ 1: E-Commerce Flash Sale

```d2 title="Flash sale tạo hot key productId"
direction: right
normal: "Ngày bình thường" {
  a: "Product A — 100/s"; b: "Product B — 120/s"; c: "Product C — 80/s"; d: "Product D — 110/s"
  p0: P0; p1: P1; p2: P2; p3: P3
  a -> p0; b -> p1; c -> p2; d -> p3
}
sale: "Flash sale — iPhone giảm 50%" {
  a: "Product A — 100/s"; b: "iPhone — 50,000/s"; c: "Product C — 80/s"; d: "Product D — 110/s"
  p0: P0; p1: "P1 — HOT"; p2: P2; p3: P3
  a -> p0; b -> p1; c -> p2; d -> p3
  impact: "Consumer P1 lag 5 giờ\nĐơn hàng chờ hàng giờ\nKhách thấy đang xử lý → thiệt hại doanh thu"
  p1 -> impact
}
```

#### Ví dụ 2: Social Media Viral (Twitter/X Effect)

```d2 title="Notification key quyết định phân phối"
direction: right
fanout: "@elonmusk tweet\n150 triệu followers" {keys: Key = userId từng follower; result: Phân phối đều; keys -> result}
mention: "10,000 người mention @elonmusk" {key: Key = elonmusk; result: Cùng một partition — HOT; key -> result}
```

#### Ví dụ 3: IoT Sensor Data

```d2 title="Low-cardinality key gây skew"
direction: right
nyc: "NYC — 50,000 sensors\n500K msg/s"
rural: "Rural — 500 sensors\n5K msg/s"
tokyo: "Tokyo — 80,000 sensors\n800K msg/s"
p0: P0 — HOT
p1: P1 — bình thường
p2: P2 — HOT
nyc -> p0: regionId
rural -> p1: regionId
tokyo -> p2: regionId
fix: "Đổi key sang sensorId\n130,500 unique keys → phân phối đều hơn"
```

---

## Phát hiện Hot Partition

### CLI Detection

```bash
# Xem consumer lag per partition — tìm LAG không đều
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
    --describe --group order-service

# Output cho thấy hot partition:
# GROUP         TOPIC    PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
# order-service orders   0          1000            1005            5        ← OK
# order-service orders   1          500             2500000         2499500  ← 🔥 HOT!
# order-service orders   2          800             810             10       ← OK

# Xem kích thước log per partition
kafka-log-dirs.sh --bootstrap-server localhost:9092 \
    --describe --topic-list orders
```

### JMX Metrics để monitor

```d2 title="JMX Metrics để monitor"
direction: right
g1: "Detection Methods" {
  A: "Monitoring"
  A1: "Consumer Lag\nper partition"
  A2: "Bytes In/Out\nper partition"
  A3: "Message rate\nper partition"
  B: "CLI Tools"
  B1: "kafka-consumer-groups.sh\n--describe"
  B2: "kafka-log-dirs.sh"
  C: "Metrics"
  C1: "JMX: MessagesInPerSec"
  C2: "JMX: BytesInPerSec"
  C3: "Prometheus/Grafana"
}
g1.A -> g1.A1
g1.A -> g1.A2
g1.A -> g1.A3
g1.B -> g1.B1
g1.B -> g1.B2
g1.C -> g1.C1
g1.C -> g1.C2
g1.C -> g1.C3
```

---

## Giải pháp xử lý Hot Partition

### Solution 1: Key Salting ✅ Khuyến nghị cho hầu hết cases

Thêm suffix ngẫu nhiên vào hot key để phân tán messages:

```d2 title="Key salting phân tán hot key"
direction: right
before: "Trước salting" {key: celebrity-user-123; p: "P2 — HOT"; key -> p: hash mod 6}
after: "Sau salting — ví dụ 6 partition" {
  k0: celebrity-user-123-0; k1: celebrity-user-123-1; k2: celebrity-user-123-2; k3: celebrity-user-123-3
  p0: P0; p3: P3; p1: P1; p5: P5
  k0 -> p0; k1 -> p3; k2 -> p1; k3 -> p5
}
tradeoff: "Phân phối sang nhiều partition\nĐổi lại mất strict ordering của hot key"
```

**Java Implementation:**

```java
@Service
public class SaltedKeyProducer {

    private final KafkaTemplate<String, OrderEvent> kafkaTemplate;
    private final Random random = new Random();

    private static final int SALT_BUCKETS = 10;

    // Hot keys đã biết — load từ config/database
    private final Set<String> hotKeys = Set.of(
        "celebrity-user-123",
        "viral-product-456",
        "breaking-news-topic"
    );

    public void sendEvent(String key, OrderEvent event) {
        String finalKey = key;

        // Chỉ áp dụng salting cho known hot keys
        if (hotKeys.contains(key)) {
            int salt = random.nextInt(SALT_BUCKETS);
            finalKey = key + "-" + salt;
        }

        kafkaTemplate.send("orders", finalKey, event);
    }

    // Khi cần partial ordering trong hot key (cùng session → cùng bucket)
    public void sendEventWithConsistentSalt(String key, String subKey, OrderEvent event) {
        String finalKey = key;

        if (hotKeys.contains(key)) {
            // Dùng subKey hash để consistent routing trong hot key
            int salt = Math.abs(subKey.hashCode()) % SALT_BUCKETS;
            finalKey = key + "-" + salt;
        }

        kafkaTemplate.send("orders", finalKey, event);
    }
}
```

---

### Solution 2: Custom Partitioner

Kiểm soát hoàn toàn logic routing:

```java
/**
 * Partitioner tùy chỉnh xử lý hot keys đặc biệt
 */
public class HotKeyAwarePartitioner implements Partitioner {

    private final Set<String> hotKeys = ConcurrentHashMap.newKeySet();
    private final AtomicInteger roundRobinCounter = new AtomicInteger(0);

    @Override
    public void configure(Map<String, ?> configs) {
        // Load hot keys từ config
        String hotKeyList = (String) configs.get("hot.keys");
        if (hotKeyList != null) {
            Arrays.stream(hotKeyList.split(","))
                  .map(String::trim)
                  .forEach(hotKeys::add);
        }
    }

    @Override
    public int partition(String topic, Object key, byte[] keyBytes,
                        Object value, byte[] valueBytes, Cluster cluster) {

        List<PartitionInfo> partitions = cluster.partitionsForTopic(topic);
        int numPartitions = partitions.size();

        if (key == null) {
            // Null key: round-robin
            return Math.abs(roundRobinCounter.getAndIncrement()) % numPartitions;
        }

        String keyStr = key.toString();

        if (hotKeys.contains(keyStr)) {
            // Hot key: phân tán across ALL partitions
            return Math.abs(roundRobinCounter.getAndIncrement()) % numPartitions;
        }

        // Normal key: dùng murmur2 hash mặc định
        return Utils.toPositive(Utils.murmur2(keyBytes)) % numPartitions;
    }

    @Override
    public void close() {}
}
```

**Cấu hình trong application.yml:**

```yaml
spring:
  kafka:
    producer:
      properties:
        partitioner.class: com.example.HotKeyAwarePartitioner
        hot.keys: celebrity-user-123,viral-product-456
```

---

### Solution 3: Separate Topics

Tách hot keys ra topic riêng với nhiều partitions hơn:

```d2 title="Solution 3: Separate Topics"
direction: down
g1: "Trước: Single Topic" {
  P1: "Producer"
  T1: "orders topic"
  C1: "Consumer Group"
}
g2: "Sau: Split by Traffic Pattern" {
  P2: "Producer"
  R: "Router" { shape: diamond }
  T2: "orders-normal\n6 partitions"
  T3: "orders-high-volume\n24 partitions"
  C2: "Consumer Group A\n6 instances"
  C3: "Consumer Group B\n24 instances"
}
g1.P1 -> g1.T1
g1.T1 -> g1.C1
g2.P2 -> g2.R
g2.R -> g2.T2: "Normal keys"
g2.R -> g2.T3: "Hot keys"
g2.T2 -> g2.C2
g2.T3 -> g2.C3
```

```java
@Service
public class TopicRoutingProducer {

    private final KafkaTemplate<String, OrderEvent> kafkaTemplate;
    private final Set<String> hotKeys;

    private static final String NORMAL_TOPIC = "orders-normal";
    private static final String HIGH_VOLUME_TOPIC = "orders-high-volume";

    public void sendEvent(String key, OrderEvent event) {
        String topic = hotKeys.contains(key) ? HIGH_VOLUME_TOPIC : NORMAL_TOPIC;
        kafkaTemplate.send(topic, key, event);
    }
}
```

---

### Solution 4: Tăng số Partitions

> [!WARNING]
> **Hiểu đúng**: Tăng partitions **KHÔNG fix** single hot key problem!

```d2 title="Tăng partition không chia nhỏ một hot key"
direction: right
before: "6 partitions" {k: hot-key; p: P2 — HOT; k -> p: hash mod 6}
after: "24 partitions" {k: hot-key; p: P14 — HOT; k -> p: hash mod 24}
before -> after: Tăng partition count
note: "Một key vẫn chỉ tới một partition\nKhông giải quyết single hot key"
```

**Khi nào tăng partition THỰC SỰ giúp ích:**
- Nhiều **hot keys khác nhau** đang collision vào cùng partition
- Cần nhiều consumer parallelism hơn
- Không phải single key causing all traffic

---

### Solution Comparison Matrix

| Giải pháp | Ordering giữ được? | Độ phức tạp | Throughput Gain | Dùng khi |
|----------|-------------------|------------|-----------------|----------|
| **Key Salting** | ❌ Mất với hot keys | Thấp | Cao (10x+) | Hầu hết trường hợp |
| **Consistent Salting** | ⚠️ Partial (trong bucket) | Trung bình | Trung bình | Cần partial ordering |
| **Custom Partitioner** | ❌ Mất với hot keys | Trung bình | Cao | Hot keys có thể dự đoán |
| **Separate Topics** | ✅ Trong mỗi topic | Cao | Rất cao | Traffic patterns rất khác biệt |
| **Tăng Partitions** | ✅ Đầy đủ | Thấp | ⚠️ Chỉ khi nhiều hot keys collision | Multiple hot keys colliding |

### Decision Flowchart

```d2 title="Decision Flowchart"
direction: down
A: "Phát hiện Hot Partition"
B: "Single hot key\nhay nhiều keys colliding?" { shape: diamond }
C: "Cần strict ordering\ncho key này không?" { shape: diamond }
D: "Tăng Partition Count"
E: "Có thể scale\nconsumer processing không?" { shape: diamond }
F: "Dùng Key Salting"
G: "Chấp nhận hot partition\n+ Faster consumer\n+ Dedicated consumer cho hot partition"
H: "Partial ordering\nchấp nhận được không?" { shape: diamond }
I: "Consistent Salting\n(salt by sub-key)"
J: "Separate Topic\ncho hot key"
A -> B
B -> C: "Single Hot Key"
B -> D: "Nhiều Keys Colliding"
C -> E: "Có, ordering critical"
C -> F: "Không, không cần ordering"
E -> G: "Có"
E -> H: "Không"
H -> I: "Có"
H -> J: "Không"
```

---

## Prometheus Alerting

```yaml
groups:
  - name: kafka-hot-partition-alerts
    rules:
      # Alert khi một partition có traffic gấp 10x trung bình
      - alert: KafkaHotPartitionDetected
        expr: |
          kafka_server_brokertopicmetrics_messagesin_total{topic="orders"}
          / on(topic) group_left
          avg(kafka_server_brokertopicmetrics_messagesin_total{topic="orders"}) by (topic)
          > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Hot partition phát hiện trong topic {{ $labels.topic }}"

      # Alert khi consumer lag đang tăng nhanh
      - alert: KafkaPartitionLagGrowing
        expr: |
          delta(kafka_consumergroup_lag{topic="orders"}[5m]) > 10000
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Partition {{ $labels.partition }} lag đang tăng nhanh"
```

---

## Best Practices

> [!TIP]
> **Phòng bệnh hơn chữa bệnh:**
> 1. Thiết kế key với uniform distribution ngay từ đầu
> 2. Monitor partition metrics từ ngày đầu deploy
> 3. Chuẩn bị salting strategy trước khi hot keys xuất hiện
> 4. Load test với data distribution thực tế (skewed data, không phải uniform)

> [!CAUTION]
> **Lỗi phổ biến:**
> 1. Dùng `null` key nghĩ là phân phối đều — đúng, nhưng mất ordering hoàn toàn
> 2. Nghĩ rằng thêm partitions sẽ fix single hot key — không đúng
> 3. Không test với production-like skewed data distribution
> 4. Bỏ qua hot partitions cho đến khi consumer lag trở nên critical

### Quick Reference — Công thức chọn Key

```d2 title="Chọn key và xử lý hot partition"
direction: right
order: "Cần ordering per entity?" {shape: diamond}
entity: Entity ID — orderId / userId
none: Null key — ưu tiên throughput
hot: "Key gây hot partition?" {shape: diamond}
critical: "Ordering critical\nKhông salt ngẫu nhiên; xem đúng scope ordering"
salt: "Ordering không quan trọng\nRandom salting"
collision: "Nhiều keys collision\nTăng partitions"
order -> entity: Có
order -> none: Không
entity -> hot
hot -> critical: Strict ordering
hot -> salt: Không cần ordering
hot -> collision: Collision
```

<Cards>
  <Card title="Consumer Groups" href="/core-concepts/consumer-groups/" description="Rebalancing, AckMode và partition assignment rules" />
  <Card title="Offset Management" href="/core-concepts/offsets/" description="5 lifecycle scenarios, CLI reset, consumer lag monitoring" />
  <Card title="Exactly-Once" href="/producers-consumers/exactly-once/" description="EOS và idempotency để xử lý duplicate messages" />
</Cards>
