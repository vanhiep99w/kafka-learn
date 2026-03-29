---
title: "Consumer API"
description: "@KafkaListener deep dive: annotation parameters, headers injection, manual acknowledge, batch processing và concurrency scaling trong Spring Boot"
---

# Consumer API

## Mục lục

- [@KafkaListener Parameters](#kafkalistener-parameters)
- [Progression: Simple → Advanced](#progression-simple--advanced)
- [Available Headers](#available-headers)
- [Concurrency & Scaling](#concurrency--scaling)
- [Manual Acknowledge](#manual-acknowledge)
- [Batch Consumption](#batch-consumption)
- [Error Handling trong Consumer](#error-handling-trong-consumer)
- [Consumer Configuration](#consumer-configuration)

---

## @KafkaListener Parameters

`@KafkaListener` là annotation trung tâm để định nghĩa consumer trong Spring Boot. Đây là reference đầy đủ các parameter:

| Parameter | Type | Default | Mô tả |
|-----------|------|---------|-------|
| `topics` | `String[]` | — | Tên topics cần subscribe |
| `groupId` | `String` | từ config | Override consumer group ID |
| `concurrency` | `String` | `"1"` | Số consumer threads |
| `containerFactory` | `String` | default | Tên bean custom container factory |
| `errorHandler` | `String` | — | Tên bean error handler |
| `topicPattern` | `String` | — | Regex pattern để subscribe theo topic name |
| `autoStartup` | `String` | `"true"` | Tự động start khi app khởi động |
| `properties` | `String[]` | — | Additional consumer properties |
| `id` | `String` | — | Unique ID cho listener (dùng với registry) |
| `filter` | `String` | — | Bean name của `RecordFilterStrategy` |

---

## Progression: Simple → Advanced

### Bước 1: Simple Listener

```java
@Service
public class OrderConsumer {

    @KafkaListener(topics = "orders", groupId = "order-group")
    public void listen(String message) {
        System.out.println("Received: " + message);
        // Process message...
    }
}
```

---

### Bước 2: Typed Payload (JSON Object)

```java
@KafkaListener(topics = "orders", groupId = "order-group")
public void handleOrder(@Payload OrderEvent event) {
    log.info("Processing order: {}", event.getOrderId());
    orderService.process(event);
}
```

---

### Bước 3: Với Headers và Metadata

```java
@KafkaListener(topics = "orders", groupId = "order-group")
public void listenWithMetadata(
        @Payload OrderEvent event,
        @Header(KafkaHeaders.RECEIVED_TOPIC) String topic,
        @Header(KafkaHeaders.RECEIVED_PARTITION) int partition,
        @Header(KafkaHeaders.OFFSET) long offset,
        @Header(KafkaHeaders.RECEIVED_TIMESTAMP) long timestamp,
        @Header(value = "X-Trace-Id", required = false) String traceId) {

    log.info("[Kafka] Received from topic={}, partition={}, offset={}, traceId={}",
        topic, partition, offset, traceId);

    orderService.process(event);
}
```

---

### Bước 4: ConsumerRecord (Full Access)

```java
@KafkaListener(topics = "orders", groupId = "order-group")
public void listenFull(ConsumerRecord<String, OrderEvent> record) {
    String key       = record.key();
    OrderEvent value = record.value();
    int partition    = record.partition();
    long offset      = record.offset();
    long timestamp   = record.timestamp();

    // Access custom headers
    Header traceIdHeader = record.headers().lastHeader("X-Trace-Id");
    if (traceIdHeader != null) {
        String traceId = new String(traceIdHeader.value(), StandardCharsets.UTF_8);
        MDC.put("traceId", traceId);
    }

    log.info("key={}, partition={}, offset={}", key, partition, offset);
    orderService.process(value);
}
```

---

### Bước 5: Manual Acknowledge (Full Control)

```java
@KafkaListener(topics = "orders", groupId = "order-group")
public void listenManualAck(
        @Payload OrderEvent event,
        Acknowledgment ack) {

    try {
        // Chỉ acknowledge sau khi xử lý thành công
        orderService.process(event);
        ack.acknowledge();
        log.info("✅ Processed and acknowledged: {}", event.getOrderId());

    } catch (TransientException e) {
        // Không acknowledge → message sẽ được retry (sau rebalance hoặc restart)
        log.warn("⚠️ Transient error, not acknowledging: {}", e.getMessage());
        throw e;  // trigger error handler

    } catch (PermanentException e) {
        // Lỗi permanent → acknowledge để không block, gửi đến DLT
        log.error("❌ Permanent error, sending to DLT: {}", e.getMessage());
        deadLetterService.send(event, e);
        ack.acknowledge();  // Acknowledge để tiếp tục processing
    }
}
```

---

## Available Headers

### Spring Kafka Built-in Headers

Tất cả từ class `KafkaHeaders`:

| Header Constant | Type | Giá trị ví dụ | Mô tả |
|----------------|------|--------------|-------|
| `RECEIVED_TOPIC` | `String` | `"orders"` | Tên topic nhận được |
| `RECEIVED_PARTITION` | `Integer` | `2` | Số partition |
| `OFFSET` | `Long` | `15234` | Offset của message |
| `RECEIVED_KEY` | `K` | `"order-123"` | Message key |
| `RECEIVED_TIMESTAMP` | `Long` | `1704067200000` | Timestamp (ms) |
| `TIMESTAMP_TYPE` | `TimestampType` | `CREATE_TIME` | Kiểu timestamp |
| `GROUP_ID` | `String` | `"order-group"` | Consumer group ID |
| `CORRELATION_ID` | `byte[]` | — | Correlation ID nếu có |
| `REPLY_TOPIC` | `byte[]` | — | Reply topic (request/reply) |

### Custom Headers (Producer tự định nghĩa)

```java
// Đọc custom header trong consumer
@KafkaListener(topics = "orders")
public void listen(
        OrderEvent event,
        @Header(value = "X-Trace-Id", required = false) String traceId,
        @Header(value = "X-Event-Type", required = false) String eventType) {

    MDC.put("traceId", traceId != null ? traceId : "unknown");
    log.info("Event type: {}", eventType);
    orderService.process(event);
}
```

---

## Concurrency & Scaling

### Nguyên tắc cơ bản

`concurrency` trong `@KafkaListener` = số consumer threads trong **một application instance**.

```
Active Threads = min(Total Threads, Total Partitions)
```

Threads vượt quá partition count sẽ **idle** (không xử lý gì).

### Cấu hình Concurrency

```java
// Cách 1: Inline annotation
@KafkaListener(
    topics = "orders",
    groupId = "order-group",
    concurrency = "4"  // 4 threads = 4 partitions per instance
)
public void listenParallel(OrderEvent event) { ... }

// Cách 2: Từ properties (khuyến nghị — dễ thay đổi per environment)
@KafkaListener(
    topics = "orders",
    groupId = "order-group",
    concurrency = "${kafka.consumer.concurrency:4}"
)
public void listenParallel(OrderEvent event) { ... }
```

### Scaling Scenarios

| Partitions | App Instances | Concurrency/Instance | Total Threads | Active | Idle | Nhận xét |
|-----------|--------------|---------------------|--------------|-------|------|---------|
| 4 | 1 | 2 | 2 | 2 | 0 | ✅ Under-utilized, có thể tăng |
| 4 | 1 | 4 | 4 | 4 | 0 | ✅ **Optimal — 1 thread/partition** |
| 4 | 1 | 6 | 6 | 4 | 2 | ⚠️ 2 threads idle, lãng phí |
| 4 | 2 | 2 | 4 | 4 | 0 | ✅ **Optimal — distributed** |
| 4 | 2 | 4 | 8 | 4 | 4 | ⚠️ 4 threads idle, lãng phí |
| 12 | 3 | 4 | 12 | 12 | 0 | ✅ **Optimal — 4 partition/instance** |

> [!TIP]
> **Công thức tối ưu:**
> ```
> Concurrency per instance = Total Partitions / App Instances
> ```
> Ví dụ: 12 partitions, 3 instances → `concurrency = "4"` per instance

### Dynamic Concurrency Adjustment

```java
@Autowired
private KafkaListenerEndpointRegistry registry;

// Tăng concurrency khi traffic cao
public void scaleUp(int newConcurrency) {
    ConcurrentMessageListenerContainer<?, ?> container =
        (ConcurrentMessageListenerContainer<?, ?>) registry.getListenerContainer("order-listener");
    container.setConcurrency(newConcurrency);
    container.start();
}
```

---

## Manual Acknowledge

Để dùng Manual Acknowledge, cần cấu hình AckMode trước:

```java
@Bean
public ConcurrentKafkaListenerContainerFactory<String, OrderEvent> kafkaListenerContainerFactory(
        ConsumerFactory<String, OrderEvent> consumerFactory) {

    var factory = new ConcurrentKafkaListenerContainerFactory<String, OrderEvent>();
    factory.setConsumerFactory(consumerFactory);
    factory.getContainerProperties()
           .setAckMode(ContainerProperties.AckMode.MANUAL_IMMEDIATE);
    return factory;
}
```

```java
@KafkaListener(topics = "orders", groupId = "order-group")
public void listen(OrderEvent event, Acknowledgment ack) {
    try {
        // Xử lý message
        orderService.process(event);

        // ✅ Chỉ commit offset khi thành công
        ack.acknowledge();

    } catch (Exception e) {
        // ❌ Không acknowledge → sẽ retry khi consumer restart
        log.error("Processing failed, will retry: {}", e.getMessage());
        throw e;
    }
}
```

---

## Batch Consumption

Thay vì xử lý từng message, có thể xử lý cả batch (hiệu quả hơn cho bulk operations):

```java
// Bật batch mode trong factory
@Bean
public ConcurrentKafkaListenerContainerFactory<String, OrderEvent> batchFactory(
        ConsumerFactory<String, OrderEvent> consumerFactory) {

    var factory = new ConcurrentKafkaListenerContainerFactory<String, OrderEvent>();
    factory.setConsumerFactory(consumerFactory);
    factory.setBatchListener(true);  // ← Bật batch mode
    return factory;
}

// Nhận List thay vì đơn lẻ
@KafkaListener(
    topics = "orders",
    groupId = "order-group",
    containerFactory = "batchFactory"
)
public void listenBatch(
        List<OrderEvent> events,
        @Header(KafkaHeaders.OFFSET) List<Long> offsets) {

    log.info("Processing batch of {} events", events.size());

    // Bulk insert vào database (hiệu quả hơn nhiều)
    orderRepository.saveAll(events.stream()
        .map(this::toEntity)
        .collect(Collectors.toList()));

    log.info("Batch processed, offsets: {}", offsets);
}
```

**Batch với Acknowledgment:**

```java
@KafkaListener(topics = "orders", containerFactory = "batchFactory")
public void listenBatchManualAck(
        List<OrderEvent> events,
        Acknowledgment ack) {

    try {
        bulkProcessEfficently(events);
        ack.acknowledge();  // Commit toàn bộ batch cùng lúc
    } catch (Exception e) {
        log.error("Batch failed at batch of {} events", events.size(), e);
        // Không acknowledge → retry toàn bộ batch
        throw e;
    }
}
```

---

## Error Handling trong Consumer

### DefaultErrorHandler + DeadLetterPublishingRecoverer

```java
@Bean
public CommonErrorHandler errorHandler(KafkaTemplate<Object, Object> template) {
    // Retry 3 lần với khoảng cách 1 giây
    // Nếu vẫn fail → gửi đến DLT
    DefaultErrorHandler handler = new DefaultErrorHandler(
        new DeadLetterPublishingRecoverer(template),
        new FixedBackOff(1000L, 3)
    );

    // Không retry với errors này (permanent failures)
    handler.addNotRetryableExceptions(
        DeserializationException.class,
        MessageConversionException.class,
        IllegalArgumentException.class
    );

    return handler;
}
```

### Xử lý DLT

```java
@KafkaListener(topics = "orders.DLT", groupId = "dlt-processor")
public void handleDlt(
        @Payload OrderEvent event,
        @Header(KafkaHeaders.DLT_ORIGINAL_TOPIC) String originalTopic,
        @Header(KafkaHeaders.DLT_ORIGINAL_OFFSET) long originalOffset,
        @Header(KafkaHeaders.DLT_EXCEPTION_MESSAGE) String errorMessage) {

    log.error("DLT received — originalTopic={}, offset={}, error={}",
        originalTopic, originalOffset, errorMessage);

    // Tùy chọn:
    // 1. Lưu vào database để manual investigation
    // 2. Alert ops team
    // 3. Retry với logic khác
    dltRepository.save(new DltRecord(event, originalTopic, originalOffset, errorMessage));
    alertService.notifyOps("DLT message received", event, errorMessage);
}
```

---

## Consumer Configuration

```yaml
spring:
  kafka:
    consumer:
      group-id: order-service
      auto-offset-reset: earliest        # earliest | latest | none
      enable-auto-commit: false          # Tắt auto-commit — dùng manual
      max-poll-records: 100              # Số records tối đa mỗi poll()
      properties:
        max.poll.interval.ms: 300000     # 5 phút — thời gian tối đa xử lý 1 batch
        session.timeout.ms: 45000        # 45s — timeout consumer heartbeat
        heartbeat.interval.ms: 15000     # 15s = 1/3 session.timeout
        isolation.level: read_committed  # Dùng khi có transactions
```

> [!NOTE]
> **Điều chỉnh max.poll.records:**
> Nếu processing 1 record mất 50ms → mỗi batch 100 records mất 5s.
> `max.poll.interval.ms` cần > 5s. Với buffer an toàn: đặt `max.poll.interval.ms = 60000` (1 phút).

<Cards>
  <Card title="Producer API" href="/producers-consumers/producer-api/" description="KafkaTemplate methods, send patterns, callbacks" />
  <Card title="Serialization" href="/producers-consumers/serialization/" description="String, JSON, Avro, Protobuf comparison" />
  <Card title="Non-Blocking Retries" href="/producers-consumers/retry-dlt/" description="@RetryableTopic, exponential backoff, DLT patterns" />
</Cards>
