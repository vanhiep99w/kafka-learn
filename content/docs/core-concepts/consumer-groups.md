---
title: "Consumer Groups"
description: "Hiểu sâu về Consumer Group trong Kafka: rebalancing protocol, partition assignment, AckMode và các kịch bản scaling thực tế"
---

# Consumer Groups

## Mục lục

- [Tổng quan](#tổng-quan)
- [Quy tắc Partition-Consumer Mapping](#quy-tắc-partition-consumer-mapping)
- [Multiple Consumer Groups — Pub/Sub](#multiple-consumer-groups--pubsub)
- [Rebalancing Protocol](#rebalancing-protocol)
- [Real World: Scaling Event](#real-world-scaling-event)
- [AckMode trong Spring Kafka](#ackmode-trong-spring-kafka)
- [Giảm thiểu Stop-the-world: Cooperative & Static Membership](#giảm-thiểu-stop-the-world-cooperative--static-membership)
- [Best Practices](#best-practices)

---

## Tổng quan

**Consumer Group** là một nhóm logic các consumer cùng nhau đọc dữ liệu từ một hoặc nhiều topic. Đây là cơ chế cho phép Kafka vừa scale horizontally (load balancing) vừa hỗ trợ Pub/Sub pattern.

Mỗi consumer group được định danh bằng một `group.id` duy nhất. Kafka theo dõi offset đã xử lý của **từng group**, không phải từng consumer instance.

```d2 title="Tổng quan"
direction: down
g1: "Topic: orders (4 Partitions)" {
  P0: "Partition 0"
  P1: "Partition 1"
  P2: "Partition 2"
  P3: "Partition 3"
}
g2: "Consumer Group: order-service" {
  C1: "Consumer 1"
  C2: "Consumer 2"
}
g1.P0 -> g2.C1
g1.P1 -> g2.C1
g1.P2 -> g2.C2
g1.P3 -> g2.C2
```

---

## Quy tắc Partition-Consumer Mapping

Đây là quy tắc cốt lõi — cần nhớ kỹ:

| Quy tắc | Mô tả | Ví dụ |
|---------|-------|-------|
| **Partition → 1 Consumer (trong group)** | Mỗi partition chỉ được đọc bởi **đúng một** consumer trong cùng group | P0 → C1 (không phải C1 VÀ C2) |
| **Partition → Nhiều Consumer (khác group)** | Cùng partition có thể được đọc bởi consumers từ **các group khác nhau** | P0 → C1 (Group A) VÀ CB1 (Group B) |
| **Consumer → Nhiều Partition** | Một consumer có thể đọc từ **nhiều partition** đồng thời | C1 đọc P0 VÀ P1 |

> [!IMPORTANT]
> **Tổng kết**: Trong một group là mapping 1:1 (partition → consumer). Giữa các group là many-to-many. Một consumer xử lý được nhiều partition, nhưng một partition chỉ có một consumer per group.

### Hậu quả khi có nhiều consumer hơn partition

Nếu bạn có **10 Partitions** và start **15 Consumers**, **5 consumer sẽ không làm gì** — họ ở trạng thái idle chờ rebalance.

```d2 title="10 partition chỉ có tối đa 10 consumer active"
direction: down
topic: "Topic: orders" {
  p0: "P0"
  p1: "P1"
  p2: "P2"
  p3: "P3"
  p4: "P4"
  p5: "P5"
  p6: "P6"
  p7: "P7"
  p8: "P8"
  p9: "P9"
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
c7: "Consumer 7"
topic.p6 -> c7
c8: "Consumer 8"
topic.p7 -> c8
c9: "Consumer 9"
topic.p8 -> c9
c10: "Consumer 10"
topic.p9 -> c10
c11: "Consumer 11 (IDLE)"
c12: "Consumer 12 (IDLE)"
c13: "Consumer 13 (IDLE)"
c14: "Consumer 14 (IDLE)"
c15: "Consumer 15 (IDLE)"
```

---

## Multiple Consumer Groups — Pub/Sub

Đây là cách Kafka hỗ trợ **Pub/Sub pattern**: nhiều service độc lập nhau cùng nhận một message.

```d2 title="Multiple Consumer Groups — Pub/Sub"
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
g4: "Group C: notification-service" {
  CC1: "Consumer C1"
}
g1.P0 -> g2.CA1
g1.P1 -> g2.CA1
g1.P2 -> g2.CA2
g1.P0 -> g3.CB1
g1.P1 -> g3.CB1
g1.P2 -> g3.CB1
g1.P0 -> g4.CC1
g1.P1 -> g4.CC1
g1.P2 -> g4.CC1
```

**Điểm quan trọng**: Mỗi group theo dõi offset **độc lập**. Group A ở offset 85, Group B ở offset 45 — hai group tiến độc lập, không ảnh hưởng nhau.

| Group | Service | Offset hiện tại | Ghi chú |
|-------|---------|----------------|---------|
| `order-service` | Xử lý đơn hàng | ~85 | Nhanh hơn |
| `analytics-service` | Phân tích dữ liệu | ~45 | Xử lý chậm hơn, không sao |
| `notification-service` | Gửi thông báo | ~92 | Gần real-time |

---

## Rebalancing Protocol

**Rebalancing** là quá trình Kafka phân lại partitions cho consumers. Đây là cơ chế đảm bảo fault tolerance và elastic scaling.

### Khi nào Rebalance xảy ra?

1. **Consumer mới gia nhập** group
2. **Consumer rời đi** (graceful shutdown hoặc crash/mất heartbeat)
3. **Topic metadata thay đổi** (thêm partitions mới)

### Giao thức Rebalancing (3 bước)

```d2 title="Giao thức Rebalancing (3 bước)"
shape: sequence_diagram
C1: "Consumer 1"
C2: "Consumer 2"
Coord: "Broker (Coordinator)"
C1.note1: "C1 / C2: C2 mới start"
C2 -> Coord: "JoinGroup (tôi muốn gia nhập)"
C1 -> Coord: "JoinGroup (triggered bởi rebalance)"
Coord -> C1: "Bạn là Leader! Members: [C1, C2]" { style.stroke-dash: 4 }
Coord -> C2: "Đợi assignment..." { style.stroke-dash: 4 }
C1.note2: "C1 tính toán partition assignments"
C1 -> Coord: "SyncGroup (Assignments: C1=[P0,P1], C2=[P2,P3])"
Coord -> C1: "Ack" { style.stroke-dash: 4 }
Coord -> C2: "Assignment của bạn: [P2, P3]" { style.stroke-dash: 4 }
```

#### Bước 1: FindCoordinator

Consumer tìm broker nào đang là **Group Coordinator** cho group của mình.

```
Coordinator Partition = hash(group.id) % __consumer_offsets_partitions
```

Broker chứa partition này sẽ là Coordinator.

#### Bước 2: JoinGroup

Tất cả consumer gửi `JoinGroup` request. Coordinator chọn ra một consumer làm **Leader** (thường là consumer đầu tiên).

#### Bước 3: SyncGroup

Leader consumer **tính toán** partition assignment (ai nhận partition nào), gửi lên Coordinator. Coordinator broadcast kết quả cho tất cả members.

> [!NOTE]
> Trong thời gian rebalancing xảy ra, toàn bộ consumer trong group **tạm dừng** xử lý (stop-the-world). Đây là lý do cần tránh rebalance thường xuyên trong production.

---

## Real World: Scaling Event

### Kịch bản: Topic `orders` với 4 Partitions

**Bước 1: Ban đầu — 1 Consumer**
```d2 title="Một consumer xử lý bốn partition"
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
```

**Bước 2: Scale up — Start thêm C2**
```d2 title="Consumer mới gia nhập — chia lại assignment"
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
c2: "Consumer 2"
topic.p2 -> c2
topic.p3 -> c2
```

**Bước 3: C2 crash — Mất heartbeat**
```d2 title="Consumer rời đi — resume từ committed offset"
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
note: "Coordinator chờ session.timeout.ms (ví dụ 45s)\nRebalance; C1 nhận lại P2, P3 từ committed offset"
```

> [!TIP]
> **Key insight**: Khi C2 crash, C1 tiếp tục từ **committed offset của C2**, không phải từ đầu. Offset được lưu theo group, không theo consumer instance.

---

## AckMode trong Spring Kafka

`AckMode` điều khiển **khi nào offset được commit** vào Kafka. Đây là một trong những config quan trọng nhất ảnh hưởng đến độ tin cậy và throughput.

### So sánh các AckMode

| AckMode | Commit khi nào | Throughput | Duplicate Risk | Dùng khi |
|---------|----------------|-----------|----------------|----------|
| `RECORD` | Sau mỗi record được xử lý | 🐢 Thấp | ✅ Tối thiểu | Dữ liệu critical, exactly-once |
| `BATCH` | Sau tất cả records trong `poll()` batch | 🚀 Cao | ⚠️ Moderate | Mặc định — balance tốt |
| `TIME` | Sau khoảng thời gian cấu hình | 🚗 Trung bình | ⚠️ Moderate | Time-based commits |
| `COUNT` | Sau N records được xử lý | 🚗 Trung bình | ⚠️ Moderate | Count-based commits |
| `MANUAL` | Khi gọi `Acknowledgment.acknowledge()` | ⚙️ Tùy chỉnh | ✅ Bạn kiểm soát | Processing logic phức tạp |
| `MANUAL_IMMEDIATE` | Ngay lập tức khi gọi `acknowledge()` | ⚙️ Tùy chỉnh | ✅ Tối thiểu | Cần commit real-time |

> [!TIP]
> **Mặc định của Spring**: `BATCH` mode. Với hầu hết ứng dụng, đây là lựa chọn tốt. Chuyển sang `MANUAL` khi cần acknowledge sau khi async processing hoàn thành.

### Cấu hình AckMode trong Spring Boot

```java
@Configuration
@EnableKafka
public class KafkaConsumerConfig {

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, String> kafkaListenerContainerFactory(
            ConsumerFactory<String, String> consumerFactory) {

        var factory = new ConcurrentKafkaListenerContainerFactory<String, String>();
        factory.setConsumerFactory(consumerFactory);

        // Cấu hình AckMode
        factory.getContainerProperties().setAckMode(
            ContainerProperties.AckMode.MANUAL_IMMEDIATE
        );

        return factory;
    }
}
```

### Dùng MANUAL AckMode

```java
@KafkaListener(topics = "orders", groupId = "order-group")
public void listen(String message, Acknowledgment ack) {
    try {
        // Xử lý message
        processOrder(message);

        // Chỉ acknowledge khi xử lý thành công
        ack.acknowledge();

    } catch (Exception e) {
        // Không acknowledge → message sẽ được retry
        log.error("Xử lý thất bại, không commit offset: {}", e.getMessage());
        // Có thể throw để trigger error handler
    }
}
```

### Khi nào dùng MANUAL?

```d2 title="Khi nào dùng MANUAL?"
direction: down
A: "Chọn AckMode"
B: "Xử lý có async không?" { shape: diamond }
C: "Cần exactly-once?" { shape: diamond }
D: "MANUAL\nAck sau khi async complete"
E: "BATCH (mặc định)\nThroughput cao, đủ an toàn"
F: "RECORD\nAck từng message"
G: "Dùng CompletableFuture\n+ ack.acknowledge() trong callback"
A -> B
B -> C: "Không"
B -> D: "Có - async DB/API"
C -> E: "Không"
C -> F: "Có"
D -> G
```

---

## Giảm thiểu Stop-the-world: Cooperative & Static Membership

Như đã nhắc ở phần Rebalancing Protocol, rebalance mặc định (**eager protocol**) khiến **toàn bộ group tạm dừng xử lý** trong lúc phân lại partition. Ở production với deploy thường xuyên hoặc autoscale, điều này gây "đứng" vài chục giây mỗi lần. Kafka cung cấp 2 giải pháp hiện đại để giảm dead time này.

### Vấn đề của Eager Protocol (mặc định)

Eager protocol chọn **an toàn tuyệt đối**: khi có rebalance, **mọi consumer buông tay toàn bộ partition**, chờ phân lại. Ngay cả partition **không đổi chủ** cũng phải dừng:

```d2 title="Eager rebalance"
direction: right
before: "C3 mới join\nC1 giữ P0,P1; C2 giữ P2,P3"
stop: "Eager — revoke toàn bộ" {
  c1: C1 revoke P0,P1
  c2: C2 revoke P2,P3
  c3: C3 chưa có partition
}
wait: "STOP toàn group\nVí dụ dead time ~30s"
after: "Assignment mới\nC1=[P0], C2=[P1,P2], C3=[P3]"
before -> stop -> wait -> after
```

### Giải pháp 1: Cooperative Rebalance Protocol

Cooperative protocol **chỉ di chuyển những partition thực sự đổi chủ**, các partition khác **tiếp tục xử lý không gián đoạn**:

```d2 title="Cooperative rebalance"
direction: right
join: C3 mới join
running: "Không dừng" {c1: C1 giữ P0,P1; c2: C2 giữ P2}
move: "Chỉ P3 tạm dừng" {c2: C2 revoke P3; c3: C3 nhận P3; c2 -> c3: Di chuyển P3}
join -> running
join -> move
```

Cấu hình trong Spring Boot:

```yaml
spring:
  kafka:
    consumer:
      properties:
        partition.assignment.strategy: org.apache.kafka.clients.consumer.CooperativeStickyAssignor
```

| Khía cạnh | Eager (mặc định) | Cooperative |
|-----------|------------------|-------------|
| Phạm vi dừng | Toàn bộ partition | Chỉ partition đổi chủ |
| Dead time khi C3 join | ~30 giây (cả group đứng) | ~1 giây (chỉ P3) |
| Yêu cầu | Mặc định | **Tất cả consumer dùng cùng strategy** |

> [!IMPORTANT]
> Cooperative protocol (Kafka 2.4+) giảm dead time cực kỳ hiệu quả. **Đây nên là lựa chọn mặc định cho production mới** — không có lý do gì dùng eager với cluster vừa/lớn.

### Giải pháp 2: Static Membership

Khi consumer restart (deploy, autoscale), nó gửi `LeaveGroup` → trigger rebalance. Static Membership gán cho mỗi consumer một **ID cố định** (`group.instance.id`). Khi consumer rời group, Kafka **không lập tức rebalance** — giữ nguyên partition assignment trong `session.timeout.ms`. Nếu consumer restart lại (cùng ID) trong khoảng đó, nó **claim lại đúng partition cũ** → không rebalance.

```yaml
spring:
  kafka:
    consumer:
      properties:
        # Mỗi pod/instance dùng ID cố định (vd từ hostname)
        group.instance.id: "${HOSTNAME}"
        # Cho phép consumer restart trong khoảng này mà không trigger rebalance
        session.timeout.ms: 300000    # 5 phút — đủ cho restart
```

```d2 title="Static membership khi restart"
direction: right
dynamic: "Không static membership" {
  restart: C1 restart
  leave: LeaveGroup
  rebalance: "Rebalance ngay\nCả group dừng, ví dụ ~30s"
  restart -> leave -> rebalance
}
static: "group.instance.id = pod-1" {
  restart: "C1 restart\nKhông gửi LeaveGroup, mất heartbeat"
  retain: "Kafka giữ assignment\nTrong session.timeout.ms"
  resume: "C1 trở lại kịp timeout\nNhận lại P0,P1 — không rebalance"
  restart -> retain -> resume
}
```

> [!TIP]
> Static membership rất hiệu quả cho **Kubernetes rolling deploy / autoscale**. Mỗi pod dùng `metadata.name` (tên pod cố định) làm `group.instance.id` → restart pod không gây rebalance nữa. Lưu ý: cần đảm bảo ID **duy nhất** trong group.

> [!CAUTION]
> Trade-off của static membership: khi consumer thực sự chết (không quay lại), partition của nó **không được xử lý** trong suốt `session.timeout.ms`. Phải cân `session.timeout.ms`: đủ dài để restart, đủ ngắn để failover khi crash thật.

### Kết hợp cả hai

Production tốt nhất dùng **cả cooperative + static membership** — giảm dead time khi rebalance (cooperative) + tránh rebalance hoàn toàn khi restart (static). Xem phân tích sâu hơn trong bài [Câu hỏi phỏng vấn: Rebalance stop-the-world](/interview/rebalance-stop-the-world/).

---

## Best Practices

### Thiết kế Consumer Group

| Thực hành | Lý do |
|-----------|-------|
| Giữ `group.id` nhất quán giữa các deployment | Thay đổi group.id = mất toàn bộ offset history, phải đọc lại từ đầu |
| Số consumers ≤ số partitions | Consumer thừa sẽ idle, lãng phí tài nguyên |
| Thiết kế partition count = max expected consumers | Không thể giảm partitions sau khi tạo topic |
| Tách biệt consumer groups cho các use cases khác nhau | Mỗi service nên có group.id riêng |

### Tránh Rebalance Storms

```yaml
spring:
  kafka:
    consumer:
      # Tăng timeout để tránh rebalance do GC pause hay slow processing
      properties:
        session.timeout.ms: 45000        # Mặc định 45s
        heartbeat.interval.ms: 15000     # Nên = 1/3 session.timeout
        max.poll.interval.ms: 300000     # Thời gian tối đa giữa 2 lần poll()
        max.poll.records: 100            # Giảm số records/poll nếu processing chậm
```

> [!CAUTION]
> **Lỗi phổ biến**: Nếu processing time > `max.poll.interval.ms`, Kafka sẽ coi consumer là "dead" và trigger rebalance, dù consumer vẫn đang chạy. Giải pháp: giảm `max.poll.records` hoặc tăng `max.poll.interval.ms`.

### Giám sát Consumer Group

```bash
# Xem tất cả consumer groups
kafka-consumer-groups.sh --bootstrap-server localhost:9092 --list

# Xem chi tiết group: offset, lag, assignment
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
    --describe --group order-group

# Output mẫu:
# GROUP       TOPIC   PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG   CONSUMER-ID
# order-group orders  0          1523            1530            7     consumer-1-xxx
# order-group orders  1          892             900             8     consumer-2-xxx
```

<Cards>
  <Card title="Offset Management" href="/core-concepts/offsets/" description="Deep dive vào cách Kafka lưu trữ và quản lý offset, 5 kịch bản lifecycle" />
  <Card title="Partitioning Strategy" href="/core-concepts/partitioning-strategy/" description="Message keys, hot partitions, key salting và custom partitioner" />
  <Card title="Consumer API" href="/producers-consumers/consumer-api/" description="@KafkaListener, headers, concurrency trong Spring Boot" />
</Cards>
