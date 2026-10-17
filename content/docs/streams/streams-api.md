---
title: "Kafka Streams API"
description: "Hands-on Kafka Streams DSL: filter, map, groupByKey, aggregate, windowing (tumbling/hopping/session), KStream-KTable joins, và các patterns thực tế với Spring Boot"
---

# Kafka Streams API

## Mục lục

- [StreamsBuilder — Điểm khởi đầu](#streamsbuilder--điểm-khởi-đầu)
- [Stateless Operations](#stateless-operations)
- [Stateful Operations: GroupBy và Aggregate](#stateful-operations-groupby-và-aggregate)
- [Windowing](#windowing)
- [Joins: KStream-KTable](#joins-kstream-ktable)
- [Joins: KStream-KStream](#joins-kstream-kstream)
- [Error Handling trong Streams](#error-handling-trong-streams)
- [Interactive Queries (Query State Store via REST)](#interactive-queries-query-state-store-via-rest)
- [Testing với TopologyTestDriver](#testing-với-topologytestdriver)
- [Production Patterns](#production-patterns)

---

## StreamsBuilder — Điểm khởi đầu

Mọi Kafka Streams topology được xây từ `StreamsBuilder`:

```java
@Configuration
@EnableKafkaStreams
public class OrderStreamsConfig {

    /**
     * Spring tự động gọi bean này với name "defaultKafkaStreamsBuilder"
     * và đăng ký topology vào KafkaStreams instance
     */
    @Bean
    public KStream<String, String> orderStream(StreamsBuilder builder) {

        // Source: đọc từ topic "orders"
        KStream<String, String> stream = builder.stream("orders");

        // Processing chain...
        stream
            .filter((key, value) -> value != null)
            .mapValues(value -> value.toUpperCase())
            .to("orders-processed");     // Sink: ghi ra topic

        return stream;
    }
}
```

---

## Stateless Operations

Các operations không cần nhớ state giữa các records:

### filter / filterNot

```java
@Bean
public KStream<String, OrderEvent> processedOrders(StreamsBuilder builder) {

    KStream<String, OrderEvent> orders = builder.stream(
        "orders",
        Consumed.with(Serdes.String(), orderEventSerde())
    );

    // Chỉ lấy orders đã COMPLETED
    KStream<String, OrderEvent> completedOrders = orders
        .filter((orderId, order) -> order.getStatus() == OrderStatus.COMPLETED);

    // Loại bỏ orders bị cancel
    KStream<String, OrderEvent> activeOrders = orders
        .filterNot((orderId, order) -> order.getStatus() == OrderStatus.CANCELLED);

    completedOrders.to("orders-completed");
    return completedOrders;
}
```

### map / mapValues / flatMap

```java
// mapValues: transform value, giữ nguyên key
KStream<String, RevenueEvent> revenue = completedOrders
    .mapValues(order -> RevenueEvent.builder()
        .orderId(order.getId())
        .customerId(order.getCustomerId())
        .amount(order.getTotalAmount())
        .currency(order.getCurrency())
        .build());

// map: đổi cả key và value
KStream<String, OrderEvent> reKeyed = orders
    .map((oldKey, order) -> KeyValue.pair(
        order.getCustomerId(),  // ← New key: route by customer
        order
    ));

// flatMap: 1 record → nhiều records
KStream<String, ItemEvent> items = orders
    .flatMap((orderId, order) ->
        order.getItems().stream()
            .map(item -> KeyValue.pair(item.getSku(), ItemEvent.from(item, orderId)))
            .collect(Collectors.toList())
    );
```

### branch — Split stream

```java
// Phân luồng dựa trên điều kiện
Map<String, KStream<String, OrderEvent>> branches = orders
    .split(Named.as("order-"))
    .branch((key, order) -> order.getTotalAmount() > 1000, Branched.as("high-value"))
    .branch((key, order) -> order.getTotalAmount() > 100,  Branched.as("medium-value"))
    .defaultBranch(Branched.as("low-value"));

branches.get("order-high-value").to("orders-high-value");
branches.get("order-medium-value").to("orders-medium-value");
branches.get("order-low-value").to("orders-low-value");
```

---

## Stateful Operations: GroupBy và Aggregate

### count — Đếm records

```java
@Bean
public KStream<String, Long> orderCountStream(StreamsBuilder builder) {

    KStream<String, OrderEvent> orders = builder.stream("orders",
        Consumed.with(Serdes.String(), orderEventSerde()));

    // Đếm số orders per customerId
    KTable<String, Long> orderCountPerCustomer = orders
        .groupBy(
            (orderId, order) -> order.getCustomerId(),  // Group by customerId
            Grouped.with(Serdes.String(), orderEventSerde())
        )
        .count(Materialized.as("order-count-store"));   // Name the state store

    // Convert KTable to KStream và ghi ra topic
    orderCountPerCustomer
        .toStream()
        .to("customer-order-counts", Produced.with(Serdes.String(), Serdes.Long()));

    return orders;
}
```

### aggregate — Custom aggregation

```java
// Tính tổng doanh thu per customer
KTable<String, CustomerRevenue> revenuePerCustomer = orders
    .filter((id, order) -> order.getStatus() == OrderStatus.COMPLETED)
    .groupBy(
        (orderId, order) -> order.getCustomerId(),
        Grouped.with(Serdes.String(), orderEventSerde())
    )
    .aggregate(
        // Initializer — trả về giá trị mặc định khi chưa có data
        () -> CustomerRevenue.empty(),

        // Aggregator — cộng thêm mỗi record vào aggregate
        (customerId, order, currentRevenue) -> currentRevenue.add(order.getTotalAmount()),

        // Materialized — tên state store + serde
        Materialized
            .<String, CustomerRevenue>as("customer-revenue-store")
            .withKeySerde(Serdes.String())
            .withValueSerde(customerRevenueSerde())
    );

revenuePerCustomer
    .toStream()
    .to("customer-revenue", Produced.with(Serdes.String(), customerRevenueSerde()));
```

### reduce — Merge records cùng key

```java
// Giữ order có amount cao nhất per customer
KTable<String, OrderEvent> highestOrderPerCustomer = orders
    .groupBy((id, order) -> order.getCustomerId(), Grouped.with(Serdes.String(), orderEventSerde()))
    .reduce(
        (currentMax, newOrder) ->
            newOrder.getTotalAmount() > currentMax.getTotalAmount() ? newOrder : currentMax
    );
```

---

## Windowing

**Windowing** cho phép aggregate trong khoảng thời gian nhất định.

### Tumbling Window — Cửa sổ không overlap

```d2 title="Tumbling windows: không chồng lấn"
direction: right
w1: "Window 1\n00:00–05:00\n5 events minh họa"
w2: "Window 2\n05:00–10:00\n3 events minh họa"
w3: "Window 3\n10:00–15:00\n4 events minh họa"
w1 -> w2 -> w3: Event time
```

```java
// Đếm orders mỗi 5 phút
KTable<Windowed<String>, Long> ordersPerWindow = orders
    .groupBy((id, order) -> order.getCustomerId(), Grouped.with(Serdes.String(), orderEventSerde()))
    .windowedBy(
        TimeWindows.ofSizeWithNoGrace(Duration.ofMinutes(5))
        // .grace(Duration.ofSeconds(30))  // Cho phép late events
    )
    .count(Materialized.as("orders-per-5min-store"));

// Convert windowed key thành readable format
ordersPerWindow
    .toStream()
    .map((windowedKey, count) -> KeyValue.pair(
        windowedKey.key() + "@" + windowedKey.window().startTime(),
        count
    ))
    .to("orders-per-5min", Produced.with(Serdes.String(), Serdes.Long()));
```

### Hopping Window — Cửa sổ overlap

```d2 title="Hopping windows: size 10 phút, advance 5 phút"
grid-columns: 4
head: Window
h0: "00:00–05:00"; h1: "05:00–10:00"; h2: "10:00–15:00"
a: W1
w10: Trong W1; w11: Trong W1; w12: Ngoài W1
b: W2
w20: Ngoài W2; w21: Trong W2; w22: Trong W2
c: "W3 — bắt đầu 10:00"
w30: Ngoài W3; w31: Ngoài W3; w32: "Trong W3\nKéo dài đến 20:00"
```

```java
// "Rolling" 10-minute window that advances every 5 minutes
KTable<Windowed<String>, Long> rollingOrders = orders
    .groupBy((id, order) -> order.getCustomerId(), Grouped.with(Serdes.String(), orderEventSerde()))
    .windowedBy(
        TimeWindows.ofSizeAndGrace(Duration.ofMinutes(10), Duration.ofSeconds(30))
            .advanceBy(Duration.ofMinutes(5))
    )
    .count();
```

### Session Window — Activity-based

```d2 title="Session windows theo inactivity gap"
direction: right
s1: "Session 1\n2 events"
s2: "Session 2\n3 events"
s3: "Session 3\n1 event"
s1 -> s2: Không có event quá gap 5 phút
s2 -> s3: Không có event quá gap 5 phút
note: "Các event cách nhau trong inactivity gap\nđược gom vào cùng session"
```

```java
// Session-based aggregation (e.g., user activity sessions)
KTable<Windowed<String>, Long> sessionActivity = clickEvents
    .groupByKey()
    .windowedBy(SessionWindows.ofInactivityGapAndGrace(
        Duration.ofMinutes(5),    // Inactivity gap
        Duration.ofSeconds(30)    // Grace period for late events
    ))
    .count(Materialized.as("user-sessions-store"));
```

---

## Joins: KStream-KTable

Enrich streaming events với lookup table data (thường là reference data):

```d2 title="KStream–KTable join enrich order"
direction: right
orders: "KStream — orders\nOrder 1: customerId C1\nOrder 2: customerId C3"
customers: "KTable — customers\nC1: Alice, GOLD\nC2: Bob, SILVER\nC3: Carol, GOLD"
join: Join theo customerId
result: "Order + customerInfo\nOrder 1 + Alice\nOrder 2 + Carol"
orders -> join
customers -> join: Lookup state mới nhất
join -> result
note: "Với leftJoin: customer không có trong table\nthì joiner nhận null ở phía customer"
```

```java
@Bean
public KStream<String, EnrichedOrder> enrichedOrderStream(StreamsBuilder builder) {

    // Source: orders stream (key = orderId)
    KStream<String, OrderEvent> orders = builder.stream("orders",
        Consumed.with(Serdes.String(), orderEventSerde()));

    // Reference data: customer table (key = customerId)
    KTable<String, CustomerInfo> customers = builder.table("customers",
        Consumed.with(Serdes.String(), customerInfoSerde()));

    // ❗ IMPORTANT: KStream key must match KTable key for join
    // orders key = orderId, but we need to join on customerId
    // → Re-key orders by customerId first
    KStream<String, OrderEvent> reKeyedOrders = orders
        .selectKey((orderId, order) -> order.getCustomerId());

    // Now both have key = customerId → join!
    KStream<String, EnrichedOrder> enrichedOrders = reKeyedOrders
        .join(
            customers,
            // Joiner: combine order + customer info
            (order, customer) -> EnrichedOrder.builder()
                .order(order)
                .customerName(customer.getName())
                .customerTier(customer.getTier())
                .build(),
            Joined.with(Serdes.String(), orderEventSerde(), customerInfoSerde())
        );

    enrichedOrders.to("orders-enriched", Produced.with(Serdes.String(), enrichedOrderSerde()));
    return enrichedOrders;
}
```

> [!WARNING]
> **Co-partitioning requirement**: KStream và KTable phải có **cùng số partitions** và cùng partitioning strategy (cùng key). Nếu không, join sẽ fail at runtime.

---

## Joins: KStream-KStream

Join hai streams theo time window (ví dụ: request + response correlation):

```java
// Correlate payment-requests with payment-responses (within 5 minutes)
KStream<String, PaymentRequest> requests = builder.stream("payment-requests",
    Consumed.with(Serdes.String(), paymentRequestSerde()));

KStream<String, PaymentResponse> responses = builder.stream("payment-responses",
    Consumed.with(Serdes.String(), paymentResponseSerde()));

KStream<String, PaymentResult> results = requests
    .join(
        responses,
        // Joiner (request side, response side) → result
        (request, response) -> PaymentResult.builder()
            .requestId(request.getId())
            .status(response.getStatus())
            .amount(request.getAmount())
            .processedAt(response.getTimestamp())
            .build(),
        // Window: join if events arrive within 5 minutes of each other
        JoinWindows.ofTimeDifferenceAndGrace(Duration.ofMinutes(5), Duration.ofSeconds(30)),
        StreamJoined.with(Serdes.String(), paymentRequestSerde(), paymentResponseSerde())
    );

results.to("payment-results");
```

---

## Error Handling trong Streams

### Deserialization Errors

```java
@Bean(name = KafkaStreamsDefaultConfiguration.DEFAULT_STREAMS_CONFIG_BEAN_NAME)
public KafkaStreamsConfiguration kafkaStreamsConfig() {
    Map<String, Object> props = new HashMap<>();
    props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
    props.put(StreamsConfig.APPLICATION_ID_CONFIG, "order-analytics");

    // Handle deserialization errors — log and skip instead of crashing
    props.put(StreamsConfig.DEFAULT_DESERIALIZATION_EXCEPTION_HANDLER_CLASS_CONFIG,
        LogAndContinueExceptionHandler.class);
    // OR: send to DLQ
    props.put(StreamsConfig.DEFAULT_DESERIALIZATION_EXCEPTION_HANDLER_CLASS_CONFIG,
        LogAndFailExceptionHandler.class);

    return new KafkaStreamsConfiguration(props);
}
```

### Production Exception Handler

```java
public class CustomStreamUncaughtExceptionHandler
        implements StreamsUncaughtExceptionHandler {

    @Override
    public StreamThreadExceptionResponse handle(Throwable exception) {
        log.error("Uncaught exception in Kafka Streams thread", exception);

        if (exception instanceof OutOfMemoryError) {
            // Fatal — replace the failed thread
            return StreamThreadExceptionResponse.REPLACE_THREAD;
        }

        if (exception.getCause() instanceof TransientException) {
            // Transient — replace thread and retry
            return StreamThreadExceptionResponse.REPLACE_THREAD;
        }

        // Unknown — shutdown the application (let k8s restart it)
        return StreamThreadExceptionResponse.SHUTDOWN_APPLICATION;
    }
}
```

---

## Interactive Queries (Query State Store via REST)

Kafka Streams lưu state locally. Để expose state qua REST API:

```java
@RestController
@RequestMapping("/analytics")
public class AnalyticsController {

    @Autowired
    private KafkaStreams kafkaStreams;

    @GetMapping("/customers/{customerId}/revenue")
    public CustomerRevenue getCustomerRevenue(@PathVariable String customerId) {
        // Query the local state store
        ReadOnlyKeyValueStore<String, CustomerRevenue> store =
            kafkaStreams.store(
                StoreQueryParameters.fromNameAndType(
                    "customer-revenue-store",
                    QueryableStoreTypes.keyValueStore()
                )
            );

        CustomerRevenue revenue = store.get(customerId);
        return revenue != null ? revenue : CustomerRevenue.empty();
    }

    @GetMapping("/customers/{customerId}/order-count-windows")
    public List<WindowResult> getWindowedOrderCount(@PathVariable String customerId) {
        ReadOnlyWindowStore<String, Long> windowStore =
            kafkaStreams.store(
                StoreQueryParameters.fromNameAndType(
                    "orders-per-5min-store",
                    QueryableStoreTypes.windowStore()
                )
            );

        Instant from = Instant.now().minus(Duration.ofHours(1));
        Instant to = Instant.now();

        List<WindowResult> results = new ArrayList<>();
        try (WindowStoreIterator<Long> iter = windowStore.fetch(customerId, from, to)) {
            while (iter.hasNext()) {
                KeyValue<Long, Long> kv = iter.next();
                results.add(new WindowResult(Instant.ofEpochMilli(kv.key), kv.value));
            }
        }
        return results;
    }
}
```

---

## Testing với TopologyTestDriver

Kafka Streams có built-in test driver — không cần Kafka broker thật:

```java
@ExtendWith(MockitoExtension.class)
class OrderCountStreamTest {

    private TopologyTestDriver testDriver;
    private TestInputTopic<String, String> inputTopic;
    private TestOutputTopic<String, Long> outputTopic;

    @BeforeEach
    void setUp() {
        StreamsBuilder builder = new StreamsBuilder();

        // Build topology
        KStream<String, String> orders = builder.stream("orders");
        orders
            .groupBy((key, value) -> extractCustomerId(value))
            .count(Materialized.as("order-count-store"))
            .toStream()
            .to("customer-order-counts", Produced.with(Serdes.String(), Serdes.Long()));

        Properties props = new Properties();
        props.put(StreamsConfig.APPLICATION_ID_CONFIG, "test");
        props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "dummy:9092");
        props.put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG, Serdes.String().getClass());
        props.put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG, Serdes.String().getClass());

        testDriver = new TopologyTestDriver(builder.build(), props);

        inputTopic = testDriver.createInputTopic("orders",
            new StringSerializer(), new StringSerializer());

        outputTopic = testDriver.createOutputTopic("customer-order-counts",
            new StringDeserializer(), new LongDeserializer());
    }

    @Test
    void shouldCountOrdersPerCustomer() {
        // Arrange: send test messages
        inputTopic.pipeInput("order-1", "{\"customerId\":\"cust-A\",\"amount\":100}");
        inputTopic.pipeInput("order-2", "{\"customerId\":\"cust-B\",\"amount\":50}");
        inputTopic.pipeInput("order-3", "{\"customerId\":\"cust-A\",\"amount\":200}");

        // Assert: cust-A has 2 orders, cust-B has 1
        Map<String, Long> results = outputTopic.readKeyValuesToMap();
        assertThat(results.get("cust-A")).isEqualTo(2L);
        assertThat(results.get("cust-B")).isEqualTo(1L);
    }

    @AfterEach
    void tearDown() {
        testDriver.close();
    }
}
```

---

## Production Patterns

### Exactly-Once Processing

```yaml
spring:
  kafka:
    streams:
      properties:
        # Exactly-once semantics cho Kafka-to-Kafka processing
        processing.guarantee: exactly_once_v2  # Requires Kafka 2.5+

        # Tune commit interval (lower = less duplicate on failure)
        commit.interval.ms: 100
```

### Scaling Kafka Streams

```yaml
spring:
  kafka:
    streams:
      properties:
        # Multiple threads per instance (parallel partitions)
        num.stream.threads: 4

        # Multiple instances: just launch more pods
        # Kafka will automatically rebalance partitions across instances
```

```d2 title="Scale Kafka Streams trên 12 partition"
direction: down
topic: "orders — 12 partitions"
i1: "Instance 1 — 4 threads\nP0,1,2,3\nState store: partial"
i2: "Instance 2 — 4 threads\nP4,5,6,7\nState store: partial"
i3: "Instance 3\nP8,9,10,11\nState store: partial"
topic -> i1
topic -> i2
topic -> i3
```

### Monitoring

```java
@Bean
public CommandLineRunner streamsMetrics(KafkaStreams kafkaStreams) {
    return args -> {
        Map<MetricName, ? extends Metric> metrics = kafkaStreams.metrics();

        // Key metrics to watch
        metrics.entrySet().stream()
            .filter(e -> e.getKey().name().contains("process-rate")
                      || e.getKey().name().contains("commit-rate")
                      || e.getKey().name().contains("lag"))
            .forEach(e -> log.info("{}: {}", e.getKey().name(), e.getValue().metricValue()));
    };
}
```

| Metric | Ý nghĩa | Alert khi |
|--------|---------|-----------|
| `process-rate` | Records processed/sec | Giảm đột ngột |
| `commit-rate` | State commits/sec | = 0 (stuck) |
| `poll-records-avg` | Avg records per poll | Quá thấp |
| `record-lag-max` | Max consumer lag | > threshold |

<Cards>
  <Card title="Streams Overview" href="/streams/streams-overview/" description="KStream vs KTable, topology, state management concepts" />
  <Card title="Exactly-Once Semantics" href="/producers-consumers/exactly-once/" description="EOS, idempotency trong Kafka Streams context" />
  <Card title="Kafka Connect" href="/connect/connect-overview/" description="Source/Sink connectors, CDC với Debezium" />
</Cards>
