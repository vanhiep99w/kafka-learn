---
title: "Tại sao dùng Kafka?"
description: "So sánh Kafka với message queue truyền thống, điểm mạnh và điểm yếu khi chọn Kafka"
---

# Tại sao dùng Kafka?

## Mục lục

- [Kafka vs Message Queue truyền thống](#kafka-vs-message-queue-truyền-thống)
- [Tính năng nổi bật](#tính-năng-nổi-bật)
- [Khi nào NÊN dùng Kafka](#khi-nào-nên-dùng-kafka)
- [Khi nào KHÔNG NÊN dùng Kafka](#khi-nào-không-nên-dùng-kafka)
- [Kafka vs RabbitMQ vs SQS](#kafka-vs-rabbitmq-vs-sqs)

---

## Kafka vs Message Queue truyền thống

### Message Queue truyền thống (RabbitMQ, ActiveMQ)

```
Producer ──▶ [Queue] ──▶ Consumer
                 │
          (message bị xóa
           sau khi đọc)
```

- Message bị xóa sau khi consumer đọc
- Mỗi message chỉ được đọc bởi **một** consumer
- Không thể đọc lại dữ liệu cũ (replay)
- Tốt cho task distribution, job queue

### Kafka (Event Log)

```
Producer ──▶ [Partition: 0, 1, 2, 3, 4...]   ──▶ Consumer A (offset 3)
                                             ──▶ Consumer B (offset 1)
                                             ──▶ Consumer C (offset 5)
             (message lưu lại theo thời gian)
```

- Message **không bị xóa** sau khi đọc
- **Nhiều consumer** có thể đọc cùng message
- Consumer tự quản lý offset (vị trí đọc)
- Có thể **replay** từ bất kỳ offset nào

> [!IMPORTANT]
> Sự khác biệt cốt lõi: Kafka là **immutable append-only log**, không phải queue. Message không bị "consume" — chúng chỉ được đọc, và tự động xóa sau khi hết retention period.

---

## Tính năng nổi bật

### 1. High Throughput
Kafka có thể xử lý **hàng triệu messages/giây** trên một cluster nhỏ. Lý do:
- Sequential disk I/O (ghi tuần tự nhanh hơn random I/O rất nhiều)
- Zero-copy data transfer (OS kernel bypass)
- Batch processing

### 2. Horizontal Scalability
Thêm broker → tự động cân bằng partitions. Không có downtime khi scale.

### 3. Durability & Fault Tolerance
- Message được **replicate** sang nhiều brokers
- Khi một broker die, consumer tự động switch sang replica
- Configurable replication factor (thường là 3)

### 4. Replay capability
Consumer có thể đọc lại dữ liệu từ bất kỳ thời điểm nào trong retention window. Cực kỳ hữu ích để:
- Debug production issues
- Rebuild derived data stores
- Onboard new consumers với historical data

### 5. Decoupling
Producer và Consumer hoàn toàn độc lập:
- Producer không cần biết consumer đang làm gì
- Consumer có thể down mà không ảnh hưởng producer
- Thêm consumer mới mà không cần thay đổi producer

---

## Khi nào NÊN dùng Kafka

| Scenario | Lý do |
|----------|-------|
| **Event streaming real-time** | Throughput cao, low latency, fan-out tới nhiều consumers |
| **Microservices communication** | Async, decoupled, không phụ thuộc availability của nhau |
| **Log/metrics aggregation** | Centralize từ nhiều sources, fan-out tới monitoring tools |
| **Change Data Capture (CDC)** | Debezium đọc database binlog → Kafka → sync tới nhiều systems |
| **Event sourcing** | Lưu lịch sử state changes, rebuild state bất cứ lúc nào |
| **Stream processing pipeline** | Kafka Streams / Flink đọc → transform → ghi lại Kafka |

---

## Khi nào KHÔNG NÊN dùng Kafka

| Scenario | Thay thế tốt hơn |
|----------|-----------------|
| **Simple task queue** (job processing) | RabbitMQ, SQS, Bull/BullMQ |
| **Request-response pattern** | REST API, gRPC |
| **Message cần priority** | RabbitMQ (hỗ trợ priority natively) |
| **Message TTL ngắn** | Redis Pub/Sub, SQS |
| **Team nhỏ, ops burden cao** | SQS/SNS (managed), hoặc RabbitMQ |

> [!NOTE]
> Kafka có **overhead ops** đáng kể: cần quản lý cluster, monitor partition lag, tune configs. Với team nhỏ hoặc use case đơn giản, SQS hoặc RabbitMQ dễ hơn nhiều.

---

## Kafka vs RabbitMQ vs SQS

| Tiêu chí | Kafka | RabbitMQ | Amazon SQS |
|----------|-------|----------|-----------|
| **Throughput** | Rất cao (millions/s) | Cao (tens of thousands/s) | Cao (managed) |
| **Latency** | Low (ms) | Very low (sub-ms) | Low-medium |
| **Message retention** | Days/weeks (configurable) | Until consumed | 14 days max |
| **Replay** | Có | Không | Không |
| **Fan-out** | Dễ (nhiều consumer groups) | Có (exchange/binding) | Cần SNS kết hợp |
| **Ordering** | Per-partition | Per-queue | FIFO queue (optional) |
| **Ops complexity** | Cao | Trung bình | Thấp (managed) |
| **Cost** | Self-hosted rẻ, MSK đắt | Self-hosted rẻ | Pay per message |
| **Best for** | Event streaming, CDC | Task queue, RPC | Serverless, AWS native |

**Quy tắc chọn nhanh:**
- Cần throughput cực cao + replay → **Kafka**
- Task queue đơn giản + routing phức tạp → **RabbitMQ**
- Đang dùng AWS, muốn managed → **SQS/SNS**
