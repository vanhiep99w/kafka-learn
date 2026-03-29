---
title: "Performance Tuning"
description: "Tối ưu Kafka cho Throughput cao và Latency thấp: producer batching, consumer tuning, broker config, compression, và các trade-offs quan trọng trong production"
---

# Performance Tuning

## Throughput vs Latency Trade-off

Đây là **fundamental trade-off** trong Kafka. Không thể tối ưu cả hai cùng lúc:

| Setting | Tăng Throughput | Giảm Latency |
|---------|----------------|-------------|
| `batch.size` | ↑ Tăng (512KB) | ↓ Giảm (16KB) |
| `linger.ms` | ↑ Tăng (20-100ms) | = 0 (gửi ngay) |
| `acks` | `1` hoặc `0` | `1` (không dùng `all`) |
| `compression.type` | `lz4` hoặc `zstd` | `none` |
| `fetch.min.bytes` | ↑ Tăng (512KB) | = 1 (return ngay) |
| `max.poll.records` | ↑ Tăng (2000) | ↓ Giảm (100) |

---

## Producer Tuning

### Batching

```yaml
spring:
  kafka:
    producer:
      batch-size: 65536           # 64KB (default 16KB) — tăng cho throughput
      linger-ms: 20               # Chờ thêm 20ms để gom batch (default 0)
      buffer-memory: 67108864     # 64MB total buffer
      compression-type: lz4       # Compress để giảm network
      properties:
        max.in.flight.requests.per.connection: 5
```

### acks Trade-off

| `acks` | Latency | Durability | Dùng khi |
|--------|---------|------------|---------|
| `0` | ✅ Fastest | ❌ Mất được | Metrics, logs |
| `1` | ✅ Fast | ⚠️ Moderate | Balanced |
| `all` | ❌ Slow | ✅ Highest | Payments, critical |

### Configuration Profiles

```yaml
# HIGH THROUGHPUT (Log ingestion, Analytics)
spring.kafka.producer:
  acks: 1
  batch-size: 524288      # 512KB
  linger-ms: 100
  compression-type: lz4
  buffer-memory: 134217728  # 128MB

# LOW LATENCY (Payments, Alerts)
spring.kafka.producer:
  acks: all
  batch-size: 16384       # Default
  linger-ms: 0
  compression-type: none
  properties:
    enable.idempotence: true

# HIGH RELIABILITY (Financial, Audit)
spring.kafka.producer:
  acks: all
  retries: 2147483647
  linger-ms: 10
  compression-type: lz4
  properties:
    enable.idempotence: true
    delivery.timeout.ms: 120000
```

---

## Consumer Tuning

```yaml
spring:
  kafka:
    consumer:
      max-poll-records: 500       # Default — tăng cho throughput, giảm nếu processing chậm
      properties:
        fetch.min.bytes: 50000    # Chờ 50KB data (throughput) hoặc 1 (latency)
        fetch.max.wait.ms: 500    # Timeout nếu chưa đủ data
        fetch.max.bytes: 52428800 # 50MB max per fetch
        max.poll.interval.ms: 300000  # PHẢI > max.poll.records × process_time_per_record
```

**Quy tắc **: `max.poll.interval.ms` > `max.poll.records × processing_time_per_record`

```
Ví dụ:
  max.poll.records = 500, processing_time = 100ms/record
  → Total time = 500 × 100ms = 50s
  → Set max.poll.interval.ms = 120,000 (2 min) để có buffer
```

### Concurrency

```java
@KafkaListener(topics = "orders", concurrency = "4") // 4 threads per instance
public void process(String msg) { ... }
```

> [!WARNING]
> Concurrency ≤ partition count. Thread thừa sẽ idle.

---

## Broker Tuning

```properties
# server.properties

# I/O Threads
num.io.threads=8
num.network.threads=3

# Log
log.retention.hours=168          # 7 days
log.segment.bytes=1073741824     # 1GB per segment
log.flush.interval.messages=10000

# Replication
replica.fetch.max.bytes=1048576
replica.lag.time.max.ms=10000

# Socket buffers
socket.send.buffer.bytes=102400
socket.receive.buffer.bytes=102400
```

---

## Compression

| Codec | Ratio | Speed | Best For |
|-------|-------|-------|---------|
| `none` | 1x | Fastest | High CPU machines |
| `gzip` | 3-5x | Slow | Archival |
| `snappy` | 2-3x | Fast | Balanced |
| `lz4` | 2-3x | Very fast | ✅ Most cases |
| `zstd` | 4-5x | Fast | Best ratio + speed |

---

## Topic Design

```bash
# Partition count formula:
# partitions = max(throughput_needed / throughput_per_partition, max_consumers)

# Tạo topic với config tối ưu
kafka-topics.sh --bootstrap-server localhost:9092 \
    --create --topic orders \
    --partitions 24 \
    --replication-factor 3 \
    --config retention.ms=604800000 \
    --config compression.type=lz4
```

> [!CAUTION]
> **Không thể giảm partition count sau khi tạo!** Chỉ tăng được. Plan từ đầu.

---

## JVM Tuning

```bash
export KAFKA_HEAP_OPTS="-Xms6g -Xmx6g"
export KAFKA_JVM_PERFORMANCE_OPTS="
  -server
  -XX:+UseG1GC
  -XX:MaxGCPauseMillis=20
  -XX:InitiatingHeapOccupancyPercent=35"
```

**G1GC** là lựa chọn tốt nhất — predictable pause times tránh false session timeouts.

---

## Benchmarking

```bash
# Producer perf test
kafka-producer-perf-test.sh \
    --topic perf-test \
    --num-records 10000000 \
    --record-size 1000 \
    --throughput -1 \
    --producer-props bootstrap.servers=localhost:9092 \
        acks=1 batch.size=65536 linger.ms=20 compression.type=lz4

# Output: 125,000 records/sec (119 MB/sec), avg latency 32ms

# Consumer perf test
kafka-consumer-perf-test.sh \
    --bootstrap-server localhost:9092 \
    --topic perf-test \
    --messages 10000000 \
    --group perf-group
```

<Cards>
  <Card title="Monitoring" href="/operations/monitoring/" description="Prometheus, Grafana, consumer lag alerting" />
  <Card title="Security" href="/operations/security/" description="SSL/TLS, SASL, ACL" />
  <Card title="Producer API" href="/producers-consumers/producer-api/" description="KafkaTemplate config và callbacks" />
</Cards>
