---
title: "Quick Reference"
description: "Cheat sheet nhanh cho Kafka + Spring Boot: producer patterns, consumer patterns, key formulas, CLI commands, và configuration"
---

# Quick Reference

## Producer Patterns

```java
// Fire and forget (fast, risky)
kafkaTemplate.send("topic", value);

// With key (ordering per key)
kafkaTemplate.send("topic", key, value);

// With callback (recommended)
kafkaTemplate.send("topic", key, value)
    .whenComplete((result, ex) -> {
        if (ex == null) {
            log.info("Sent to partition {} offset {}",
                result.getRecordMetadata().partition(),
                result.getRecordMetadata().offset());
        } else {
            log.error("Send failed", ex);
        }
    });

// Synchronous (slow but certain)
kafkaTemplate.send("topic", key, value)
    .get(10, TimeUnit.SECONDS);

// With headers
ProducerRecord<String, String> record = new ProducerRecord<>("topic", key, value);
record.headers().add("correlation-id", "abc-123".getBytes());
record.headers().add("trace-id", MDC.get("traceId").getBytes());
kafkaTemplate.send(record);

// To specific partition
kafkaTemplate.send("topic", 2, key, value);
```

## Consumer Patterns

```java
// Simple
@KafkaListener(topics = "topic")
void listen(String msg) { }

// With metadata
@KafkaListener(topics = "topic")
void listen(
        @Payload String msg,
        @Header(KafkaHeaders.RECEIVED_PARTITION) int partition,
        @Header(KafkaHeaders.OFFSET) long offset,
        @Header(KafkaHeaders.RECEIVED_KEY) String key,
        @Header(KafkaHeaders.RECEIVED_TOPIC) String topic) { }

// Manual acknowledge
@KafkaListener(topics = "topic")
void listen(String msg, Acknowledgment ack) {
    process(msg);
    ack.acknowledge();
}

// Batch
@KafkaListener(topics = "topic")
void listen(List<String> messages) { }

// Batch with metadata
@KafkaListener(topics = "topic")
void listen(
        List<ConsumerRecord<String, String>> records,
        @Header(KafkaHeaders.RECEIVED_PARTITION) int partition) {
    for (ConsumerRecord<String, String> record : records) {
        process(record.value(), record.offset());
    }
}

// With retry + DLT
@RetryableTopic(attempts = "4", backoff = @Backoff(delay = 1000))
@KafkaListener(topics = "topic")
void listen(String msg) { }

@DltHandler
void handleDlt(String msg) { }
```

## KafkaTemplate Methods

| Method | Description | Partition Selection |
|--------|-------------|-------------------|
| `send(topic, value)` | Send value only | Round-robin / Sticky |
| `send(topic, key, value)` | Send with key | `hash(key) % partitions` |
| `send(topic, partition, key, value)` | Specific partition | Explicit |
| `send(topic, partition, timestamp, key, value)` | Full control | Explicit + timestamp |
| `send(ProducerRecord<K,V>)` | Complete record with headers | As specified |

## @KafkaListener Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `topics` | - | Topic names to subscribe |
| `groupId` | from config | Override consumer group ID |
| `concurrency` | `"1"` | Number of consumer threads |
| `containerFactory` | default | Custom container factory |
| `errorHandler` | - | Bean name for error handler |
| `topicPattern` | - | Regex pattern for topics |
| `autoStartup` | `"true"` | Start on app startup |
| `batchListener` | `"false"` | Receive List of records |

## Available Headers

| Header Constant | Type | Description |
|----------------|------|-------------|
| `RECEIVED_TOPIC` | String | Topic name |
| `RECEIVED_PARTITION` | int | Partition number |
| `OFFSET` | long | Message offset |
| `RECEIVED_KEY` | K | Message key |
| `RECEIVED_TIMESTAMP` | long | Message timestamp |
| `GROUP_ID` | String | Consumer group ID |
| `CORRELATION_ID` | byte[] | Correlation ID |
| `REPLY_TOPIC` | String | Reply topic (for request/reply) |

## Key Formulas

