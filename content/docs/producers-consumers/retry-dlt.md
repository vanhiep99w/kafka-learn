---
title: "Retry & Dead Letter Topic"
description: "Non-blocking retries với Spring Kafka: @RetryableTopic, exponential backoff, DLT patterns, và khi nào nên retry vs fail fast — giải quyết Poison Pill Problem"
---

# Retry & Dead Letter Topic (DLT)

## Mục lục

- [The Poison Pill Problem](#the-poison-pill-problem)
- [Blocking Retry (Default — Nguy hiểm)](#blocking-retry-default--nguy-hiểm)
- [Non-Blocking Retries: Retry Topics](#non-blocking-retries-retry-topics)
- [@RetryableTopic: Annotation-based Config](#retryabletopic-annotation-based-config)
- [Retry Topology: Cách hoạt động](#retry-topology-cách-hoạt-động)
- [Dead Letter Topic (DLT)](#dead-letter-topic-dlt)
- [Phân loại Retryable vs Non-Retryable Errors](#phân-loại-retryable-vs-non-retryable-errors)
- [DLT Processing Patterns](#dlt-processing-patterns)
- [Production Configuration](#production-configuration)

---

## The Poison Pill Problem

**Poison Pill** là message mà consumer không thể xử lý được — ném exception mỗi lần thử. Không có strategy, nó sẽ **block toàn bộ partition**.

```d2 title="Poison pill chặn một partition"
direction: right
m1: msg 1 — OK
m2: msg 2 — POISON
waiting: "msg 3, 4, 5\nĐang chờ"
m1 -> m2: Consumer xử lý
m2 -> m2: Exception → retry → exception
m2 -> waiting: Bị chặn khi chưa xử lý xong {style.stroke-dash: 4}
impact: "Lag tăng\nService stuck / unhealthy\nMột bad message có thể chặn cả partition"
waiting -> impact
```

---

## Blocking Retry (Default — Nguy hiểm)

Default behavior của Spring Kafka khi dùng `DefaultErrorHandler` với `FixedBackOff`:

```d2 title="Blocking Retry (Default — Nguy hiểm)"
direction: right
g1: "Blocking Retry (problematic)" {
  P0: "Partition 0"
  M1: "msg 1 ✅"
  M2: "msg 2 💥 FAIL"
  DLT: "→ DLT"
  M3: "msg 3 ⏳ BLOCKED\n(waited 3+ seconds!)"
}
g1.P0 -> g1.M1
g1.M1 -> g1.M2
g1.M2 -> g1.M2: "Wait 1s, retry"
g1.M2 -> g1.M2: "Wait 1s, retry"
g1.M2 -> g1.M2: "Wait 1s, retry"
g1.M2 -> g1.DLT
g1.M2 -> g1.M3
```

**Vấn đề**: Trong thời gian retry msg 2 (3s), msg 3, 4, 5 bị chặn. Với nhiều messages poison, delay tích lũy cực lớn.

---

## Non-Blocking Retries: Retry Topics

**Giải pháp**: Thay vì retry tại chỗ, chuyển message sang **secondary retry topic**. Main partition tiếp tục xử lý các messages khác!

```d2 title="Non-Blocking Retries: Retry Topics"
direction: right
g1: "Non-Blocking Retry (solution)" {
  P0: "orders"
  M1: "msg 1 ✅"
  M2: "msg 2 💥 FAIL"
  RT0: "orders-retry-0\n(wait 1s)"
  M3: "msg 3 ✅ NOT BLOCKED!"
  M4: "msg 4 ✅"
  R2A: "msg 2 💥 FAIL"
  RT1: "orders-retry-1\n(wait 2s)"
  R2B: "msg 2 💥 FAIL"
  DLT: "orders-dlt\n🚨 Dead Letter"
}
g1.P0 -> g1.M1
g1.M1 -> g1.M2
g1.M2 -> g1.RT0: "Move to retry"
g1.M1 -> g1.M3
g1.M3 -> g1.M4
g1.RT0 -> g1.R2A: "Retry after 1s"
g1.R2A -> g1.RT1: "Move to retry"
g1.RT1 -> g1.R2B: "Retry after 2s"
g1.R2B -> g1.DLT: "All retries exhausted"
```

**Key insight**: Main topic tiếp tục chạy. Message hỏng bị "parked" trong retry topics cho đến khi hết attempts hoặc thành công.

---

## @RetryableTopic: Annotation-based Config

Cách đơn giản nhất để cấu hình non-blocking retries:

```java
@Service
@Slf4j
public class OrderConsumer {

    @RetryableTopic(
        attempts = "4",                           // 1 original + 3 retries
        backoff = @Backoff(
            delay = 1000,                         // 1s initial delay
            multiplier = 2.0,                     // Exponential backoff
            maxDelay = 10000                      // Max 10s between retries
        ),
        autoCreateTopics = "true",                // Auto-create retry/DLT topics
        topicSuffixingStrategy = TopicSuffixingStrategy.SUFFIX_WITH_INDEX_VALUE,
        // Only retry on these exceptions:
        include = {TransientServiceException.class, DatabaseConnectionException.class},
        // Never retry these (fail fast → DLT):
        exclude = {InvalidMessageException.class, ValidationException.class}
    )
    @KafkaListener(topics = "orders", groupId = "order-group")
    public void processOrder(
            @Payload String order,
            @Header(KafkaHeaders.RECEIVED_TOPIC) String topic) {

        log.info("Processing from topic: {}, message: {}", topic, order);
        orderService.process(order);
    }

    @DltHandler
    public void handleDlt(
            String order,
            @Header(KafkaHeaders.RECEIVED_TOPIC) String topic,
            @Header(KafkaHeaders.EXCEPTION_MESSAGE) String exceptionMessage) {

        log.error("Message failed all retries. Topic: {}, Error: {}", topic, exceptionMessage);

        // Options:
        // 1. Alert ops team
        alertService.sendAlert("DLT message received", order, exceptionMessage);
        // 2. Store in DB for manual review
        failedMessageRepo.save(new FailedMessage(order, exceptionMessage));
        // 3. Send Slack/PagerDuty notification
    }
}
```

### Bean-based Configuration (more control)

```java
@Configuration
@EnableKafka
public class KafkaRetryConfig {

    @Bean
    public RetryTopicConfiguration orderRetryTopicConfig(
            KafkaTemplate<String, String> template) {

        return RetryTopicConfigurationBuilder
            .newInstance()
            // Attempt schedule: attempt 1 immediately, retry 1 after 1s, retry 2 after 5s, retry 3 after 30s
            .exponentialBackoff(1_000, 2, 30_000)
            .maxAttempts(4)
            .includeTopic("orders")
            // Không retry validation errors
            .doNotRetryOn(ValidationException.class, JsonParseException.class)
            // Custom DLT processing bean
            .dltHandlerMethod("orderDltConsumer", "handle")
            .create(template);
    }
}
```

---

## Retry Topology: Cách hoạt động

### Topics được tạo tự động

Với config `attempts = "4"` và topic `orders`:

| Topic | Purpose | Delay trước khi retry |
|-------|---------|----------------------|
| `orders` | Original topic | — |
| `orders-retry-0` | Retry attempt 1 | 1s |
| `orders-retry-1` | Retry attempt 2 | 2s |
| `orders-retry-2` | Retry attempt 3 | 4s |
| `orders-dlt` | Dead Letter | (no retry) |

### Sequence Diagram với Exponential Backoff

> Playback dưới đây minh họa thứ tự các bước do tác giả chọn; không gửi request thật, không mô phỏng concurrency và tốc độ phát không phải latency. Bạn có thể chạy hoặc xem từng bước.

```d2 title="Sequence Diagram với Exponential Backoff" mode=flow interactive=true
# @flow
# scenarios:
#   - id: main
#     label: "Kịch bản minh họa"
#     steps:
#       - edge: "(Main -> Main)[0]"
#         description: "orders → orders: Process msg 💥 Fail"
#       - edge: "(Main -> R0)[0]"
#         description: "orders → orders-retry-0: Move to retry-0 (immediately)"
#       - edge: "(R0 -> R0)[0]"
#         description: "orders-retry-0 → orders-retry-0: Process msg 💥 Fail"
#       - edge: "(R0 -> R1)[0]"
#         description: "orders-retry-0 → orders-retry-1: Move to retry-1"
#       - edge: "(R1 -> R1)[0]"
#         description: "orders-retry-1 → orders-retry-1: Process msg"
# @endflow
shape: sequence_diagram
Main: "orders"
R0: "orders-retry-0"
R1: "orders-retry-1"
R2: "orders-retry-2"
DLT: "orders-dlt"
Main -> Main: "Process msg 💥 Fail"
Main -> R0: "Move to retry-0 (immediately)"
R0.note1: "Wait 1s (initial delay)"
R0 -> R0: "Process msg 💥 Fail"
R0 -> R1: "Move to retry-1"
R1.note2: "Wait 2s (1s × 2)"
R1 -> R1: "Process msg"
R1.note3: "🎉 Success this time!"
R1.note4: "✅ Message processed on retry 2"
Main.note5: "Main topic was NOT blocked during all this!"
```

### Headers được ghi lại

Kafka tự động ghi vào message headers khi chuyển qua retry topics:

```java
@KafkaListener(topics = "orders-retry-0")
public void handleRetry(
        String message,
        @Header(RetryTopicHeaders.DEFAULT_HEADER_ATTEMPTS) int attemptNumber,
        @Header(RetryTopicHeaders.DEFAULT_HEADER_ORIGINAL_TIMESTAMP) long originalTimestamp,
        @Header(KafkaHeaders.EXCEPTION_MESSAGE) String lastError) {

    log.warn("Retry attempt #{}, original error: {}", attemptNumber, lastError);
}
```

---

## Dead Letter Topic (DLT)

### Khi nào message đến DLT?

```d2 title="Khi nào message đến DLT?"
direction: down
A: "Message arrives at main topic"
B: "Process success?" { shape: diamond }
C: "✅ Commit offset, done"
D: "Is exception retryable?" { shape: diamond }
E: "📨 Send directly to DLT\nSkip all retries!"
F: "Send to retry-0"
G: "Retry success?" { shape: diamond }
H: "Send to retry-1"
I: "Retry success?" { shape: diamond }
J: "📨 Send to DLT"
K: "🚨 DLT Handler"
A -> B
B -> C: "Yes"
B -> D: "No"
D -> E: "No - ValidationException, etc"
D -> F: "Yes"
F -> G
G -> C: "Yes"
G -> H: "No - attempt 1"
H -> I
I -> C: "Yes"
I -> J: "No - all attempts exhausted"
E -> K
J -> K
```

### DLT Handler hoàn chỉnh

```java
@Service
@Slf4j
public class OrderDltHandler {

    private final AlertService alertService;
    private final FailedMessageRepository repo;
    private final SlackNotifier slack;

    @DltHandler
    public void handle(
            String message,
            @Header(KafkaHeaders.RECEIVED_TOPIC) String topic,
            @Header(KafkaHeaders.RECEIVED_PARTITION) int partition,
            @Header(KafkaHeaders.OFFSET) long offset,
            @Header(KafkaHeaders.EXCEPTION_FQCN) String exceptionClass,
            @Header(KafkaHeaders.EXCEPTION_MESSAGE) String exceptionMessage,
            @Header(RetryTopicHeaders.DEFAULT_HEADER_ATTEMPTS) int attempts) {

        log.error("""
            ❌ Message moved to DLT after {} attempts
            Topic: {}, Partition: {}, Offset: {}
            Exception: {}
            Error: {}
            Message: {}
            """, attempts, topic, partition, offset,
                 exceptionClass, exceptionMessage, message);

        // 1. Persist for manual review
        repo.save(FailedMessage.builder()
            .topic(topic)
            .partition(partition)
            .offset(offset)
            .payload(message)
            .errorClass(exceptionClass)
            .errorMessage(exceptionMessage)
            .attempts(attempts)
            .createdAt(Instant.now())
            .build());

        // 2. Alert ops team
        slack.sendAlert(String.format(
            ":red_circle: DLT message in `%s`\nAttempts: %d\nError: %s",
            topic, attempts, exceptionMessage));
    }
}
```

---

## Phân loại Retryable vs Non-Retryable Errors

Không phải mọi error đều nên retry. Phân loại đúng tránh lãng phí thời gian:

| Retryable — transient | Non-retryable — permanent |
| --- | --- |
| Database connection timeout | Validation error (bad data) |
| Redis unavailable | Deserialization / parse error |
| External API rate limit (429) | Business rule violation |
| Network timeout | Authentication / authorization error |
| Deadlock — retry có thể thành công | Not Found (404), nếu tài nguyên sẽ không xuất hiện |
| Service temporarily down (503) | Data type mismatch |
| | Missing required fields |
| **Retry với backoff** | **Fail fast → DLT** |

```java
@RetryableTopic(
    attempts = "4",
    backoff = @Backoff(delay = 1000, multiplier = 2),
    // ✅ Retry these
    include = {
        DataAccessException.class,        // DB issues
        ResourceAccessException.class,    // Network issues
        ServiceUnavailableException.class // External service down
    },
    // ❌ Never retry — fail fast to DLT
    exclude = {
        ValidationException.class,
        DeserializationException.class,
        BusinessRuleException.class
    }
)
@KafkaListener(topics = "orders")
public void process(String order) { ... }
```

---

## DLT Processing Patterns

### Pattern 1: Alert + Store (Most Common)

```java
@DltHandler
public void handleDlt(String message, @Header(KafkaHeaders.RECEIVED_TOPIC) String topic) {
    // Store for investigation
    failedMessageRepo.save(new FailedMessage(message, topic));
    // Alert
    alertService.sendPagerDuty("DLT message: " + topic);
}
```

### Pattern 2: Scheduled Reprocessing

Đôi khi DLT message có thể processed lại sau khi fix code/data. Implement reprocessing job:

```java
@Service
public class DltReprocessingService {

    private final KafkaTemplate<String, String> kafkaTemplate;
    private final FailedMessageRepository repo;

    // Scheduled job — e.g., every night
    @Scheduled(cron = "0 2 * * *")  // 2 AM daily
    public void reprocessDlt() {
        List<FailedMessage> messages = repo.findByStatus(FailedMessageStatus.PENDING_REPROCESS);

        messages.forEach(msg -> {
            try {
                // Re-send to original topic (not DLT)
                kafkaTemplate.send(msg.getOriginalTopic(), msg.getPayload());
                msg.setStatus(FailedMessageStatus.REPROCESSED);
                repo.save(msg);
            } catch (Exception e) {
                log.error("Failed to reprocess: {}", msg.getId(), e);
            }
        });
    }
}
```

### Pattern 3: Manual Review Dashboard

```java
@RestController
@RequestMapping("/admin/dlt")
public class DltAdminController {

    @GetMapping
    public Page<FailedMessage> listDltMessages(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam String topic) {
        return repo.findByTopic(topic, PageRequest.of(page, 20));
    }

    @PostMapping("/{id}/reprocess")
    public ResponseEntity<Void> reprocess(@PathVariable Long id) {
        FailedMessage msg = repo.findById(id).orElseThrow();
        kafkaTemplate.send(msg.getOriginalTopic(), msg.getPayload());
        return ResponseEntity.ok().build();
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> discard(@PathVariable Long id) {
        repo.deleteById(id);
        return ResponseEntity.ok().build();
    }
}
```

---

## Production Configuration

### Full application.yml cho Error Handling

```yaml
spring:
  kafka:
    consumer:
      enable-auto-commit: false
      # Đủ thời gian cho các retry operations
      max-poll-interval-ms: 600000   # 10 minutes
      max-poll-records: 10           # Ít records hơn để tránh timeout khi retry

    listener:
      ack-mode: MANUAL_IMMEDIATE
      # Container-level error handler
      missing-topics-fatal: false    # Không crash khi retry topics chưa tồn tại

# Retry topic config (tạo topics trước khi deploy)
# kafka-topics.sh --create --topic orders-retry-0 --partitions 3 --replication-factor 3
# kafka-topics.sh --create --topic orders-retry-1 --partitions 3 --replication-factor 3
# kafka-topics.sh --create --topic orders-dlt --partitions 3 --replication-factor 3
```

### Monitoring Retry Health

```java
@Component
@Slf4j
public class RetryMonitor {

    // Alert khi DLT có messages
    @EventListener
    public void onDltMessage(ConsumerRecordRecoverer.RecovererPublisher.DltPublisherEvent event) {
        metricsService.increment("kafka.dlt.messages", "topic", event.topic());
        log.warn("Message sent to DLT: {}", event.topic());
    }

    // Kiểm tra retry lag định kỳ
    @Scheduled(fixedDelay = 60000)
    public void monitorRetryLag() {
        List<String> retryTopics = List.of("orders-retry-0", "orders-retry-1", "orders-dlt");
        retryTopics.forEach(topic -> {
            long lag = kafkaLagService.getLag(topic, "order-group");
            if (lag > 100) {
                alertService.warn("Retry topic lag: " + topic + " = " + lag);
            }
        });
    }
}
```

### Retry Strategy Decision Guide

```d2 title="Retry Strategy Decision Guide"
direction: down
A: "Exception during processing"
B: "Error type?" { shape: diamond }
C: "❌ Fail fast\n→ DLT immediately\nNo retries!"
D: "Expected duration?" { shape: diamond }
E: "Rate limited?" { shape: diamond }
F: "⏱ Short retry\n3 attempts, 1s backoff"
G: "⏱ Long retry\n5 attempts, 30s-5min backoff"
H: "⏱ Respect Retry-After\nExponential backoff with jitter"
I: "⏱ Circuit breaker\n+ retry when service recovers"
A -> B
B -> C: "Validation/Parse error"
B -> D: "Transient DB/Network"
B -> E: "External API down"
D -> F: "Short < 30s"
D -> G: "Long > 30s"
E -> H: "429 Rate limit"
E -> I: "503 Unavailable"
```

---

## Quick Reference

| Scenario | Config | Note |
|---------|--------|------|
| Simple 3 retries, 1s | `@Backoff(delay=1000)`, `attempts="4"` | Good default |
| Exponential backoff | `@Backoff(delay=1000, multiplier=2, maxDelay=30000)` | Recommended |
| Skip validation errors | `exclude={ValidationException.class}` | Fail fast |
| Custom DLT topic | `dltTopicSuffix = "-dead-letter"` | Naming control |
| Disable auto-create | `autoCreateTopics = "false"` | Prefer manual creation in prod |
| DLT handler | `@DltHandler` on separate method | Required for graceful handling |

<Cards>
  <Card title="Exactly-Once Semantics" href="/producers-consumers/exactly-once/" description="Idempotent producer, consumer deduplication" />
  <Card title="Kafka Transactions" href="/producers-consumers/transactions/" description="Dual Write Problem, Outbox Pattern" />
  <Card title="Consumer API" href="/producers-consumers/consumer-api/" description="@KafkaListener, headers, concurrency" />
</Cards>
