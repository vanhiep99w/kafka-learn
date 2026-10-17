---
title: "Tổng quan Apache Kafka"
description: "Apache Kafka là gì, tại sao cần dùng, kiến trúc tổng thể và các thành phần chính"
---

# Tổng quan Apache Kafka

## Mục lục

- [Kafka là gì?](#kafka-là-gì)
- [Vấn đề Kafka giải quyết](#vấn-đề-kafka-giải-quyết)
- [Kiến trúc tổng thể](#kiến-trúc-tổng-thể)
- [Các thành phần chính](#các-thành-phần-chính)
- [Use Cases phổ biến](#use-cases-phổ-biến)
- [Kafka trong hệ sinh thái](#kafka-trong-hệ-sinh-thái)

---

## Kafka là gì?

Apache Kafka là một **distributed event streaming platform** — nền tảng truyền dữ liệu theo dạng sự kiện (event) có khả năng mở rộng cao. Kafka được thiết kế để:

- **Publish và subscribe** dòng dữ liệu (stream of records) giống như message queue
- **Lưu trữ bền vững** (durable storage) các stream theo thứ tự và có khả năng replay lại
- **Xử lý real-time** các stream khi chúng xảy ra

```d2 title="Producer, broker và consumer"
direction: right
p1: Producer 1
p2: Producer 2
cluster: Apache Kafka Cluster {
  broker: "Kafka brokers" {topic: "Topic orders" {p0: P0; p1: P1; p2: P2}}
}
c1: Consumer 1
c2: Consumer 2
p1 -> cluster.broker
p2 -> cluster.broker
cluster.broker -> c1
cluster.broker -> c2
```

> [!IMPORTANT]
> Kafka **không phải** là một message queue thông thường. Kafka lưu trữ message lâu dài (configurable, mặc định 7 ngày) và nhiều consumer có thể đọc cùng một message mà không xóa nó.

---

## Vấn đề Kafka giải quyết

### Trước khi có Kafka

Trong các hệ thống truyền thống, khi số lượng services tăng lên, việc kết nối point-to-point trở nên rất phức tạp:

```d2 title="Trước khi có Kafka"
direction: down
g1: "Point-to-Point: n x (n-1) / 2 connections" {
  A: "Service A\nOrder Service"
  B: "Service B\nInventory Service"
  C: "Service C\nNotification Service"
  D: "Service D\nAnalytics Service"
  E: "Service E\nShipping Service"
}
g1.A <-> g1.B: "HTTP/gRPC"
g1.A <-> g1.C: "HTTP/gRPC"
g1.A <-> g1.D: "HTTP/gRPC"
g1.B <-> g1.C: "HTTP/gRPC"
g1.B <-> g1.E: "HTTP/gRPC"
g1.C <-> g1.D: "HTTP/gRPC"
g1.D <-> g1.E: "HTTP/gRPC"
```

**Vấn đề:**
- Với 5 services: **10 connections** — với 10 services: **45 connections**
- Mỗi service cần biết địa chỉ, protocol, retry logic của các services khác
- Thêm service mới = cập nhật N services khác
- Khó scale, khó maintain, dễ tạo ra bottleneck

### Với Kafka

```d2 title="Với Kafka"
direction: right
g1: "Producers" {
  A: "Order Service"
  B: "Payment Service"
  C: "User Service"
}
g2: "Kafka Cluster" {
  K: "Topics:\norders\npayments\nuser-events"
}
g3: "Consumers" {
  D: "Inventory\nService"
  E: "Notification\nService"
  F: "Analytics\nService"
}
g1.A -> g2.K: "orders"
g1.B -> g2.K: "payments"
g1.C -> g2.K: "user-events"
g2.K -> g3.D
g2.K -> g3.E
g2.K -> g3.F
```

**Lợi ích:**
- Decoupling hoàn toàn giữa producers và consumers
- Mỗi service chỉ cần biết Kafka, không cần biết nhau
- Thêm consumer mới = subscribe topic, không ảnh hưởng producer
- Thêm producer mới = gửi đến topic, không ảnh hưởng consumer

---

## Kiến trúc tổng thể

```d2 title="Kiến trúc tổng thể"
direction: down
g1: "Producers" {
  P1: "Web App"
  P2: "Mobile App"
  P3: "IoT Sensors"
}
g2: "Kafka Cluster" {
  B1: "Broker 1"
  B2: "Broker 2"
  B3: "Broker 3"
  ZK: "ZooKeeper / KRaft"
}
g3: "Consumers" {
  C1: "Analytics Service"
  C2: "Notification Service"
  C3: "Database Sink"
}
g1.P1 -> g2.B1
g1.P2 -> g2.B2
g1.P3 -> g2.B3
g2.B1 <-> g2.B2
g2.B2 <-> g2.B3
g2.B1 <-> g2.B3
g2.ZK -- g2.B1
g2.ZK -- g2.B2
g2.ZK -- g2.B3
g2.B1 -> g3.C1
g2.B2 -> g3.C2
g2.B3 -> g3.C3
```

---

## Các thành phần chính

| Thành phần | Mô tả |
|------------|-------|
| **Topic** | Kênh dữ liệu — nơi messages được publish và subscribe |
| **Partition** | Topic được chia thành nhiều partition để scale và song song hóa |
| **Broker** | Server Kafka, lưu trữ và phục vụ messages |
| **Producer** | Ứng dụng gửi message vào Kafka |
| **Consumer** | Ứng dụng đọc message từ Kafka |
| **Consumer Group** | Nhóm consumers cùng xử lý một topic song song |
| **Offset** | Vị trí của message trong partition — đơn vị theo dõi tiến độ đọc |
| **ZooKeeper / KRaft** | Quản lý metadata cluster (KRaft là mode mới không cần ZooKeeper) |

---

## Use Cases phổ biến

| Use Case | Ví dụ thực tế |
|----------|--------------|
| **Event Streaming** | Tracking user activity, clickstream analytics |
| **Messaging** | Thay thế ActiveMQ/RabbitMQ cho high-throughput scenarios |
| **Activity Tracking** | Audit logs, fraud detection |
| **Metrics Aggregation** | Thu thập metrics từ nhiều services, đẩy vào monitoring |
| **Log Aggregation** | Centralized logging từ nhiều services |
| **Stream Processing** | Real-time ETL, aggregations với Kafka Streams |
| **Event Sourcing** | Lưu trữ toàn bộ lịch sử thay đổi state |
| **CDC** | Change Data Capture — sync database changes real-time |

> [!TIP]
> Kafka phù hợp nhất khi cần throughput cao (hàng triệu messages/giây), low latency, và khả năng replay lại dữ liệu. Nếu chỉ cần message queue đơn giản với số lượng ít, RabbitMQ có thể là lựa chọn đơn giản hơn.

---

## Kafka trong hệ sinh thái

```d2 title="Kafka ecosystem"
grid-columns: 2
core: "Kafka Core\nMessaging"
streams: "Kafka Streams\nStream processing"
connect: "Kafka Connect\nConnectors"
schema: "Schema Registry\nData contracts"
sql: "ksqlDB\nSQL on Kafka"
rest: "Kafka REST Proxy\nHTTP interface"
```

**Tích hợp phổ biến:**
- **Spring Boot** — `spring-kafka` library, phổ biến nhất trong Java ecosystem
- **Apache Flink / Spark** — Big data processing từ Kafka streams
- **Elasticsearch** — Kafka Connect Elasticsearch Sink Connector
- **Debezium** — CDC connector, đọc binlog từ MySQL/PostgreSQL vào Kafka

<Cards>
  <Card title="Core Concepts" description="Topics, Partitions, Brokers, Offsets" href="/core-concepts/topics-partitions/" />
  <Card title="Setup môi trường" description="Cài đặt Kafka với Docker" href="/setup/docker-setup/" />
  <Card title="Producers & Consumers" description="API và cấu hình cơ bản" href="/producers-consumers/producer-api/" />
</Cards>
