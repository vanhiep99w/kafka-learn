---
title: "Kafka Streams: Tổng quan"
description: "Kafka Streams là gì, khi nào dùng, so sánh với Kafka Consumer thông thường và các frameworks streaming khác. Kiến trúc Stream Processing, topology, và core abstractions"
---

# Kafka Streams: Tổng quan

## Mục lục

- [Kafka Streams là gì?](#kafka-streams-là-gì)
- [Kafka Streams vs @KafkaListener](#kafka-streams-vs-kafkalistener)
- [Kafka Streams vs Apache Flink / Spark](#kafka-streams-vs-apache-flink--spark)
- [Core Abstractions: KStream và KTable](#core-abstractions-kstream-và-ktable)
- [Stream Processing Topology](#stream-processing-topology)
- [State Management](#state-management)
- [Khi nào dùng Kafka Streams](#khi-nào-dùng-kafka-streams)
- [Setup trong Spring Boot](#setup-trong-spring-boot)

---

## Kafka Streams là gì?

**Kafka Streams** là một **client library** (không phải cluster riêng) cho phép bạn xây dựng ứng dụng xử lý dữ liệu streaming trực tiếp trong JVM application của mình.

```d2 title="Consumer application và Kafka Streams"
direction: right
traditional: "Kafka consumer truyền thống" {source: Kafka source; app: Your App — process; sink: Database / API; source -> app: poll(); app -> sink: Write}
streams: "Kafka Streams" {
  input: Input topics
  app: Kafka Streams App {topology: "filter → map → groupBy → aggregate"; state: "Built-in: RocksDB state stores\nWindowing / Joins"}
  output: Output topics
  input -> app: Read
  app -> output: Write
}
note: "Kafka Streams: input và output đều là Kafka topics"
```

**3 đặc điểm cốt lõi:**

1. **Embedded library** — không cần cluster riêng (khác Flink/Spark). Deploy như regular Spring Boot app
2. **Kafka-to-Kafka** — đọc từ Kafka topic, xử lý, ghi ra Kafka topic khác
3. **Stateful processing** — tích hợp sẵn state store (RocksDB) để lưu aggregations, joins

---

## Kafka Streams vs @KafkaListener

| Tiêu chí | `@KafkaListener` | Kafka Streams |
|---------|-----------------|---------------|
| **Pattern** | Kafka → App → Database/API | Kafka → Transform → Kafka |
| **Stateless** | ✅ Dễ — mỗi message độc lập | ⚠️ Cần suy nghĩ về state |
| **Stateful** | ❌ Tự quản lý (Redis, DB) | ✅ Built-in State Store |
| **Windowing** | ❌ Tự implement | ✅ Tumbling, Hopping, Session |
| **Stream joins** | ❌ Phức tạp | ✅ KStream-KStream, KStream-KTable |
| **Exactly-once** | ⚠️ Complex setup | ✅ Built-in với processing.guarantee |
| **Complexity** | ✅ Thấp | ⚠️ Cao hơn |
| **Use case** | DB writes, API calls, notifications | ETL, aggregations, real-time analytics |

> [!TIP]
> **Rule of thumb**: Nếu output đến Database hoặc external service → `@KafkaListener`. Nếu cần transform/aggregate và output ngược lại Kafka hoặc cần real-time analytics → Kafka Streams.

---

## Kafka Streams vs Apache Flink / Spark

| Tiêu chí | Kafka Streams | Apache Flink | Spark Streaming |
|---------|---------------|-------------|----------------|
| **Deployment** | ✅ Embedded trong app | ❌ Cluster riêng | ❌ Cluster riêng |
| **Language** | Java/Kotlin | Java/Scala/Python | Python/Scala/Java |
| **Source/Sink** | Kafka only | Any (Kafka, DB, S3...) | Any |
| **Throughput** | ⚠️ Medium | ✅ Very high | ✅ High |
| **Latency** | ✅ Very low (ms) | ✅ Low (ms) | ⚠️ Seconds (micro-batch) |
| **State mgmt** | ✅ RocksDB built-in | ✅ Advanced | ✅ Advanced |
| **Ops complexity** | ✅ Low (just a jar) | ❌ High | ❌ High |
| **When to use** | Kafka-native apps | Complex stream processing | Batch + stream hybrid |

---

## Core Abstractions: KStream và KTable

### KStream — Unbounded Event Stream

**KStream** đại diện cho **stream of events** — mỗi record là một sự kiện độc lập, giống append-only log.

```d2 title="KStream giữ từng event độc lập"
direction: right
stream: "KStream<String, OrderEvent>" {
  a: "order-1: \$100"; b: "order-2: \$50"; c: "order-1: CANCEL"; d: "order-3: \$200"
  a -> b -> c -> d: Event time
}
note: "Record mới không overwrite event cũ\nDùng cho transaction logs, click events, sensor readings"
```

### KTable — Changelog Stream (Materialized View)

**KTable** đại diện cho **current state** — chỉ giữ giá trị mới nhất per key (như database table).

```d2 title="KTable biểu diễn giá trị mới nhất theo key"
direction: right
a: "user-1: profile-v1"
b: "user-1: profile-v2"
c: "user-1: profile-v3\nTrạng thái hiện tại"
a -> b -> c: Update cùng key
note: "Dùng cho user profile, account balance, configuration"
```

### KStream vs KTable: Semantic khác nhau

```d2 title="KStream vs KTable: Semantic khác nhau"
direction: down
g1: "KStream (All events matter)" {
  S1: "user-1: \$10"
  S2: "user-1: \$20"
  S3: "user-1: \$5"
  Note1: "Total spending: \$35\n3 purchases"
}
g2: "KTable (Only latest matters)" {
  T1: "user-1: balance=\$100"
  T2: "user-1: balance=\$80"
  T3: "user-1: balance=\$90"
  Note2: "Current balance: \$90\n(Previous values discarded)"
}
g1.S1 -> g1.S2
g1.S2 -> g1.S3
g2.T1 -> g2.T2
g2.T2 -> g2.T3
```

### GlobalKTable — Replicated State

```java
// KTable: partitioned (each instance has subset of keys)
KTable<String, Product> productTable = builder.table("products");

// GlobalKTable: fully replicated on EVERY instance
// Use when: lookup table, config, reference data
GlobalKTable<String, Product> globalProducts = builder.globalTable("products");
```

---

## Stream Processing Topology

Mỗi Kafka Streams app định nghĩa một **topology** — directed acyclic graph (DAG) của operations:

```d2 title="Stream Processing Topology"
direction: right
g1: "Example Topology: Order Revenue Calculator" {
  A: "Source\norders topic"
  B: "filter\n(only COMPLETED)"
  C: "map\n(extract revenue)"
  D: "groupByKey\n(by customerId)"
  E: "aggregate\n(sum revenue)"
  F: "Sink\ncustomer-revenue topic"
}
g1.A -> g1.B
g1.B -> g1.C
g1.C -> g1.D
g1.D -> g1.E
g1.E -> g1.F
```

**Loại nodes trong topology:**

| Node Type | Role | Ví dụ |
|-----------|------|-------|
| **Source** | Đọc từ Kafka topic | `builder.stream("orders")` |
| **Processor** | Transform/filter records | `filter()`, `map()`, `flatMap()` |
| **Stateful** | Aggregate, join với state | `groupByKey().count()`, `join()` |
| **Sink** | Ghi ra Kafka topic | `.to("output-topic")` |

---

## State Management

Kafka Streams tự động quản lý **State Stores** (dùng RocksDB locally + changelog topic trên Kafka):

```d2 title="Local state store được khôi phục từ changelog"
direction: down
instance: Kafka Streams Instance {
  logic: "Processing logic\ngroupBy(customerId).count()"
  store: "Local RocksDB state store\ncustomer-1 → 42 orders\ncustomer-2 → 7 orders\ncustomer-3 → 108 orders" {shape: cylinder}
  logic -> store: Read / write
}
changelog: "Kafka changelog topic\nstores-order-count-changelog"
instance.store -> changelog: Backup state
changelog -> instance.store: Restore khi restart
note: "Local reads sub-millisecond trong ví dụ\nDurable nhờ Kafka; auto-restore sau crash"
```

---

## Khi nào dùng Kafka Streams

```d2 title="Khi nào dùng Kafka Streams"
direction: down
A: "Cần xử lý Kafka messages?"
B: "Output đến đâu?" { shape: diamond }
C: "@KafkaListener\nSimpler, direct"
D: "Cần stateful processing?" { shape: diamond }
E: "Nhiều logic phức tạp?" { shape: diamond }
F: "✅ Kafka Streams\nState Store"
G: "@KafkaListener\n+ manual produce"
H: "✅ Kafka Streams\nTopology DSL"
I: "Scale > 100K msg/s\nhoặc complex joins?" { shape: diamond }
J: "Consider Flink\nfor higher scale"
A -> B
B -> C: "Database hoặc API"
B -> D: "Kafka topic khác"
D -> E: "Không - simple transform"
D -> F: "Có - aggregation, join, count"
E -> G: "Không"
E -> H: "Có - ETL pipeline"
F -> I
I -> J: "Có"
I -> F: "Không"
```

**Use cases phù hợp nhất:**

| Use Case | Dùng Kafka Streams? | Lý do |
|---------|--------------------|----|
| Real-time fraud detection | ✅ | Windowing + stateful pattern matching |
| Order count per customer (hourly) | ✅ | Tumbling window aggregation |
| Enrich order with customer data | ✅ | KStream-KTable join |
| Send confirmation email | ❌ | `@KafkaListener` đơn giản hơn |
| Save order to database | ❌ | `@KafkaListener` đơn giản hơn |
| Complex ML pipeline | ❌ | Flink/Spark phù hợp hơn |

---

## Setup trong Spring Boot

### Dependencies

```xml
<!-- pom.xml -->
<dependency>
    <groupId>org.apache.kafka</groupId>
    <artifactId>kafka-streams</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.kafka</groupId>
    <artifactId>spring-kafka</artifactId>
</dependency>
```

### application.yml

```yaml
spring:
  kafka:
    bootstrap-servers: localhost:9092
    streams:
      application-id: order-analytics-app   # Unique ID — acts as consumer group ID
      properties:
        default.key.serde: org.apache.kafka.common.serialization.Serdes$StringSerde
        default.value.serde: org.apache.kafka.common.serialization.Serdes$StringSerde

        # Exactly-once processing
        processing.guarantee: exactly_once_v2

        # State store directory
        state.dir: /tmp/kafka-streams

        # Auto-create internal topics
        num.stream.threads: 2   # Parallelism per instance
```

### Kích hoạt Kafka Streams

```java
@SpringBootApplication
@EnableKafkaStreams          // ← Bắt buộc
public class OrderAnalyticsApplication {
    public static void main(String[] args) {
        SpringApplication.run(OrderAnalyticsApplication.class, args);
    }
}
```

<Cards>
  <Card title="Kafka Streams API" href="/streams/streams-api/" description="DSL operators: filter, map, groupByKey, windowing, joins với code examples" />
  <Card title="Transactions" href="/producers-consumers/transactions/" description="Consume-Transform-Produce EOS pattern" />
  <Card title="Kafka vs Others" href="/fundamentals/kafka-vs-others/" description="Khi nào dùng Kafka Streams vs Flink vs Spark" />
</Cards>
