---
title: "Producer API"
description: "Hướng dẫn sử dụng KafkaTemplate: các phương thức send, send patterns (fire-forget, callback, synchronous, headers), xử lý CompletableFuture"
---

# Producer API

## Mục lục

- [KafkaTemplate Quick Reference](#kafkatemplate-quick-reference)
- [Send Patterns](#send-patterns)
- [Xử lý kết quả với Callback](#xử-lý-kết-quả-với-callback)
- [Producer Events và Monitoring](#producer-events-và-monitoring)
- [Cấu hình nâng cao](#cấu-hình-nâng-cao)

---

## KafkaTemplate Quick Reference

`KafkaTemplate<K, V>` là core class để gửi messages trong Spring Kafka. Tất cả phương thức `send()` đều trả về `CompletableFuture<SendResult<K, V>>` — bất đồng bộ theo mặc định.

| Phương thức | Mô tả | Partition Selection |
|------------|-------|-------------------|
| `send(topic, value)` | Gửi chỉ value | Round-robin / Sticky |
| `send(topic, key, value)` | Gửi với key | `hash(key) % partitions` |
| `send(topic, partition, key, value)` | Gửi đến partition cụ thể | Explicit partition |
| `send(topic, partition, timestamp, key, value)` | Kiểm soát hoàn toàn | Explicit + custom timestamp |
| `send(ProducerRecord<K,V>)` | Record đầy đủ với headers | Như được định nghĩa trong record |
| `sendDefault(value)` | Gửi đến default topic | Round-robin |
| `sendDefault(key, value)` | Gửi đến default topic với key | `hash(key) % partitions` |

---

## Send Patterns

### Pattern 1: Fire and Forget (Nhanh, tiềm ẩn rủi ro)

```java
@Service
public class OrderProducer {

    private final KafkaTemplate<String, OrderEvent> kafkaTemplate;

    // Fire and forget — không biết thành công hay thất bại
    public void sendOrder(OrderEvent event) {
        // Gửi không quan tâm kết quả
        kafkaTemplate.send("orders", event.getOrderId(), event);
        // Nếu broker down → exception bị nuốt mất!
    }
}
```

> [!CAUTION]
> **Không khuyến nghị** cho dữ liệu quan trọng. Nếu broker tạm thời down, message có thể bị mất mà không có cảnh báo nào.

---

### Pattern 2: Callback (Khuyến nghị — tốt nhất cho hầu hết cases)

```java
public void sendOrderWithCallback(OrderEvent event) {
    CompletableFuture<SendResult<String, OrderEvent>> future =
        kafkaTemplate.send("orders", event.getOrderId(), event);

    future.whenComplete((result, ex) -> {
        if (ex == null) {
            // ✅ Thành công
            RecordMetadata metadata = result.getRecordMetadata();
            log.info("Message gửi thành công: topic={}, partition={}, offset={}",
                metadata.topic(),
                metadata.partition(),
                metadata.offset()
            );
        } else {
            // ❌ Thất bại — log, alert, retry...
            log.error("Không thể gửi message cho orderId={}: {}",
                event.getOrderId(), ex.getMessage());
            // Tùy yêu cầu: throw, retry, lưu vào outbox...
        }
    });
}
```

Hoặc tách thành method riêng rõ ràng hơn:

```java
public void sendOrderWithCallback(OrderEvent event) {
    kafkaTemplate.send("orders", event.getOrderId(), event)
        .thenAccept(result -> onSendSuccess(result, event))
        .exceptionally(ex -> { onSendFailure(ex, event); return null; });
}

private void onSendSuccess(SendResult<String, OrderEvent> result, OrderEvent event) {
    log.info("[Kafka] ✅ Order {} → partition={}, offset={}",
        event.getOrderId(),
        result.getRecordMetadata().partition(),
        result.getRecordMetadata().offset());
}

private void onSendFailure(Throwable ex, OrderEvent event) {
    log.error("[Kafka] ❌ Failed to send order {}: {}", event.getOrderId(), ex.getMessage());
    // Lưu vào retry queue hoặc database outbox
    failureHandler.handle(event, ex);
}
```

---

### Pattern 3: Synchronous (Chậm nhưng chắc chắn)

```java
public void sendOrderSync(OrderEvent event) throws ExecutionException, InterruptedException {
    try {
        SendResult<String, OrderEvent> result =
            kafkaTemplate.send("orders", event.getOrderId(), event)
                         .get(10, TimeUnit.SECONDS);  // Chờ tối đa 10 giây

        log.info("Confirmed at offset: {}", result.getRecordMetadata().offset());

    } catch (TimeoutException e) {
        log.error("Timeout khi gửi message — broker có thể đang down");
        throw new KafkaException("Send timeout", e);
    }
}
```

> [!CAUTION]
> **Synchronous send** chặn thread hiện tại. Trong web application, nếu gọi từ HTTP handler, thread Tomcat bị block đến khi Kafka commit xong. Chỉ dùng khi thực sự cần đảm bảo 100% message đã được nhận.

---

### Pattern 4: Gửi với Custom Headers

Headers hữu ích để truyền metadata mà không làm ô nhiễm message body (trace ID, correlation ID, event type, etc.):

```java
public void sendOrderWithHeaders(OrderEvent event, String traceId) {
    ProducerRecord<String, OrderEvent> record = new ProducerRecord<>(
        "orders",          // topic
        null,              // partition (null = auto)
        event.getOrderId(), // key
        event              // value
    );

    // Thêm headers
    record.headers().add("X-Trace-Id", traceId.getBytes(StandardCharsets.UTF_8));
    record.headers().add("X-Event-Type", "ORDER_CREATED".getBytes(StandardCharsets.UTF_8));
    record.headers().add("X-Source-Service", "order-service".getBytes(StandardCharsets.UTF_8));

    kafkaTemplate.send(record)
        .whenComplete((result, ex) -> {
            if (ex != null) log.error("Send failed", ex);
        });
}
```

---

### Pattern 5: Gửi đến Partition Cụ thể

```java
// Khi bạn biết chính xác partition muốn gửi
public void sendToSpecificPartition(OrderEvent event, int partition) {
    kafkaTemplate.send("orders", partition, event.getOrderId(), event);
}

// Ví dụ thực tế: VIP orders luôn đến partition riêng biệt
public void sendVipOrder(OrderEvent event) {
    int vipPartition = 0;  // Partition 0 reserved cho VIP
    if (event.isVip()) {
        kafkaTemplate.send("orders", vipPartition, event.getOrderId(), event);
    } else {
        kafkaTemplate.send("orders", event.getOrderId(), event);
    }
}
```

---

## Xử lý kết quả với Callback

### Tổng hợp các cách xử lý CompletableFuture

```java
CompletableFuture<SendResult<String, OrderEvent>> future =
    kafkaTemplate.send("orders", key, value);

// Cách 1: whenComplete (xử lý cả success và failure)
future.whenComplete((result, ex) -> { ... });

// Cách 2: thenAccept + exceptionally (tách biệt)
future.thenAccept(result -> { ... })
      .exceptionally(ex -> { ...; return null; });

// Cách 3: Blocking get (synchronous)
SendResult<String, OrderEvent> result = future.get(10, TimeUnit.SECONDS);

// Cách 4: handle (transform kết quả)
future.handle((result, ex) -> {
    if (ex != null) return "failed: " + ex.getMessage();
    return "offset: " + result.getRecordMetadata().offset();
});
```

### SendResult — Thông tin trả về sau khi send thành công

```java
future.thenAccept(result -> {
    RecordMetadata metadata = result.getRecordMetadata();

    // Kafka-assigned metadata
    String topic     = metadata.topic();          // "orders"
    int partition    = metadata.partition();       // 2
    long offset      = metadata.offset();          // 15234
    long timestamp   = metadata.timestamp();       // epoch millis

    // Producer record gốc
    ProducerRecord<String, OrderEvent> sentRecord = result.getProducerRecord();
});
```

---

## Producer Events và Monitoring

Spring Kafka publish events để theo dõi producer health:

```java
@Component
public class KafkaProducerMonitor implements ApplicationListener<ProducerEvent> {

    @Override
    public void onApplicationEvent(ProducerEvent event) {
        if (event instanceof ProducerStartedEvent e) {
            log.info("Producer started: clientId={}", e.getSource());
        }
    }
}
```

### Metrics quan trọng (Prometheus/Actuator)

| Metric | Mô tả | Alert khi |
|--------|-------|-----------|
| `kafka.producer.record.send.total` | Tổng records đã gửi | Dừng tăng đột ngột |
| `kafka.producer.record.error.total` | Tổng records lỗi | > 0 |
| `kafka.producer.record.send.rate` | Send rate (records/s) | Giảm đột ngột |
| `kafka.producer.request.latency.avg` | Latency trung bình | > threshold |
| `kafka.producer.buffer.available.bytes` | Buffer còn lại | Gần 0 |

---

## Cấu hình nâng cao

### Cấu hình Idempotent Producer (Production)

```yaml
spring:
  kafka:
    producer:
      acks: all
      retries: 2147483647
      properties:
        enable.idempotence: true
        max.in.flight.requests.per.connection: 5
```

### Custom ProducerFactory với nhiều cấu hình

```java
@Configuration
public class KafkaProducerConfig {

    @Bean
    public ProducerFactory<String, OrderEvent> orderProducerFactory() {
        Map<String, Object> configs = new HashMap<>();
        configs.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        configs.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        configs.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, JsonSerializer.class);
        configs.put(ProducerConfig.ACKS_CONFIG, "all");
        configs.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        configs.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "lz4");
        configs.put(ProducerConfig.BATCH_SIZE_CONFIG, 32768);
        configs.put(ProducerConfig.LINGER_MS_CONFIG, 10);
        return new DefaultKafkaProducerFactory<>(configs);
    }

    @Bean
    public KafkaTemplate<String, OrderEvent> orderKafkaTemplate() {
        return new KafkaTemplate<>(orderProducerFactory());
    }
}
```

<Cards>
  <Card title="Consumer API" href="/producers-consumers/consumer-api/" description="@KafkaListener, headers, concurrency scaling" />
  <Card title="Transactions" href="/producers-consumers/transactions/" description="Dual write problem, Outbox pattern, error handling" />
  <Card title="Exactly-Once" href="/producers-consumers/exactly-once/" description="EOS và idempotent producer internals" />
</Cards>
