---
title: "Setup Kafka với Docker"
description: "Hướng dẫn cài đặt Apache Kafka local với Docker Compose, bao gồm cả KRaft mode (không cần ZooKeeper)"
---

# Setup Kafka với Docker

## Mục lục

- [Yêu cầu](#yêu-cầu)
- [Option 1: KRaft Mode (Kafka 3.x, không cần ZooKeeper)](#option-1-kraft-mode)
- [Option 2: ZooKeeper Mode (Classic)](#option-2-zookeeper-mode)
- [Kafka UI — Giao diện quản lý](#kafka-ui)
- [Verify cài đặt](#verify-cài-đặt)
- [Các lệnh CLI cơ bản](#các-lệnh-cli-cơ-bản)

---

## Yêu cầu

- Docker Desktop hoặc Docker Engine + Docker Compose
- Port 9092 (Kafka broker) chưa bị chiếm

---

## Option 1: KRaft Mode

**KRaft** (Kafka Raft) là mode mới từ Kafka 3.3+, loại bỏ phụ thuộc vào ZooKeeper. Đơn giản hơn, ít component hơn.

Tạo file `docker-compose.yml`:

```yaml
version: '3.8'

services:
  kafka:
    image: confluentinc/cp-kafka:7.6.0
    hostname: kafka
    container_name: kafka
    ports:
      - "9092:9092"
      - "9101:9101"
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT'
      KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://kafka:29092,PLAINTEXT_HOST://localhost:9092'
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: 0
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_JMX_PORT: 9101
      KAFKA_JMX_HOSTNAME: localhost
      KAFKA_PROCESS_ROLES: 'broker,controller'
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@kafka:29093'
      KAFKA_LISTENERS: 'PLAINTEXT://kafka:29092,CONTROLLER://kafka:29093,PLAINTEXT_HOST://0.0.0.0:9092'
      KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT'
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER'
      KAFKA_LOG_DIRS: '/tmp/kraft-combined-logs'
      CLUSTER_ID: 'MkU3OEVBNTcwNTJENDM2Qk'

  kafka-ui:
    image: provectuslabs/kafka-ui:latest
    container_name: kafka-ui
    ports:
      - "8080:8080"
    environment:
      KAFKA_CLUSTERS_0_NAME: local
      KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS: kafka:29092
    depends_on:
      - kafka
```

Khởi động:

```bash
docker-compose up -d

# Kiểm tra status
docker-compose ps

# Xem logs
docker-compose logs -f kafka
```

---

## Option 2: ZooKeeper Mode

Dùng khi cần tương thích với Kafka cũ hơn (< 3.3):

```yaml
version: '3.8'

services:
  zookeeper:
    image: confluentinc/cp-zookeeper:7.6.0
    hostname: zookeeper
    container_name: zookeeper
    ports:
      - "2181:2181"
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181
      ZOOKEEPER_TICK_TIME: 2000

  kafka:
    image: confluentinc/cp-kafka:7.6.0
    hostname: kafka
    container_name: kafka
    depends_on:
      - zookeeper
    ports:
      - "9092:9092"
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: 'zookeeper:2181'
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:29092,PLAINTEXT_HOST://localhost:9092
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1

  kafka-ui:
    image: provectuslabs/kafka-ui:latest
    container_name: kafka-ui
    ports:
      - "8080:8080"
    environment:
      KAFKA_CLUSTERS_0_NAME: local
      KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS: kafka:29092
    depends_on:
      - kafka
```

---

## Kafka UI

Sau khi khởi động, truy cập **http://localhost:8080** để dùng Kafka UI:

- Xem danh sách topics
- Browse messages trong topic
- Xem consumer groups và lag
- Tạo/xóa topics

> [!TIP]
> Kafka UI (provectuslabs/kafka-ui) là công cụ open-source rất mạnh để monitor Kafka local. Trong production, các team thường dùng Confluent Control Center hoặc Conduktor.

---

## Verify cài đặt

```bash
# Vào container kafka
docker exec -it kafka bash

# Hoặc dùng kafka-topics.sh từ ngoài container
docker exec kafka kafka-topics --list --bootstrap-server localhost:9092
```

Nếu không có lỗi và trả về empty list (hoặc `__consumer_offsets`), Kafka đã chạy bình thường.

---

## Các lệnh CLI cơ bản

<Steps>
  <Step>
    **Tạo topic**
    ```bash
    docker exec kafka kafka-topics \
      --create \
      --bootstrap-server localhost:9092 \
      --topic test-topic \
      --partitions 3 \
      --replication-factor 1
    ```
  </Step>
  <Step>
    **Gửi messages (Producer)**
    ```bash
    docker exec -it kafka kafka-console-producer \
      --bootstrap-server localhost:9092 \
      --topic test-topic

    # Gõ message và nhấn Enter, Ctrl+C để thoát
    > Hello Kafka!
    > Message 2
    ```
  </Step>
  <Step>
    **Đọc messages (Consumer)**
    ```bash
    # Đọc từ đầu
    docker exec kafka kafka-console-consumer \
      --bootstrap-server localhost:9092 \
      --topic test-topic \
      --from-beginning

    # Đọc messages mới (không --from-beginning)
    docker exec kafka kafka-console-consumer \
      --bootstrap-server localhost:9092 \
      --topic test-topic
    ```
  </Step>
  <Step>
    **Xem thông tin topic**
    ```bash
    docker exec kafka kafka-topics \
      --describe \
      --bootstrap-server localhost:9092 \
      --topic test-topic
    ```
  </Step>
</Steps>

**Tham chiếu nhanh CLI:**

| Lệnh | Mục đích |
|------|----------|
| `kafka-topics --list` | Liệt kê tất cả topics |
| `kafka-topics --describe --topic <name>` | Xem chi tiết topic |
| `kafka-topics --delete --topic <name>` | Xóa topic |
| `kafka-consumer-groups --list` | Liệt kê consumer groups |
| `kafka-consumer-groups --describe --group <name>` | Xem lag của consumer group |
| `kafka-configs --describe --topic <name>` | Xem config của topic |
