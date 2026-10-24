---
title: "Producers (Fundamentals)"
description: "Cách Kafka Producer hoạt động: batching, linger.ms, buffer memory, acks, retry và idempotent producer — trước khi dùng Spring Boot API"
---

# Producers (Fundamentals)

## Mục lục

- [Producer là gì?](#producer-là-gì)
- [Producer Pipeline](#producer-pipeline)
- [Batching & Linger.ms](#batching--lingerms)
- [Acks & Reliability](#acks--reliability)
- [Retry & Idempotency](#retry--idempotency)
- [Producer Configuration Reference](#producer-configuration-reference)

---

## Producer là gì?

**Producer** là bất kỳ ứng dụng nào **gửi (publish) messages** vào Kafka topic. Producer quyết định:
- Gửi vào **topic** nào
- Gửi vào **partition** nào (qua key hoặc custom partitioner)
- **Độ đảm bảo** (acks setting)

```d2 title="Pipeline của Kafka producer"
direction: right
app: Your Application
producer: Kafka Producer {
  ser: Serialize key + value
  partition: Partition selector
  buffer: Buffer — batch
  ser -> partition -> buffer
}
broker: Kafka Broker — Leader partition
app -> producer.ser
producer.buffer -> broker: Network
``` 

---

## Producer Pipeline

Từ lúc gọi `send()` đến khi message đến Broker, message đi qua pipeline:

```d2 title="Producer Pipeline"
direction: right
A: "Application\ncall send()"
B: "Serializer\nKey+Value → bytes"
C: "Partitioner\nchọn partition"
D: "RecordAccumulator\nBuffer — gom batch"
E: "Batch đủ lớn\nhoặc linger.ms hết?" { shape: diamond }
F: "Sender Thread\ngửi qua network"
G: "Kafka Broker\n(Leader Partition)"
H: "acks config?" { shape: diamond }
I: "✅ Return ngay\nkhông chờ"
J: "Chờ Leader ack"
K: "Chờ ISR ack"
L: "CompletableFuture\nresolved"
A -> B
B -> C
C -> D
D -> E
E -> F: "Yes"
E -> D: "No"
F -> G
G -> H
H -> I: "acks=0"
H -> J: "acks=1"
H -> K: "acks=all"
J -> L
K -> L
I -> L
```

---

## Batching & Linger.ms

Producer **gom nhiều messages vào một batch** trước khi gửi — tăng đáng kể throughput.

### Hai cơ chế trigger gửi batch

```d2 title="RecordAccumulator gom batch theo partition"
direction: right
buffer: RecordAccumulator {
  p0: "Partition 0 batch\nmsg1, msg2, msg3…"
  p1: "Partition 1 batch\nmsg1"
  p2: "Partition 2 batch\nmsg1, msg2"
}
trigger: "Batch đầy hoặc linger.ms hết?" {shape: diamond}
send: Sender thread gửi batch
buffer -> trigger
trigger -> send: Có
trigger -> buffer: Chưa
note: "Ví dụ cấu hình trong bài:\nbatch.size = 16KB, linger.ms = 0ms\nKiểm tra default theo version Kafka client"
```

### Tác dụng của linger.ms

```d2 title="linger.ms đổi latency lấy batching"
direction: right
zero: "linger.ms = 0" {input: msg1; request: 1 request / message; input -> request: Gửi ngay; note: Latency thấp — throughput thấp}
ten: "linger.ms = 10" {input: "msg1, msg2, msg3 trong 10ms"; request: 1 request / nhiều messages; input -> request: Gom batch; note: "Thêm 0–10ms latency\nThroughput cao hơn"}
```

### Cấu hình production-ready

```yaml
spring:
  kafka:
    producer:
      batch-size: 32768        # 32KB — lớn hơn mặc định 16KB
      linger-ms: 10            # Chờ 10ms để gom batch
      buffer-memory: 67108864  # 64MB total buffer
      compression-type: lz4   # Nén batch trước khi gửi
```

**Compression trade-off:**

| Codec | Compress ratio | CPU cost | Tốt nhất cho |
|-------|---------------|---------|-------------|
| none | 1x | 0 | Default, latency critical |
| gzip | 3-5x | Cao | Archival, kích thước quan trọng |
| snappy | 2-3x | Thấp | Balanced (Google recommend) |
| **lz4** | 2-3x | Rất thấp | **Production recommended** |
| zstd | 3-5x | Trung bình | Kafka 2.1+, tốt nhất về ratio/speed |

---

## Acks & Reliability

`acks` quyết định **khi nào Producer coi message là "đã gửi thành công"**:

```d2 title="Ba mức acks"
direction: right
none: "acks=0 — fire and forget" {p: Producer; b: Broker; p -> b: Không chờ ACK; risk: Có thể mất data khi broker down}
one: "acks=1 — leader ACK" {p: Producer; l: Leader; f: Follower; p -> l: Send; l -> p: ACK; l -> f: Replicate async; risk: Leader crash trước replication có thể mất data}
all: "acks=all / -1" {p: Producer; l: Leader; f1: ISR follower 1; f2: ISR follower 2; p -> l: Send; l -> f1: Replicate; l -> f2: Replicate; l -> p: ACK sau khi ISR xác nhận; note: "Độ bền còn phụ thuộc ISR / min.insync.replicas\nLatency cao hơn"}
```

> [!TIP]
> **Cho production:** Luôn dùng `acks=all` + `min.insync.replicas=2`. Đây là cấu hình đảm bảo **không mất data** trong khi vẫn có thể tolerate 1 broker failure.

---

## Retry & Idempotency

### Vấn đề với Retry đơn giản

> Playback dưới đây minh họa thứ tự các bước do tác giả chọn; không gửi request thật, không mô phỏng concurrency và tốc độ phát không phải latency. Bạn có thể chạy hoặc xem từng bước.

```d2 title="Retry sau timeout có thể tạo duplicate" mode=flow interactive=true
# @flow
# scenarios:
#   - id: main
#     label: "Kịch bản minh họa"
#     steps:
#       - edge: "(p -> b)[0]"
#         description: "Producer → Broker: Send msg A — broker nhận được"
#       - edge: "(p -> p)[0]"
#         description: "Producer → Producer: Timeout / mất response"
#       - edge: "(p -> b)[1]"
#         description: "Producer → Broker: Retry msg A"
# @endflow
shape: sequence_diagram
p: Producer
b: Broker
p -> b: Send msg A — broker nhận được
p -> p: Timeout / mất response {style.stroke-dash: 4}
p -> b: Retry msg A
b.note: "Không dedup → msg A có thể ghi hai lần"
```

### Idempotent Producer — Giải pháp

Kích hoạt `enable.idempotence=true` → Kafka tự dedup:

```d2 title="Idempotent producer deduplicate retry"
direction: right
p: "Producer\nProducerID + PartitionID + SequenceNumber"
b: "Broker kiểm tra sequence" {shape: diamond}
new: "Message mới\nWrite vào log"
dup: "Cùng sequence đã nhận\nKhông ghi lại"
p -> b
b -> new: Mới
b -> dup: Duplicate
scope: "Chống duplicate do retry\nPhạm vi producer session và partition"
```

```yaml
spring:
  kafka:
    producer:
      acks: all
      retries: 2147483647      # Retry tối đa
      properties:
        enable.idempotence: true
        max.in.flight.requests.per.connection: 5
        delivery.timeout.ms: 120000
```

> [!WARNING]
> `enable.idempotence=true` yêu cầu: `acks=all` và `max.in.flight.requests.per.connection <= 5`. Spring Kafka tự validate các ràng buộc này. Nếu cấu hình sai, app sẽ fail khi start.

### Retry có giới hạn vs Unlimited

```
retries=3: Thử tối đa 3 lần trong delivery.timeout.ms
           → Sau 3 lần fail: CompletableFuture.exceptionally() được gọi

retries=MAX_INT (2147483647): Thử mãi trong delivery.timeout.ms (mặc định 120s)
                               → Sau 120s: timeout exception
                               → Khuyến nghị với idempotent producer
```

---

## Producer Configuration Reference

| Property | Mặc định | Khuyến nghị Production | Mô tả |
|----------|---------|----------------------|-------|
| `acks` | `1` | `all` | Độ đảm bảo ack |
| `retries` | `2147483647` | `2147483647` | Số lần retry |
| `batch.size` | `16384` (16KB) | `32768` (32KB) | Kích thước batch |
| `linger.ms` | `0` | `10-20` | Thời gian chờ gom batch |
| `buffer.memory` | `33554432` (32MB) | `67108864` (64MB) | Buffer tổng |
| `compression.type` | `none` | `lz4` | Nén messages |
| `enable.idempotence` | `false` | `true` | Tránh duplicate |
| `max.in.flight.requests` | `5` | `5` | Concurrent requests |
| `delivery.timeout.ms` | `120000` (2 phút) | `120000` | Tổng timeout |

<Cards>
  <Card title="Producer API" href="/producers-consumers/producer-api/" description="KafkaTemplate methods và send patterns trong Spring Boot" />
  <Card title="Partitioning Strategy" href="/core-concepts/partitioning-strategy/" description="Keys, hot partitions và giải pháp" />
  <Card title="Exactly-Once" href="/producers-consumers/exactly-once/" description="Idempotent producer và transactions" />
</Cards>
