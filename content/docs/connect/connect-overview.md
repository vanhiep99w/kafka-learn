---
title: "Kafka Connect: Tổng quan"
description: "Kafka Connect là gì, kiến trúc Source/Sink connector, Worker modes (Standalone vs Distributed), configuration REST API, và khi nào dùng Connect thay vì tự viết Producer/Consumer"
---

# Kafka Connect: Tổng quan

## Mục lục

- [Kafka Connect là gì?](#kafka-connect-là-gì)
- [Kafka Connect vs Tự viết Producer/Consumer](#kafka-connect-vs-tự-viết-producerconsumer)
- [Kiến trúc: Source và Sink Connectors](#kiến-trúc-source-và-sink-connectors)
- [Worker Architecture](#worker-architecture)
- [Standalone vs Distributed Mode](#standalone-vs-distributed-mode)
- [Data Transformation: Single Message Transforms (SMT)](#data-transformation-single-message-transforms-smt)
- [REST API: Quản lý Connectors](#rest-api-quản-lý-connectors)
- [Connector Lifecycle](#connector-lifecycle)
- [Khi nào dùng Kafka Connect](#khi-nào-dùng-kafka-connect)

---

## Kafka Connect là gì?

**Kafka Connect** là một **framework tích hợp dữ liệu** — nó tự động hóa việc di chuyển dữ liệu giữa Kafka và các hệ thống bên ngoài (Databases, S3, Elasticsearch, v.v.) **mà không cần viết code**.

```d2 title="Kafka Connect trong hệ sinh thái"
direction: right
sources: "External systems" {
  db: "PostgreSQL / MySQL / MongoDB"
  input: "REST API / CSV files / streams"
}
kafka: "Apache Kafka\nTopics"
sinks: "External systems" {
  search: "Elasticsearch / AWS S3"
  warehouse: "BigQuery / Snowflake / JDBC"
}
sources.db -> kafka: Source connector
sources.input -> kafka: Source connector
kafka -> sinks.search: Sink connector
kafka -> sinks.warehouse: Sink connector
kafka -> sources.db: Sink
sinks.warehouse -> kafka: Source
note: "Không cần tự viết Producer hoặc Consumer"
```

**Kafka Connect = Plugin-based integration framework:**
- **Source Connector**: Pulls data từ external system → writes to Kafka topic
- **Sink Connector**: Reads from Kafka topic → pushes data to external system
- **Tasks**: Parallel workers thực hiện actual data movement
- **Workers**: JVM processes host connectors và tasks

---

## Kafka Connect vs Tự viết Producer/Consumer

| Tiêu chí | Custom Producer/Consumer | Kafka Connect |
|---------|--------------------------|---------------|
| **Development time** | ❌ Nhiều tuần | ✅ Vài giờ (config only) |
| **Schema handling** | ❌ Tự implement | ✅ Built-in Schema Registry |
| **Offset management** | ✅ Full control | ✅ Auto-managed |
| **Error handling** | ❌ Tự implement | ✅ Built-in retry/DLT |
| **Scaling** | ❌ Tự manage | ✅ Auto via task config |
| **Monitoring** | ❌ Tự implement | ✅ Built-in JMX/REST |
| **Custom logic** | ✅ Unlimited | ⚠️ Limited (SMT only) |
| **CDC support** | ❌ Complex | ✅ Debezium built-in |
| **Maintainability** | ❌ Phải maintain code | ✅ Just config files |

> [!TIP]
> **Khi nào tự viết Producer/Consumer**: Cần business logic phức tạp, xử lý đặc biệt, hoặc tích hợp với hệ thống không có connector. Với tích hợp "dữ liệu thuần", Kafka Connect tiết kiệm rất nhiều công sức.

---

## Kiến trúc: Source và Sink Connectors

### Source Connector — External → Kafka

```d2 title="Source Connector — External → Kafka"
direction: right
g1: "Source Connector (e.g., Debezium PostgreSQL)" {
  DB: "PostgreSQL\nWAL/binlog" { shape: cylinder; icon: ../../assets/d2/postgresql.svg }
  SC: "Source\nConnector"
  T1: "Worker Thread"
  T2: "Worker Thread"
  K: "Kafka Topic\ndb.orders.changes"
}
g1.DB -> g1.SC: "CDC events"
g1.SC -> g1.T1: "Task 1"
g1.SC -> g1.T2: "Task 2"
g1.T1 -> g1.K
g1.T2 -> g1.K
```

**Ví dụ các Source Connectors phổ biến:**

| Connector | Source | Use Case |
|-----------|--------|---------|
| **Debezium PostgreSQL** | PostgreSQL WAL | CDC — capture DB changes |
| **Debezium MySQL** | MySQL binlog | CDC — capture DB changes |
| **JDBC Source** | Any JDBC DB | Polling-based DB ingestion |
| **S3 Source** | AWS S3 | Batch file ingestion |
| **MongoDB CDC** | MongoDB oplog | CDC from MongoDB |
| **HTTP Source** | REST API | API polling |

### Sink Connector — Kafka → External

```d2 title="Sink Connector — Kafka → External"
direction: right
g1: "Sink Connector (e.g., Elasticsearch)" {
  K: "Kafka Topic\norders-enriched"
  T1: "Sink Task"
  T2: "Sink Task"
  ES: "Elasticsearch\nIndex" { shape: cylinder }
}
g1.K -> g1.T1: "Task 1"
g1.K -> g1.T2: "Task 2"
g1.T1 -> g1.ES
g1.T2 -> g1.ES
```

**Ví dụ các Sink Connectors phổ biến:**

| Connector | Sink | Use Case |
|-----------|------|---------|
| **Elasticsearch Sink** | Elasticsearch | Search indexing |
| **S3 Sink** | AWS S3 | Data lake, archiving |
| **JDBC Sink** | Any JDBC DB | Write to relational DB |
| **BigQuery Sink** | Google BigQuery | Analytics warehouse |
| **Snowflake Sink** | Snowflake | Data warehouse |
| **Redis Sink** | Redis | Cache population |
| **HTTP Sink** | REST API | Webhook delivery |

---

## Worker Architecture

```d2 title="Bên trong Kafka Connect Worker"
direction: down
worker: "Worker process (JVM)" {
  icon: ../../assets/d2/java.svg
  connector: "Debezium PostgreSQL — Source connector" {
    t1: "Task 1\norders — polling WAL"
    t2: "Task 2\npayments — polling WAL"
    t3: "Task 3\nusers — polling WAL"
    p1: Kafka Producer API
    p2: Kafka Producer API
    t1 -> p1
    t2 -> p1
    t3 -> p2
  }
}
internal: "Internal topics — Connect framework quản lý" {
  config: "connect-configs\nConnector configurations"
  offsets: "connect-offsets\nSource connector offsets đã publish"
  status: "connect-status\nConnector / task status"
}
```

**Offset management** cho Source Connectors:
- Connect tự lưu offset vào topic `connect-offsets`
- Nếu worker restart → resume từ saved offset — không miss data
- Khác với Consumer offset: Source offset là vị trí trong source system (e.g., DB LSN, file position)

---

## Standalone vs Distributed Mode

### Standalone Mode

```yaml
# connect-standalone.properties
bootstrap.servers=localhost:9092
key.converter=org.apache.kafka.connect.json.JsonConverter
value.converter=org.apache.kafka.connect.json.JsonConverter
offset.storage.file.filename=/tmp/connect.offsets
```

```bash
# Run standalone
connect-standalone.sh connect-standalone.properties my-connector.properties
```

**Dùng khi**: Development, testing, single-machine ETL jobs.

**Nhược điểm**: Single point of failure, không scale được.

### Distributed Mode (Production)

```yaml
# connect-distributed.properties
bootstrap.servers=localhost:9092
group.id=connect-cluster

# Internal topics
config.storage.topic=connect-configs
offset.storage.topic=connect-offsets
status.storage.topic=connect-status

# Replication for HA
config.storage.replication.factor=3
offset.storage.replication.factor=3
status.storage.replication.factor=3

# Converters
key.converter=io.confluent.connect.avro.AvroConverter
value.converter=io.confluent.connect.avro.AvroConverter
key.converter.schema.registry.url=http://schema-registry:8081
value.converter.schema.registry.url=http://schema-registry:8081
```

```d2 title="Distributed Mode (Production)"
direction: down
g1: "Distributed Connect Cluster (3 Workers)" {
  W1: "Worker 1\nTask 1 (orders)\nTask 2 (payments)"
  W2: "Worker 2\nTask 3 (users)"
  W3: "Worker 3\n(standby/other tasks)"
  LB: "Load Balancer\nREST API :8083"
}
g2: "Kafka Cluster" {
  CT: "connect-configs"
  CO: "connect-offsets"
  CS: "connect-status"
}
Note: "If W1 fails → Tasks rebalanced to W2, W3 automatically"
g1.LB -> g1.W1
g1.LB -> g1.W2
g1.LB -> g1.W3
g1.W1 -- g2.CT
g1.W2 -- g2.CO
g1.W3 -- g2.CS
```

**Ưu điểm**: HA, horizontal scaling, REST API management, automatic task rebalancing.

---

## Data Transformation: Single Message Transforms (SMT)

SMTs cho phép transform data **inline** trước khi ghi vào Kafka (Source) hoặc sau khi đọc từ Kafka (Sink):

```json
{
  "name": "postgres-source-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "transforms": "unwrap,addField,maskSensitive",

    "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
    "transforms.unwrap.drop.tombstones": "false",

    "transforms.addField.type": "org.apache.kafka.connect.transforms.InsertField$Value",
    "transforms.addField.static.field": "source_system",
    "transforms.addField.static.value": "postgres-prod",

    "transforms.maskSensitive.type": "org.apache.kafka.connect.transforms.MaskField$Value",
    "transforms.maskSensitive.fields": "credit_card_number,ssn",
    "transforms.maskSensitive.replacement": "****"
  }
}
```

**Các SMTs built-in phổ biến:**

| SMT | Mục đích |
|-----|---------|
| `InsertField` | Thêm field mới (static, timestamp, topic name) |
| `ReplaceField` | Rename hoặc drop fields |
| `MaskField` | Mask sensitive data (PII) |
| `Filter` | Drop messages theo condition |
| `ExtractField` | Lấy nested field ra top-level |
| `TimestampConverter` | Convert timestamp formats |
| `ValueToKey` | Dùng value field làm message key |
| `Flatten` | Flatten nested JSON schema |

---

## REST API: Quản lý Connectors

Kafka Connect expose REST API mặc định trên port **8083**:

```bash
# Xem tất cả connectors đang chạy
curl http://localhost:8083/connectors

# Tạo connector mới
curl -X POST http://localhost:8083/connectors \
  -H "Content-Type: application/json" \
  -d '{
    "name": "postgres-orders-source",
    "config": {
      "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
      "database.hostname": "postgres",
      "database.port": "5432",
      "database.user": "kafka_user",
      "database.password": "secret",
      "database.dbname": "orders_db",
      "table.include.list": "public.orders,public.payments",
      "topic.prefix": "db"
    }
  }'

# Xem status connector
curl http://localhost:8083/connectors/postgres-orders-source/status

# Xem status từng task
curl http://localhost:8083/connectors/postgres-orders-source/tasks

# Pause connector (tạm dừng)
curl -X PUT http://localhost:8083/connectors/postgres-orders-source/pause

# Resume connector
curl -X PUT http://localhost:8083/connectors/postgres-orders-source/resume

# Restart failed task
curl -X POST http://localhost:8083/connectors/postgres-orders-source/tasks/0/restart

# Xóa connector
curl -X DELETE http://localhost:8083/connectors/postgres-orders-source

# Validate connector config trước khi tạo
curl -X PUT http://localhost:8083/connector-plugins/PostgresConnector/config/validate \
  -H "Content-Type: application/json" \
  -d '{ ... config ... }'
```

Các exchange dưới đây là **response minh họa**, không phải kết quả gọi API trực tiếp. Worker ID và danh sách task phụ thuộc cluster thực tế; component không gửi HTTP request.

```protocol-exchange
title: Đọc trạng thái connector và tạm dừng
variants:
  - id: status
    title: Connector và task đang RUNNING
    request:
      method: GET
      url: http://localhost:8083/connectors/postgres-orders-source/status
    response:
      status: 200
      statusText: OK
      headers:
        - id: content-type
          name: Content-Type
          value: application/json
      body:
        kind: json
        json: |-
          {
            "name": "postgres-orders-source",
            "connector": {"state": "RUNNING", "worker_id": "connect:8083"},
            "tasks": [{"id": 0, "state": "RUNNING", "worker_id": "connect:8083"}],
            "type": "source"
          }
  - id: pause
    title: Pause được chấp nhận — cần kiểm tra lại status
    request:
      method: PUT
      url: http://localhost:8083/connectors/postgres-orders-source/pause
    response:
      status: 202
      statusText: Accepted
```

`202 Accepted` chỉ cho biết lệnh pause được chấp nhận; gọi lại endpoint `/status` để theo dõi trạng thái, không giả định mọi task đã dừng ngay.

---

## Connector Lifecycle

```d2 title="Connector Lifecycle"
direction: right
start: Bắt đầu { shape: circle }
finish: Kết thúc { shape: circle }
UNASSIGNED: "UNASSIGNED"
RUNNING: "RUNNING"
PAUSED: "PAUSED"
FAILED: "FAILED"
STOPPED: "STOPPED"
start -> UNASSIGNED: "Connector created"
UNASSIGNED -> RUNNING: "Worker assigned + started"
RUNNING -> PAUSED: "Manual pause"
PAUSED -> RUNNING: "Manual resume"
RUNNING -> FAILED: "Error occurred"
FAILED -> RUNNING: "Manual restart"
RUNNING -> STOPPED: "Deleted"
STOPPED -> finish
```

**Task States:**

| State | Ý nghĩa | Hành động |
|-------|---------|----------|
| `RUNNING` | Task đang hoạt động | Monitor lag |
| `PAUSED` | Task bị pause | Resume khi ready |
| `FAILED` | Task gặp lỗi | Restart task, check logs |
| `UNASSIGNED` | Chưa được gán vào worker | Chờ rebalance |

---

## Khi nào dùng Kafka Connect

```d2 title="Khi nào dùng Kafka Connect"
direction: down
A: "Cần integrate external system với Kafka?"
B: "Có connector available?" { shape: diamond }
C: "Cần custom business logic?" { shape: diamond }
D: "Tự viết Producer/Consumer\nhoặc Kafka Streams"
E: "✅ Kafka Connect\nConfiguration only!"
F: "SMT đủ không?" { shape: diamond }
G: "Custom Producer/Consumer\nhoặc Kafka Streams"
H: "Benefits:\n• No code to maintain\n• Built-in offset mgmt\n• Auto-retry\n• Scaling via tasks"
A -> B
B -> C: "Có"
B -> D: "Không"
C -> E: "Không - pure data movement"
C -> F: "Có - nhưng nhỏ"
C -> G: "Có - phức tạp"
F -> E: "Có"
F -> G: "Không"
E -> H
```

**Checklist cho Kafka Connect:**

```
✅ Dùng Kafka Connect khi:
   [ ] Tích hợp DB → Kafka (CDC hoặc polling)
   [ ] Kafka → Data warehouse (S3, BigQuery, Snowflake)
   [ ] Kafka → Search (Elasticsearch)
   [ ] Backup/archival Kafka data
   [ ] ETL đơn giản giữa hệ thống
   [ ] Team muốn tránh viết boilerplate code

❌ Không dùng Kafka Connect khi:
   [ ] Cần complex business logic transformation
   [ ] Source system không có connector
   [ ] Cần full control over error handling
   [ ] Cần custom authentication mechanism phức tạp
```

<Cards>
  <Card title="Connectors Deep Dive" href="/connect/connectors/" description="Debezium CDC, JDBC, S3 — config chi tiết và best practices" />
  <Card title="Kafka Streams" href="/streams/streams-overview/" description="Khi cần xử lý và transform trong Kafka" />
  <Card title="Transactions" href="/producers-consumers/transactions/" description="Outbox Pattern vs CDC approach" />
</Cards>
