---
title: "Brokers & Cluster"
description: "Kiến trúc Kafka Cluster: broker, leader/follower replication, ISR, replication factor và cách Kafka đảm bảo high availability"
---

# Brokers & Cluster

## Mục lục

- [Broker là gì?](#broker-là-gì)
- [Kafka Cluster Architecture](#kafka-cluster-architecture)
- [Leader và Follower](#leader-và-follower)
- [ISR — In-Sync Replicas](#isr--in-sync-replicas)
- [Replication Factor](#replication-factor)
- [Fault Tolerance Scenarios](#fault-tolerance-scenarios)
- [Controller & KRaft Mode](#controller--kraft-mode)
- [Cluster Configuration](#cluster-configuration)

---

## Broker là gì?

**Broker** là một Kafka server node — process Java chạy trên máy chủ, chịu trách nhiệm:
- Nhận messages từ Producers
- Lưu trữ messages vào disk (commit log)
- Phục vụ messages cho Consumers
- Replication với các brokers khác

```d2 title="Các thành phần trong Kafka broker"
direction: down
broker: Kafka Broker {
  p0: "Partition 0 — Leader" {log: "Log segment\n[0, 1, 2…]"}
  p2: "Partition 2 — Follower" {log: "Log segment\n[0, 1, 2…]"}
  network: "Network layer\nProducers ↔ Consumers"
  storage: "Storage layer\nDisk-based commit log"
}
```

| Component | Mô tả | Analogy |
|-----------|-------|---------|
| **Broker** | Kafka server node | Bưu cục chi nhánh |
| **Topic** | Danh mục message logic | Nhãn hộp thư |
| **Partition** | Phân đoạn log có thứ tự | Ngăn hộp thư cụ thể |
| **Leader** | Xử lý tất cả reads/writes / replica primary | Nhân viên tại quầy |
| **Follower** | Sao lưu dữ liệu từ leader | Bản sao lưu trữ |
| **ISR** | Replicas đã sync đầy đủ với leader | Bản sao đã xác thực |

---

## Kafka Cluster Architecture

Một Kafka cluster gồm nhiều brokers hoạt động cùng nhau:

```d2 title="Kafka Cluster Architecture"
direction: down
g1: "Kafka Cluster (3 Brokers)" {
  B1: "🖥️ Broker 1\n(broker.id=1)"
  B2: "🖥️ Broker 2\n(broker.id=2)"
  B3: "🖥️ Broker 3\n(broker.id=3)"
}
g2: "Topic: orders (3 Partitions, RF=3)" {
  P0: "Partition 0\nLeader: B1\nFollowers: B2, B3"
  P1: "Partition 1\nLeader: B2\nFollowers: B1, B3"
  P2: "Partition 2\nLeader: B3\nFollowers: B1, B2"
}
Producer: "📤 Producer"
Consumer: "📥 Consumer"
Producer -> g1.B1
Producer -> g1.B2
Producer -> g1.B3
g1.B1 -> g2.P0
g1.B2 -> g2.P1
g1.B3 -> g2.P2
Consumer -> g1.B1
Consumer -> g1.B2
Consumer -> g1.B3
```

**Phân bố load tự động**: Kafka phân phối partition leaders đều giữa các brokers để cân bằng tải.

---

## Leader và Follower

Mỗi partition có một **Leader** và nhiều **Followers** (Replicas):

```d2 title="Replication của orders — partition 0"
direction: right
p: Producer
c: Consumer
l: "Broker 1\nLeader P0"
f2: "Broker 2\nFollower P0"
f3: "Broker 3\nFollower P0"
p -> l: Write request
c -> l: Read request
l -> f2: Replicate
l -> f3: Replicate
note: "Luồng minh họa mặc định:\nclient đọc / ghi qua leader"
```

**Nguyên tắc quan trọng:**
- **Chỉ Leader** nhận reads và writes từ Producers/Consumers
- **Followers** passively pull data từ Leader để sao chép
- Nếu Leader fail → một Follower trong ISR được **elect** thành Leader mới

---

## ISR — In-Sync Replicas

**ISR (In-Sync Replicas)** là tập hợp replicas đã **catch up đầy đủ** với Leader.

```d2 title="ISR và replica bị chậm"
direction: down
isr: "ISR = Broker 1, Broker 2" {
  b1: "Broker 1 — Leader P0\nmsg 0, 1, 2, 3, 4 (latest)"
  b2: "Broker 2 — Follower\nmsg 0, 1, 2, 3, 4 (in-sync)"
  b1 -> b2: Replication
}
b3: "Broker 3 — Follower\nmsg 0, 1, 2 (lagging, ngoài ISR)"
isr.b1 -> b3: Đang catch up {style.stroke-dash: 4}
```

### ISR và `acks` Setting

Cấu hình `acks` của Producer quyết định bao nhiêu replicas phải xác nhận trước khi message được coi là "committed":

| `acks` | Ý nghĩa | Độ bền | Throughput | Rủi ro |
|--------|---------|-------|-----------|-------|
| `0` | Không chờ ack nào | ❌ Thấp nhất | ✅ Cao nhất | Mất data khi broker fail |
| `1` | Chờ Leader ack | ⚠️ Trung bình | ✅ Cao | Mất data nếu Leader fail trước khi replicate |
| `all` | Chờ tất cả ISR ack | ✅ Cao nhất | ⚠️ Thấp hơn | Không mất data nếu ISR > 1 |

> [!IMPORTANT]
> `acks=all` chỉ an toàn khi ISR có **ít nhất 2 replicas**. Nếu chỉ còn 1 replica (Leader) trong ISR → `acks=all` vẫn return sau khi Leader ack, dễ mất data.
>
> Dùng `min.insync.replicas=2` để đảm bảo tối thiểu 2 replicas phải trong ISR.

---

## Replication Factor

**Replication Factor (RF)** = số bản sao của mỗi partition.

```d2 title="Replication factor 3 — leader phân bố giữa các broker"
direction: down
p0: "Partition 0" {l: "Broker 1 — LEADER"; f2: Broker 2 follower; f3: Broker 3 follower; l -> f2; l -> f3}
p1: "Partition 1" {l: "Broker 2 — LEADER"; f1: Broker 1 follower; f3: Broker 3 follower; l -> f1; l -> f3}
p2: "Partition 2" {l: "Broker 3 — LEADER"; f1: Broker 1 follower; f2: Broker 2 follower; l -> f1; l -> f2}
```

<Callout type="warn">
RF=3 không có nghĩa mất hai broker thì mọi thao tác vẫn bình thường. Với `acks=all` và `min.insync.replicas=2`, khi ISR chỉ còn một replica, producer sẽ bị từ chối ghi để bảo vệ độ bền.
</Callout>

**Rule of thumb:**
- Dev/Test: RF = 1 (không cần HA)
- Production: **RF = 3** — tiêu chuẩn công nghiệp
- Mission-critical: RF = 3 + `min.insync.replicas = 2`

### Tạo topic với replication factor

```bash
kafka-topics.sh --bootstrap-server localhost:9092 \
    --create \
    --topic orders \
    --partitions 6 \
    --replication-factor 3
```

### Cấu hình trong Spring Boot (Topic tự động tạo)

```java
@Configuration
public class KafkaTopicConfig {

    @Bean
    public NewTopic ordersTopic() {
        return TopicBuilder.name("orders")
            .partitions(6)
            .replicas(3)
            .config(TopicConfig.MIN_IN_SYNC_REPLICAS_CONFIG, "2")
            .build();
    }
}
```

---

## Fault Tolerance Scenarios

### Kịch bản 1: Broker thông thường fail

```d2 title="Leader failover từ replica trong ISR"
direction: right
before: "Trước" {
  b1: "Broker 1 — Leader P0\nActive, phục vụ read / write"
  b2: "Broker 2 — Follower P0, ISR"
  b3: "Broker 3 — Follower P0, ISR"
}
fail: "Broker 1 fail" {shape: diamond}
after: "Sau election + client reconnect" {
  b2: "Broker 2 — Leader P0 mới\nĐã có dữ liệu trong ISR"
  b3: "Broker 3 — Follower P0, ISR"
  isr: "ISR = Broker 2, Broker 3"
}
before -> fail -> after
note: "Ví dụ downtime thường < 30 giây;\nthực tế phụ thuộc election / reconnect"
```

### Kịch bản 2: Broker lag → Bị loại khỏi ISR

```d2 title="Kịch bản 2: Broker lag → Bị loại khỏi ISR"
shape: sequence_diagram
L: "Leader (B1)"
F: "Follower (B2)"
ISR: "ISR Set"
F.note1: "B2 bị slow (GC pause, network lag)"
L -> F: "Replicate msg 100"
F -> L: "10 giây sau mới ack (quá chậm!)" { style.stroke-dash: 4 }
ISR.note2: "B2 lag > replica.lag.time.max.ms"
L -> ISR: "Remove B2 from ISR"
ISR.note3: "ISR = {B1, B3}"
F.note4: "B2 recover, catch up"
F -> L: "Fetched and synced up to msg 100"
L -> ISR: "Add B2 back to ISR"
ISR.note5: "ISR = {B1, B2, B3}"
```

---

## Controller & KRaft Mode

### Controller là gì?

Trong một Kafka cluster, có một broker đóng vai trò đặc biệt: **Controller**. Controller chịu trách nhiệm quản lý **metadata toàn cluster** — biết topic nào có bao nhiêu partition, mỗi partition có leader là broker nào, ISR gồm những broker nào. Khi một broker chết, Controller là người quyết định bầu lại leader cho các partition bị ảnh hưởng.

```d2 title="Controller quản lý metadata của cluster"
direction: down
controller: "Broker 1 — Controller" {
  metadata: "Metadata toàn cluster\nPartition → leader mapping\nISR từng partition\nBroker sống / chết"
}
brokers: "Broker 2, 3, 4, 5\nCác broker thường"
controller -> brokers: Điều phối
```

### ZooKeeper — cách cũ (đã bị loại bỏ)

Trước Kafka 4.0, Kafka dùng **ZooKeeper** (một service riêng) để lưu metadata. Controller đọc/ghi metadata qua ZooKeeper. Cách này có 2 vấn đề:

1. **Phải vận hành thêm một cluster ZooKeeper** — thêm độ phức tạp vận hành, thêm điểm fail.
2. **Scale khó**: khi cluster có hàng chục nghìn partition, Controller phải ghi metadata vào ZooKeeper → ZooKeeper trở thành bottleneck (đặc biệt khi broker chết, phải elect lại leader hàng nghìn partition cùng lúc).

### KRaft Mode — cách mới (mặc định từ Kafka 4.0)

**KRaft (Kafka Raft)** đưa metadata vào **chính Kafka** — không cần ZooKeeper nữa. Một nhóm broker (gọi là **controller quorum**) dùng thuật toán **Raft** để đồng bộ metadata, tự bầu leader khi cần.

```d2 title="KRaft controller quorum và data broker"
direction: down
quorum: "Controller quorum" {
  b1: Broker 1 — Active controller
  b2: Broker 2 — Controller
  b3: Broker 3 — Controller
  b1 <-> b2: Raft consensus
  b1 <-> b3: Raft consensus
  metadata: "__cluster_metadata\nMetadata log"
}
data: "Broker 4, 5\nChứa data partition"
quorum -> data: Metadata / điều phối
```

### So sánh ZooKeeper vs KRaft

| Khía cạnh | ZooKeeper (cũ) | KRaft (mới) |
|-----------|----------------|-------------|
| Thành phần vận hành | Kafka + ZooKeeper (2 cluster) | Chỉ Kafka (1 hệ thống) |
| Metadata storage | ZooKeeper zNode | Internal topic `__cluster_metadata` |
| Scale giới hạn | ~200.000 partition/cluster (ZK bottleneck) | **Hàng triệu partition** |
| Controller failover | Chậm (phải đọc lại metadata từ ZK) | **Nhanh** (metadata đã sẵn trong topic, Raft elect < giây) |
| Vận hành | Phải tune ZooKeeper riêng | Đơn giản hơn, một stack |

> [!IMPORTANT]
> **Kafka 4.0 (phát hành 2025) đã bỏ hoàn toàn ZooKeeper.** KRaft là kiến trúc mặc định và duy nhất. Nếu bạn dùng Kafka 4.0+, không cần quan tâm ZooKeeper nữa. Nếu dùng Kafka 3.x, KRaft đã sẵn sàng (opt-in) và được khuyến nghị cho cluster mới.

### Cấu hình KRaft

Mỗi broker có `process.roles` xác định vai trò:

```properties
# server.properties — KRaft mode
process.roles=broker,controller       # vừa broker vừa controller (dev), hoặc 1 trong 2 (prod)
node.id=1
controller.quorum.voters=1@broker1:9093,2@broker2:9093,3@broker3:9093
listeners=PLAINTEXT://:9092,CONTROLLER://:9093
controller.listener.names=CONTROLLER
inter.broker.listener.name=PLAINTEXT
log.dirs=/var/kafka/logs
```

| `process.roles` | Vai trò | Khi nào dùng |
|-----------------|---------|--------------|
| `broker` | Chỉ chứa data partition | Production (tách biệt vai trò) |
| `controller` | Chỉ quản lý metadata | Production (controller chuyên dụng) |
| `broker,controller` | Cả hai | Dev/Test (tiết kiệm node) |

> [!TIP]
> Production nên tách: một nhóm 3 broker làm **controller** (chỉ quản lý metadata), một nhóm N broker làm **broker** (chỉ chứa data). Tách biệt giúp tải data không ảnh hưởng tới controller, và controller failover nhanh hơn.

### Vì sao KRaft quan trọng cho bạn?

- **Vận hành đơn giản hơn**: không còn ZooKeeper để cài đặt, tune, monitor, backup.
- **Recovery nhanh hơn**: khi broker chết, Controller mới nhận quyền trong < 1 giây (Raft) thay vì chục giây (ZK).
- **Scale tốt hơn**: cluster lớn (hàng trăm nghìn partition) không còn bị bottleneck metadata.

> [!CAUTION]
> Nếu đang chạy Kafka cũ với ZooKeeper và muốn chuyển sang KRaft: Kafka cung cấp **migration tool** (từ 3.4+). Quá trình migration yêu cầu cẩn thận — đọc kỹ documentation chính thức trước khi thực hiện trên production.

---

## Cluster Configuration

### Broker Configuration cơ bản

```properties
# server.properties
broker.id=1
listeners=PLAINTEXT://0.0.0.0:9092
log.dirs=/var/kafka/logs

# Replication
default.replication.factor=3
min.insync.replicas=2

# Retention
log.retention.hours=168     # 7 days
log.retention.bytes=-1       # Unlimited by size
log.segment.bytes=1073741824 # 1GB per segment

# Performance
num.network.threads=8
num.io.threads=16
socket.send.buffer.bytes=102400
socket.receive.buffer.bytes=102400
```

### Monitoring Cluster Health

```bash
# Xem tất cả topics và partition detail
kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic orders

# Output:
# Topic: orders   PartitionCount: 6   ReplicationFactor: 3
# Topic: orders   Partition: 0   Leader: 1   Replicas: 1,2,3   Isr: 1,2,3
# Topic: orders   Partition: 1   Leader: 2   Replicas: 2,1,3   Isr: 2,1,3
# ...

# Kiểm tra under-replicated partitions (ISR < RF)
kafka-topics.sh --bootstrap-server localhost:9092 \
    --describe --under-replicated-partitions

# Xem leader distribution
kafka-topics.sh --bootstrap-server localhost:9092 \
    --describe --unavailable-partitions
```

> [!WARNING]
> Nếu thấy **under-replicated partitions** trong production → **khẩn cấp**. Một broker đang bị lag hoặc đã down. Cluster dễ mất data nếu thêm một broker nữa fail.

<Cards>
  <Card title="Topics & Partitions" href="/core-concepts/topics-partitions/" description="Cấu trúc topic, partition, log append và retention" />
  <Card title="Producers" href="/core-concepts/producers/" description="Cách producer gửi message, batching và acks" />
  <Card title="Partitioning Strategy" href="/core-concepts/partitioning-strategy/" description="Keys, hot partitions và các giải pháp" />
</Cards>
