---
title: "Kafka Security"
description: "Bảo mật Kafka trong production: SSL/TLS encryption, SASL authentication (PLAIN, SCRAM, OAUTHBEARER), ACL authorization, và Spring Boot security configuration"
---

# Kafka Security

## Mục lục

- [Security Layers trong Kafka](#security-layers-trong-kafka)
- [SSL/TLS — Encryption in Transit](#ssltls--encryption-in-transit)
- [SASL Authentication](#sasl-authentication)
- [ACL Authorization](#acl-authorization)
- [Spring Boot: Security Configuration](#spring-boot-security-configuration)
- [Kafka với Confluent Schema Registry Security](#kafka-với-confluent-schema-registry-security)
- [Security Checklist](#security-checklist)

---

## Security Layers trong Kafka

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    KAFKA SECURITY MODEL                                         │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  Layer 1: ENCRYPTION (SSL/TLS)                                                  │
│  ─────────────────────────────                                                  │
│  • Data in transit được encrypt                                                 │
│  • Prevent man-in-the-middle attacks                                            │
│  • Client verifies broker identity                                              │
│                                                                                 │
│  Layer 2: AUTHENTICATION (SASL)                                                 │
│  ─────────────────────────────                                                  │
│  • "Who are you?" — Verify client identity                                      │
│  • Options: PLAIN, SCRAM-SHA-256, GSSAPI (Kerberos), OAUTHBEARER                │
│                                                                                 │
│  Layer 3: AUTHORIZATION (ACL)                                                   │
│  ─────────────────────────────                                                  │
│  • "What can you do?" — Control access                                          │
│  • Per-topic, per-group, per-user permissions                                   │
│  • Operations: READ, WRITE, CREATE, DELETE, DESCRIBE                            │
│                                                                                 │
│  Common Combinations:                                                           │
│  • Dev: No security (localhost only)                                            │
│  • Staging: SASL_PLAINTEXT (auth without TLS — fast)                            │
│  • Production: SASL_SSL (auth + encryption)                                     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## SSL/TLS — Encryption in Transit

### Tạo Certificates

```bash
# 1. Tạo CA (Certificate Authority)
keytool -genkey -keyalg RSA -keysize 2048 \
    -alias ca -keystore ca.keystore.jks \
    -storepass changeit -keypass changeit \
    -dname "CN=Kafka-CA, OU=Kafka, O=MyOrg, C=VN" \
    -validity 3650

keytool -export -alias ca \
    -keystore ca.keystore.jks \
    -file ca.crt -storepass changeit

# 2. Tạo broker keystore
keytool -genkey -keyalg RSA -keysize 2048 \
    -alias kafka-broker \
    -keystore kafka.keystore.jks \
    -storepass changeit -keypass changeit \
    -dname "CN=kafka-broker, OU=Kafka, O=MyOrg, C=VN" \
    -validity 365

# 3. Create CSR và sign với CA
keytool -certreq -alias kafka-broker \
    -keystore kafka.keystore.jks \
    -file kafka-broker.csr -storepass changeit

keytool -gencert -alias ca \
    -keystore ca.keystore.jks \
    -infile kafka-broker.csr \
    -outfile kafka-broker.crt \
    -storepass changeit -validity 365

# 4. Import CA + signed cert vào broker keystore
keytool -import -alias ca -file ca.crt \
    -keystore kafka.keystore.jks -storepass changeit -noprompt

keytool -import -alias kafka-broker -file kafka-broker.crt \
    -keystore kafka.keystore.jks -storepass changeit

# 5. Tạo client truststore (chứa CA cert)
keytool -import -alias ca -file ca.crt \
    -keystore kafka.truststore.jks -storepass changeit -noprompt
```

### Broker Configuration (server.properties)

```properties
# Listener config — SASL_SSL for external, PLAINTEXT for inter-broker
listeners=SASL_SSL://0.0.0.0:9093,PLAINTEXT://0.0.0.0:9092
advertised.listeners=SASL_SSL://kafka-broker:9093,PLAINTEXT://kafka-broker:9092
listener.security.protocol.map=SASL_SSL:SASL_SSL,PLAINTEXT:PLAINTEXT

# SSL settings
ssl.keystore.location=/etc/kafka/ssl/kafka.keystore.jks
ssl.keystore.password=changeit
ssl.key.password=changeit
ssl.truststore.location=/etc/kafka/ssl/kafka.truststore.jks
ssl.truststore.password=changeit
ssl.client.auth=required                   # Require client certificates (mTLS)
ssl.protocol=TLSv1.3
ssl.enabled.protocols=TLSv1.2,TLSv1.3
ssl.cipher.suites=TLS_AES_256_GCM_SHA384,TLS_CHACHA20_POLY1305_SHA256
```

---

## SASL Authentication

### SASL/PLAIN (Development friendly)

> [!WARNING]
> SASL/PLAIN gửi credentials không được mã hóa. **Chỉ dùng với SSL** hoặc trong development.

```properties
# broker: server.properties
sasl.enabled.mechanisms=PLAIN
sasl.mechanism.inter.broker.protocol=PLAIN

listener.name.sasl_ssl.plain.sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required \
    username="admin" \
    password="admin-secret" \
    user_admin="admin-secret" \
    user_producer="producer-secret" \
    user_consumer="consumer-secret";
```

### SASL/SCRAM-SHA-256 (Recommended)

SCRAM lưu credentials trong ZooKeeper/KRaft — không hardcode trong config files:

```bash
# Tạo users trong ZooKeeper
kafka-configs.sh --bootstrap-server localhost:9092 \
    --alter --add-config 'SCRAM-SHA-256=[iterations=8192,password=producer-secret]' \
    --entity-type users --entity-name producer-user

kafka-configs.sh --bootstrap-server localhost:9092 \
    --alter --add-config 'SCRAM-SHA-256=[iterations=8192,password=consumer-secret]' \
    --entity-type users --entity-name consumer-user

# Xem users
kafka-configs.sh --bootstrap-server localhost:9092 \
    --describe --entity-type users
```

```properties
# broker: server.properties
sasl.enabled.mechanisms=SCRAM-SHA-256
sasl.mechanism.inter.broker.protocol=SCRAM-SHA-256

listener.name.sasl_ssl.scram-sha-256.sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required \
    username="broker-user" \
    password="broker-secret";
```

### SASL/OAUTHBEARER (Modern — OAuth 2.0 / JWT)

```properties
# broker: server.properties
sasl.enabled.mechanisms=OAUTHBEARER
sasl.oauthbearer.jwks.endpoint.url=https://auth.mycompany.com/.well-known/jwks.json
sasl.oauthbearer.expected.audience=kafka-cluster

# Custom validator
listener.name.sasl_ssl.oauthbearer.sasl.server.callback.handler.class=\
    org.apache.kafka.common.security.oauthbearer.secured.OAuthBearerValidatorCallbackHandler
```

---

## ACL Authorization

### Kích hoạt ACL

```properties
# server.properties
authorizer.class.name=kafka.security.authorizer.AclAuthorizer
super.users=User:admin;User:kafka-broker
```

### Quản lý ACLs via CLI

```bash
# ─── Tạo ACLs ────────────────────────────────────────────────────────────────

# Producer: WRITE vào topic "orders"
kafka-acls.sh --bootstrap-server localhost:9093 \
    --command-config admin.properties \
    --add \
    --allow-principal User:producer-user \
    --operation Write \
    --operation Describe \
    --topic orders

# Consumer: READ từ topic "orders" với group "order-service"
kafka-acls.sh --bootstrap-server localhost:9093 \
    --command-config admin.properties \
    --add \
    --allow-principal User:consumer-user \
    --operation Read \
    --operation Describe \
    --topic orders

kafka-acls.sh --bootstrap-server localhost:9093 \
    --command-config admin.properties \
    --add \
    --allow-principal User:consumer-user \
    --operation Read \
    --group order-service

# Admin: Full access với prefix "ops-"
kafka-acls.sh --bootstrap-server localhost:9093 \
    --command-config admin.properties \
    --add \
    --allow-principal User:ops-user \
    --operation All \
    --topic '*' \
    --resource-pattern-type prefixed

# ─── Xem ACLs ─────────────────────────────────────────────────────────────────
kafka-acls.sh --bootstrap-server localhost:9093 \
    --command-config admin.properties \
    --list --topic orders

# ─── Xóa ACLs ─────────────────────────────────────────────────────────────────
kafka-acls.sh --bootstrap-server localhost:9093 \
    --command-config admin.properties \
    --remove \
    --allow-principal User:producer-user \
    --operation Write \
    --topic orders
```

### ACL Permission Matrix

| Principal | Topics | Operations | Groups |
|-----------|--------|-----------|--------|
| `order-producer` | `orders` | WRITE, DESCRIBE | — |
| `order-consumer` | `orders` | READ, DESCRIBE | `order-service` READ |
| `analytics-consumer` | `orders`, `payments` | READ | `analytics-group` READ |
| `kafka-connect` | `orders-*`, `connect-*` | ALL | `connect-cluster` ALL |
| `admin` | `*` | ALL | `*` ALL |

---

## Spring Boot: Security Configuration

### SASL_SSL Producer/Consumer

```yaml
spring:
  kafka:
    bootstrap-servers: kafka-broker:9093
    security:
      protocol: SASL_SSL

    ssl:
      trust-store-location: classpath:ssl/kafka.truststore.jks
      trust-store-password: ${KAFKA_TRUSTSTORE_PASSWORD}
      trust-store-type: JKS
      # Optional: mTLS (client certificate)
      key-store-location: classpath:ssl/kafka.keystore.jks
      key-store-password: ${KAFKA_KEYSTORE_PASSWORD}
      key-password: ${KAFKA_KEY_PASSWORD}

    properties:
      sasl.mechanism: SCRAM-SHA-256
      sasl.jaas.config: >
        org.apache.kafka.common.security.scram.ScramLoginModule required
        username="${KAFKA_USERNAME}"
        password="${KAFKA_PASSWORD}";
```

### Java Config (Programmatic)

```java
@Configuration
public class KafkaSecurityConfig {

    @Value("${kafka.username}")
    private String username;

    @Value("${kafka.password}")
    private String password;

    @Value("${kafka.truststore.path}")
    private String truststorePath;

    @Value("${kafka.truststore.password}")
    private String truststorePassword;

    @Bean
    public Map<String, Object> kafkaSecurityProps() {
        Map<String, Object> props = new HashMap<>();

        props.put(CommonClientConfigs.SECURITY_PROTOCOL_CONFIG, "SASL_SSL");
        props.put(SaslConfigs.SASL_MECHANISM, "SCRAM-SHA-256");
        props.put(SaslConfigs.SASL_JAAS_CONFIG, String.format(
            "org.apache.kafka.common.security.scram.ScramLoginModule required " +
            "username=\"%s\" password=\"%s\";",
            username, password
        ));

        // SSL
        props.put(SslConfigs.SSL_TRUSTSTORE_LOCATION_CONFIG, truststorePath);
        props.put(SslConfigs.SSL_TRUSTSTORE_PASSWORD_CONFIG, truststorePassword);
        props.put(SslConfigs.SSL_PROTOCOL_CONFIG, "TLSv1.3");

        return props;
    }

    @Bean
    public ProducerFactory<String, String> producerFactory(
            @Autowired Map<String, Object> kafkaSecurityProps) {

        Map<String, Object> configs = new HashMap<>();
        configs.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9093");
        configs.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        configs.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        configs.putAll(kafkaSecurityProps);

        return new DefaultKafkaProducerFactory<>(configs);
    }
}
```

### Environment Variables (12-factor app)

```bash
# .env hoặc Kubernetes Secrets
KAFKA_USERNAME=order-service
KAFKA_PASSWORD=super-secret-password
KAFKA_TRUSTSTORE_PASSWORD=truststore-pass
KAFKA_KEYSTORE_PASSWORD=keystore-pass
KAFKA_KEY_PASSWORD=key-pass
```

```yaml
# kubernetes/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: kafka-credentials
type: Opaque
stringData:
  username: order-service
  password: super-secret-password
---
apiVersion: v1
kind: Secret
metadata:
  name: kafka-ssl
type: Opaque
data:
  kafka.truststore.jks: <base64-encoded-truststore>
  kafka.keystore.jks: <base64-encoded-keystore>
```

---

## Kafka với Confluent Schema Registry Security

```yaml
# Schema Registry cũng cần auth khi Kafka secured
spring:
  kafka:
    properties:
      schema.registry.url: https://schema-registry:8081
      basic.auth.credentials.source: USER_INFO
      basic.auth.user.info: ${SR_USERNAME}:${SR_PASSWORD}
      # Nếu SR dùng SSL
      schema.registry.ssl.truststore.location: /path/to/truststore.jks
      schema.registry.ssl.truststore.password: ${SR_TRUSTSTORE_PASSWORD}
```

---

## Security Checklist

```
✅ ENCRYPTION
   [ ] TLS 1.2+ enabled, TLS 1.0/1.1 disabled
   [ ] Strong cipher suites configured
   [ ] Certificates từ trusted CA
   [ ] Certificate rotation plan (annually)
   [ ] Inter-broker encryption (nếu trong multi-datacenter)

✅ AUTHENTICATION
   [ ] SASL enabled (SCRAM hoặc OAuth)
   [ ] Không dùng PLAIN trong production
   [ ] Credentials không hardcode trong config files
   [ ] Credentials từ secrets manager (Vault, K8s Secrets)
   [ ] Service accounts riêng cho mỗi microservice

✅ AUTHORIZATION
   [ ] ACL enabled (authorizer.class.name configured)
   [ ] Principle of Least Privilege — chỉ grant quyền cần thiết
   [ ] Không dùng super.users trừ admin tools
   [ ] Review và audit ACLs định kỳ
   [ ] Document ACL matrix (ai access gì)

✅ NETWORK
   [ ] Kafka brokers trong private network
   [ ] Firewall rules — chỉ cho phép trusted clients
   [ ] VPC peering hoặc PrivateLink cho cross-account
   [ ] No public internet access to brokers

✅ AUDIT & COMPLIANCE
   [ ] Enable audit logging (log.authorizer.class)
   [ ] Monitor unauthorized access attempts
   [ ] Log retention cho compliance (SOC2, PCI-DSS)
   [ ] Regular security reviews
```

<Cards>
  <Card title="Monitoring" href="/operations/monitoring/" description="Prometheus alerts, consumer lag, broker health" />
  <Card title="Performance Tuning" href="/operations/performance-tuning/" description="Throughput vs Latency config profiles" />
  <Card title="Docker Setup" href="/setup/docker-setup/" description="Local development Kafka với Docker" />
</Cards>