```
Consumer Lag         = Log End Offset - Current Offset
Max Active Consumers = min(Total Consumers, Total Partitions)
Partition Assignment = hash(key) % num_partitions
Coordinator Location = hash(group.id) % 50
```

## AckMode Comparison

| AckMode | When Committed | Throughput | Duplicate Risk |
|---------|---------------|-----------|----------------|
| `RECORD` | After each record | Low | Minimal |
| `BATCH` | After poll() batch | High | Moderate |
| `MANUAL` | When you call ack | Custom | You control |
| `MANUAL_IMMEDIATE` | Immediately on ack | Custom | Minimal |

## Producer Configuration (Production)

```yaml
spring.kafka.producer:
  acks: all
  retries: 2147483647
  batch-size: 32768
  linger-ms: 10
  compression-type: lz4
  buffer-memory: 67108864
  properties:
    enable.idempotence: true
    max.in.flight.requests.per.connection: 5
    delivery.timeout.ms: 120000
```

## Consumer Configuration (Production)

```yaml
spring.kafka.consumer:
  group-id: ${spring.application.name}
  auto-offset-reset: earliest
  enable-auto-commit: false
  max-poll-records: 200
  properties:
    max.poll.interval.ms: 300000
    session.timeout.ms: 45000
    heartbeat.interval.ms: 15000
    isolation.level: read_committed
```

## CLI Commands

```bash
# List topics
kafka-topics.sh --bootstrap-server localhost:9092 --list

# Create topic
kafka-topics.sh --bootstrap-server localhost:9092 --create \
    --topic orders --partitions 12 --replication-factor 3

# Describe topic
kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic orders

# List consumer groups
kafka-consumer-groups.sh --bootstrap-server localhost:9092 --list

# Describe consumer group (lag, offsets)
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
    --describe --group order-group

# Reset offset to earliest
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
    --group order-group --reset-offsets --to-earliest \
    --topic orders --execute

# Reset offset to datetime
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
    --group order-group --reset-offsets \
    --to-datetime 2024-01-15T10:00:00.000 \
    --topic orders --execute

# Console producer
kafka-console-producer.sh --bootstrap-server localhost:9092 --topic orders

# Console consumer
kafka-console-consumer.sh --bootstrap-server localhost:9092 \
    --topic orders --from-beginning --group test-group
```

## Delivery Guarantees

| Guarantee | Description | How |
|-----------|-------------|-----|
| **At-Most-Once** | Có thể mất message | Commit offset trước khi process |
| **At-Least-Once** | Có thể duplicate | Commit offset sau khi process |
| **Exactly-Once** | Không mất, không duplicate | Idempotent producer + transactions |

## When to Use What

| Need | Solution |
|------|----------|
| Ordering per entity | Dùng cùng key (entityId) |
| Maximum throughput | Không dùng key (round-robin) |
| Hot partition | Key salting hoặc custom partitioner |
| Exactly-once Kafka-to-Kafka | Transactions + idempotence |
| Exactly-once Kafka-to-DB | Outbox pattern hoặc idempotent consumer |
| Retry transient errors | `@RetryableTopic` |
| Handle bad messages | DLT + `@DltHandler` |
| Monitor consumer lag | Prometheus + Grafana |
| Test Kafka code | `@EmbeddedKafka` |

## Serializer Comparison

| Format | Serializer | Best For |
|--------|-----------|---------|
| **String** | `StringSerializer` | Logs, simple events |
| **JSON** | `JsonSerializer` | Most applications |
| **Avro** | `KafkaAvroSerializer` | Schema evolution, enterprise |
| **Protobuf** | `KafkaProtobufSerializer` | High performance |
| **Bytes** | `ByteArraySerializer` | Custom binary |

<Cards>
  <Card title="Spring Boot Setup" href="/setup/spring-boot/" description="Dependencies, configuration, JSON serialization" />
  <Card title="Producer API" href="/producers-consumers/producer-api/" description="KafkaTemplate, send patterns, callbacks" />
  <Card title="Consumer API" href="/producers-consumers/consumer-api/" description="@KafkaListener, headers, concurrency" />
  <Card title="Production Checklist" href="/operations/production-checklist/" description="Go-live checklist, common issues" />
</Cards>
