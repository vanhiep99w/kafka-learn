---
title: "Topics và Partitions"
description: "Hiểu sâu về Topics, Partitions, Segments trong Kafka — nền tảng của mọi kiến thức về Kafka"
---

# Topics và Partitions

## Mục lục

- [Topic là gì?](#topic-là-gì)
- [Partition là gì?](#partition-là-gì)
- [Message trong Kafka](#message-trong-kafka)
- [Replication](#replication)
- [Log Segments và Retention](#log-segments-và-retention)
- [Cấu hình thực tế](#cấu-hình-thực-tế)

---

## Topic là gì?

**Topic** là kênh (channel) để tổ chức và lưu trữ messages trong Kafka. Tương tự như:
- **Table** trong database
- **Folder** trong filesystem
- **Subject** trong pub/sub systems

Đặc điểm:
- Tên topic thường mô tả dữ liệu: `user-events`, `order-created`, `payment-processed`
- Topic được **chia thành partitions** để scale
- Producer ghi vào topic, Consumer đọc từ topic

```d2 title="Topic gồm nhiều partition"
direction: down
topic: "order-events" {p0: "Partition 0\nmsg0, msg1, msg2…"; p1: "Partition 1\nmsg0, msg1, msg2…"; p2: "Partition 2\nmsg0, msg1, msg2…"}
```

---

## Partition là gì?

Partition là đơn vị **parallel** của Kafka. Mỗi partition là một **ordered, immutable sequence of records** (log file).

### Tại sao cần Partition?

Một topic với 1 partition = single-threaded = bottleneck. Nhiều partitions = parallel processing:

```d2 title="Song song hóa qua partition"
direction: right
a: Producer A; b: Producer B; c: Producer C
p0: Partition 0; p1: Partition 1; p2: Partition 2
c1: Consumer 1; c2: Consumer 2; c3: Consumer 3
a -> p0 -> c1
b -> p1 -> c2
c -> p2 -> c3
```

### Partition Key

Producer quyết định message vào partition nào bằng **partition key**:

| Key | Hành vi |
|-----|---------|
| Không có key (null) | Round-robin qua các partitions |
| Có key | Hash(key) % num_partitions |

> [!IMPORTANT]
> Messages cùng key **luôn vào cùng partition** → đảm bảo ordering cho một entity cụ thể. Ví dụ: dùng `user_id` làm key → tất cả events của user đó đi vào cùng partition → đúng thứ tự.

### Kafka chỉ đảm bảo ordering trong partition

```d2 title="Ordering chỉ được đảm bảo trong từng partition"
direction: right
p0: "Partition 0 — ordered" {a: order 1 created; b: order 1 paid; c: order 1 shipped; a -> b -> c}
p1: "Partition 1 — ordered" {a: order 2 created; b: order 2 cancelled; a -> b}
note: "Không có ordering giữa hai partition"
```

---

## Message trong Kafka

Mỗi message (còn gọi là **record**) gồm:

| Trường | Giá trị ví dụ |
| --- | --- |
| Offset | `42` |
| Timestamp | `2024-01-15T10:30:00Z` |
| Key | `"user-123"` (optional) |
| Value | `{"action":"login",...}` |
| Headers | `trace-id: abc123` |

| Field | Mô tả |
|-------|-------|
| **Offset** | Số thứ tự trong partition, tự tăng, immutable |
| **Timestamp** | Khi message được tạo hoặc append vào log |
| **Key** | Dùng để route vào partition, optional |
| **Value** | Payload chính — thường là JSON, Avro, Protobuf |
| **Headers** | Metadata: trace-id, content-type, source-service |

---

## Replication

Mỗi partition có **1 Leader** và **N-1 Followers** (replicas):

```d2 title="Replication factor 3"
direction: right
b1: "Broker 1 — Leader P0"
b2: "Broker 2 — Follower P0"
b3: "Broker 3 — Follower P0"
b1 -> b2: Replicate
b1 -> b3: Replicate
```

- Producer/Consumer **chỉ làm việc với Leader**
- Followers sync data từ Leader
- Nếu Leader die → một Follower được bầu làm Leader mới (automatic)
- **ISR (In-Sync Replicas)**: tập hợp replicas đã sync đủ với Leader

> [!TIP]
> Replication Factor = 3 là best practice cho production. Nghĩa là dữ liệu được lưu trên 3 brokers — có thể chịu được 2 broker fail đồng thời mà không mất dữ liệu.

---

## Log Segments và Retention

Kafka không lưu toàn bộ partition trong 1 file — chia thành **segments**:

```
Partition 0 directory:
├── 00000000000000000000.log   (offset 0-999)
├── 00000000000000001000.log   (offset 1000-1999)
├── 00000000000000002000.log   (offset 2000-2999, active segment)
├── 00000000000000000000.index
└── 00000000000000001000.index
```

**Retention policies:**

| Policy | Config | Mô tả |
|--------|--------|-------|
| **Time-based** | `retention.ms=604800000` | Xóa sau 7 ngày (mặc định) |
| **Size-based** | `retention.bytes=1073741824` | Xóa khi partition > 1GB |
| **Compact** | `cleanup.policy=compact` | Chỉ giữ message mới nhất của mỗi key |

---

## Cấu hình thực tế

```bash
# Tạo topic với 3 partitions, replication factor 3
kafka-topics.sh --create \
  --bootstrap-server localhost:9092 \
  --topic order-events \
  --partitions 3 \
  --replication-factor 3

# Xem thông tin topic
kafka-topics.sh --describe \
  --bootstrap-server localhost:9092 \
  --topic order-events

# Thay đổi số partitions (chỉ tăng, không giảm được)
kafka-topics.sh --alter \
  --bootstrap-server localhost:9092 \
  --topic order-events \
  --partitions 6
```

**Số partitions nên chọn bao nhiêu?**

```
Rule of thumb:
partitions = max(throughput_producer / throughput_per_partition,
                 throughput_consumer / throughput_per_partition)

Thực tế:
- Start với partitions = số consumers dự kiến trong consumer group
- Một partition có thể xử lý ~10-100 MB/s tùy cấu hình
- Đừng over-partition: nhiều partitions = nhiều overhead (metadata, file handles)
```

> [!NOTE]
> Số partitions **chỉ tăng được, không giảm được**. Khi tăng, ordering của existing keys bị phá vỡ (vì hash thay đổi). Nên plan kỹ từ đầu.
