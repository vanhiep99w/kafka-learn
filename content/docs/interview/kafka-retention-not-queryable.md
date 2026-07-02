---
title: "Vì sao Kafka 'xóa' message sau retention thay vì query lại được? — Deep Dive"
description: "Câu hỏi phỏng vấn: vì sao Kafka không cho query lại message đã quá retention? Mổ xẻ chi tiết mô hình commit log append-only, vì sao phải có retention, log compaction giữ bản cuối mỗi key, vì sao offset là con trỏ chứ không phải query key, và kịch bản thực tế team dùng Kafka làm database rồi mất data."
---

## Mục lục

- [Câu hỏi phỏng vấn](#1-câu-hỏi-phỏng-vấn)
- [Câu trả lời 30 giây](#2-câu-trả-lời-30-giây)
- [Bắt đầu từ: Kafka lưu dữ liệu như thế nào](#3-bắt-đầu-từ-kafka-lưu-dữ-liệu-như-thế-nào)
- [Vì sao Kafka phải xóa message (retention)](#4-vì-sao-kafka-phải-xóa-message-retention)
- [Hai chế độ cleanup: delete vs compact](#5-hai-chế-độ-cleanup-delete-vs-compact)
- [Log Compaction: giữ 'bản cuối' thay vì giữ mọi thứ](#6-log-compaction-giữ-bản-cuối-thay-vì-giữ-mọi-thứ)
- [Offset là con trỏ, không phải query key](#7-offset-là-con-trỏ-không-phải-query-key)
- [Kafka vs RabbitMQ vs Database — so sánh mô hình](#8-kafka-vs-rabbitmq-vs-database--so-sánh-mô-hình)
- [Tình huống thực tế: Dùng Kafka làm database → mất data](#9-tình-huống-thực-tế-dùng-kafka-làm-database--mất-data)
- [Câu hỏi đào sâu](#10-câu-hỏi-đào-sâu)
- [Tóm tắt — Cheat sheet & 3 nguyên tắc](#11-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Câu hỏi phỏng vấn

> *"Em tưởng Kafka là message queue lưu mọi thứ. Hôm qua em cần 'replay' lại data 2 tuần trước để tính lại báo cáo, nhưng Kafka báo offset không còn tồn tại — **data đã bị xóa** sau 7 ngày retention. Vì sao Kafka không cho query lại message cũ? Làm sao tránh bị mất data như vậy?"*

Câu hỏi này kiểm tra một điều: bạn có hiểu Kafka là **commit log** (dòng chảy dữ liệu, có thời gian sống) chứ không phải **database** (kho lưu trữ truy vấn được).

> [!IMPORTANT]
> Kafka là **commit log append-only**: mỗi partition là một file log tuần tự, message được **thêm vào cuối** và **bộ xóa dọn theo thời gian** (retention) hoặc **theo key** (compaction) dọn message cũ. Kafka **không có engine truy vấn** như database — bạn chỉ có thể **đọc tuần tự từ offset**, và offset cũ bị xóa theo retention. Đây là **thiết kế cố ý** để đổi lấy throughput cao, không phải thiếu sót.

---

## 2. Câu trả lời 30 giây

> Kafka là **commit log**, không phải database. Mỗi partition là một file log append-only; message cũ bị **retention** xóa theo thời gian (mặc định 7 ngày) hoặc kích thước. Đọc duy nhất theo **offset tuần tự** — không có `WHERE`, không có index second-key. Retention tồn tại vì nếu giữ mãi, **đĩa đầy → broker chết**; Kafka tối ưu cho **luồng dữ liệu**, không cho **kho lưu trữ**.
>
> Nếu cần truy cập data lâu: (1) **tăng retention** (`retention.ms`), (2) **dùng log compaction** (`cleanup.policy=compact`) để giữ bản mới nhất mỗi key (giống table), (3) **sink xuống database/data lake** (Postgres, S3) qua Kafka Connect, dùng Kafka cho luồng chứ không cho lưu trữ.

---

## 3. Bắt đầu từ: Kafka lưu dữ liệu như thế nào

Trước khi trả lời "vì sao xóa", phải hiểu "Kafka lưu như gì". Một partition trong Kafka là một **file log append-only** — message chỉ được **thêm vào cuối**, không bao giờ sửa, không bao giờ xóa chủ động:

```
Partition 0 (commit log):

   offset 0   offset 1   offset 2   offset 3   offset 4   ...
  ┌──────────┬──────────┬──────────┬──────────┬──────────┬─────┐
  │  msg 0   │  msg 1   │  msg 2   │  msg 3   │  msg 4   │ ... │  ← chỉ append vào cuối
  └──────────┴──────────┴──────────┴──────────┴──────────┴─────┘
     ↑                                                    ↑
   cũ nhất                                          mới nhất (LEO)

   ❌ Không có index theo value (không thể search "message có orderId=123")
   ❌ Không có WHERE / SELECT
   ✅ Chỉ đọc tuần tự từ một offset
```

### So sánh với database

| Đặc tính | Database | Kafka |
|----------|----------|-------|
| Mô hình | B-tree / hash index | Append-only log |
| Ghi | Ghi vào vị trí do index quyết định | Append vào cuối |
| Truy vấn | `SELECT * WHERE ...` | Đọc tuần tự từ offset |
| Sửa | `UPDATE` in-place | **Không sửa** — chỉ append |
| Xóa | `DELETE` chủ động | Tự động theo retention |
| Tìm theo field | ✅ Multi-key index | ❌ Chỉ theo offset |

> [!NOTE]
> Bạn **không thể** "select message có orderId=123" trong Kafka. Bạn chỉ có thể consume tuần tự từ đầu (nếu còn trong retention) và tự filter. Đây không phải hạn chế kỹ thuật, mà là **thiết kế** để đạt throughput cao: ghi tuần tự nhanh hơn ghi random hàng nghìn lần.

### Vì sao append-only lại nhanh?

Ổ đĩa ghi tuần tự (sequential) nhanh hơn ghi ngẫu nhiên (random) hàng nghìn lần. Database phải ghi random (vì index quyết định vị trí), Kafka ghi tuần tự (luôn vào cuối) → Kafka nhanh hơn nhiều. Nhưng đổi lại: không có index → không query → không lưu mãi (vì log sẽ dài vô tận).

---

## 4. Vì sao Kafka phải xóa message (retention)

Nếu Kafka giữ mọi message mãi mãi,会发生 gì?

```
Giả sử Kafka KHÔNG xóa message:
   • Đĩa đầy dần → broker crash
   • Consumer mới phải đọc từ offset 0 → hàng TB dữ liệu → không khả thi
   • Replication bandwidth tăng vô hạn
   → Kafka mất đặc tính "luồng dữ liệu nhanh"

Thiết kế: Kafka tối ưu cho "đọc gần đây, ghi nhanh"
         KHÔNG cho "lưu vĩnh viễn, truy vấn tùy ý"
```

Vì vậy Kafka có cơ chế **retention** — tự động xóa message cũ theo thời gian hoặc kích thước:

```diagram
Topic: events (retention.ms = 604800000  → 7 ngày)

   T = hôm nay
   ├─ message offset 10000 ─────────────────── còn ✅ (mới 1 ngày)
   ├─ message offset 5000  ─────────────────── còn ✅ (mới 5 ngày)
   ├─ message offset 100   ─────────────────── còn ✅ (mới 6 ngày)
   ├─ message offset 50    ─────────────────── XÓA ❌ (đã 8 ngày)
   └─ message offset 0     ─────────────────── XÓA ❌ (đã 10 ngày)

   → consumer mới reset về offset 0 → OffsetOutOfRangeException!
   → offset 0 đến 49 đã bị dọn dẹp, không còn tồn tại
```

### Các thông số retention

| Tham số | Ý nghĩa | Mặc định |
|---------|---------|----------|
| `retention.ms` | Xóa message cũ hơn N mili-giây | 604800000 (7 ngày) |
| `retention.bytes` | Xóa khi partition lớn hơn N byte | -1 (vô hạn) |
| `segment.bytes` | Kích thước mỗi segment log | 1073741824 (1GB) |

> [!CAUTION]
> Mặc định `retention.ms = 7 ngày`. Nếu topic có traffic cao, **7 ngày đã có thể hàng chục GB**. Người mới thường bất ngờ vì tưởng Kafka lưu mãi. **Luôn set retention rõ ràng** khi tạo topic production.

---

## 5. Hai chế độ cleanup: delete vs compact

Kafka có 2 chế độ dọn dẹp message cũ, lựa chọn theo use case:

| Cleanup policy | Config | Hành vi | Dùng khi |
|----------------|--------|---------|----------|
| **`delete`** (mặc định) | `cleanup.policy=delete` | Xóa message cũ theo thời gian/kích thước | Event stream, log |
| **`compact`** | `cleanup.policy=compact` | Giữ bản mới nhất mỗi **key**, xóa bản cũ | State, "table" |
| **`delete,compact`** | Cả hai | Vừa compact vừa xóa sau retention dài | Linh hoạt |

### Khi nào dùng delete, khi nào dùng compact?

**`delete`** — phù hợp cho **event stream** (sự kiện phát sinh theo thời gian):
- Topic `order-events`: mỗi order tạo event `created`, `paid`, `shipped`. Mỗi event là một факт đã xảy ra, cần giữ **đầy đủ lịch sử** trong một khoảng thời gian, rồi xóa.
- Sau 7 ngày, event cũ không còn giá trị nghiệp vụ → xóa để tiết kiệm đĩa.

**`compact`** — phù hợp cho **state** (trạng thái hiện tại của một entity):
- Topic `user-state`: mỗi user có profile `{name, age, email}`. Khi user cập nhật, ta ghi message mới với cùng key `user_id`. Ta chỉ quan tâm **trạng thái mới nhất**, không cần lịch sử.
- Compaction giữ đúng bản cuối cùng của mỗi key, xóa các bản cũ hơn → giống một "table" trong database.

> [!TIP]
> Quy tắc chọn: **cần lịch sử đầy đủ** (audit, replay) → `delete`. **Chỉ cần trạng thái cuối** (current state, lookup) → `compact`. Nhiều topic thực tế dùng `delete,compact` để có cả hai (compact để giữ state, delete để giới hạn kích thước).

---

## 6. Log Compaction: giữ 'bản cuối' thay vì giữ mọi thứ

Với topic có **key** (như `user_id`), bạn thường chỉ quan tâm **trạng thái mới nhất** của mỗi key. **Log compaction** giữ đúng điều đó: với mỗi key, chỉ giữ **message mới nhất**, xóa các bản cũ hơn.

### Minh họa trước/sau compaction

```
Topic: user-state (cleanup.policy=compact)

TRƯỚC compaction (mọi message đều còn):
[key=user-1] {name:A, age:20}   offset 10
[key=user-2] {name:B, age:30}   offset 11
[key=user-1] {name:A, age:21}   offset 12   ← user-1 cập nhật
[key=user-3] {name:C, age:40}   offset 13
[key=user-1] {name:A, age:22}   offset 14   ← user-1 cập nhật lần nữa
[key=user-2] {name:B, age:31}   offset 15   ← user-2 cập nhật

SAU compaction (mỗi key chỉ giữ bản cuối):
[key=user-2] {name:B, age:31}   offset 15   ← bản cuối của user-2
[key=user-3] {name:C, age:40}   offset 13
[key=user-1] {name:A, age:22}   offset 14   ← bản cuối của user-1
   (các bản cũ user-1 offset 10, 12 bị xóa)
   (các bản cũ user-2 offset 11 bị xóa)
```

### Đây chính là cách `__consumer_offsets` không phình

Topic nội bộ `__consumer_offsets` dùng **compact** — với mỗi key `(group, topic, partition)`, chỉ giữ offset mới nhất. Nếu không có compaction, topic này sẽ phình vô hạn (mỗi commit ghi thêm 1 message). Nhờ compaction, nó chỉ giữ **1 bản offset cuối cho mỗi key**.

> [!NOTE]
> Log compaction biến Kafka thành một dạng **key-value store có thời gian khởi động** — bạn có thể tạo consumer group mới, đọc từ đầu (earliest), và "xây lại trạng thái" đầy đủ từ các bản cuối cùng của mỗi key. Đây là nền tảng của Kafka Streams **global tables** và **schema registry**.

### Trade-off delete vs compact

| Yếu tố | `delete` | `compact` |
|--------|----------|-----------|
| Giữ lịch sử | ✅ Toàn bộ (trong retention) | ❌ Chỉ bản cuối mỗi key |
| Phù hợp | Event log, audit | State, "table" |
| Chi phí đĩa | Cao (mọi message) | Thấp hơn (chỉ bản cuối) |
| Có query theo key | ❌ | ✅ Tái tạo state được |

---

## 7. Offset là con trỏ, không phải query key

Một hiểu lầm phổ biến: tưởng offset giống primary key, có thể "select offset=1234". **Không**.

```diagram
Database:  SELECT * FROM orders WHERE id = 1234    ← query được (có index)

Kafka:     consumer.seek(partition, 1234)           ← chỉ "nhảy đến vị trí"
           rồi poll tuần tự từ đó
           ❌ không có "select offset = 1234" trả về 1 record
```

Offset là **vị trí trong log** — như số byte trong file. Bạn có thể "seek" tới đó rồi đọc tuần tự, nhưng có 2 hạn chế:

**Hạn chế 1 — Offset phải còn tồn tại.** Nếu đã bị retention xóa, `seek` ném `OffsetOutOfRangeException`:

```
consumer.seek(partition, 50)  →  OffsetOutOfRangeException
   ↑ offset 50 đã bị retention xóa (chỉ còn offset 100 trở đi)
   → KHÔNG CÓ CÁCH NÀO lấy lại message này từ Kafka
```

**Hạn chế 2 — Không có index ngược.** Không thể "tìm message có orderId=X" nếu không scan toàn bộ log. Kafka không lưu index theo value, chỉ theo offset.

> [!IMPORTANT]
> Đây là lý do "replay data 2 tuần trước" thường thất bại: nếu offset đó đã bị xóa, không còn cách nào lấy lại từ Kafka. Phải lấy từ **sink** (database, S3, data lake) — đó là vai trò của Kafka Connect (mục 9).

---

## 8. Kafka vs RabbitMQ vs Database — so sánh mô hình

Để hiểu rõ vị trí của Kafka, hãy so sánh với 2 hệ thống quen thuộc:

| Đặc tính | RabbitMQ | Kafka | Database |
|----------|----------|-------|----------|
| Mô hình | Queue (message bị xóa sau khi ack) | Commit log (giữ theo retention) | B-tree / hash |
| Đọc lại message cũ | ❌ (đã ack = mất) | ✅ (trong retention) | ✅ Vĩnh viễn |
| Query theo field | ❌ | ❌ | ✅ |
| Sửa (update) | ❌ | ❌ (chỉ append) | ✅ |
| Throughput | Trung bình | Rất cao | Thấp hơn |
| Mục đích | Pub/Sub, task queue | **Event streaming** | **Lưu trữ + query** |

### Vị trí của mỗi hệ thống

```
RabbitMQ  ──── message "biến mất" sau khi xử lý (queue rỗng)
     │         → phù hợp: task queue, RPC, notification
     │
Kafka    ──── message "sống" theo retention (commit log có thời hạn)
     │         → phù hợp: event streaming, log aggregation, real-time pipeline
     │
Database ──── message "vĩnh viễn", query được (kho lưu trữ)
               → phù hợp: OLTP, reporting, source of truth cho quá khứ
```

> [!NOTE]
> Kafka **giữa** RabbitMQ và database: sống lâu hơn queue (có retention), nhưng không vĩnh viễn + query như database. Đây là **vị trí thiết kế cố ý**: đủ lâu để consumer downtime rồi đọc lại, đủ ngắn để không nghẽn đĩa. Hiểu đúng vị trí này để không lạm dụng Kafka làm database.

---

## 9. Tình huống thực tế: Dùng Kafka làm database → mất data

### Bối cảnh

Team xây hệ thống analytics. Vì nghe nói "Kafka replay được", họ quyết định **KHÔNG sink** xuống database, chỉ giữ mọi thứ trong Kafka topic `events` (retention mặc định 7 ngày). Lý do: "lười maintain Postgres, Kafka đủ rồi".

### Sự cố tháng 3

Quý 1 kết thúc, team cần **tính lại báo cáo** với logic mới. Yêu cầu: replay toàn bộ event tháng 1–2 (~60 ngày).

```
Team: consumer.seek(events, offset_đầu_tháng_1)
Kafka: OffsetOutOfRangeException
       → offset đó đã bị retention xóa (chỉ còn 7 ngày gần nhất)

Hậu quả: KHÔNG THỂ replay tháng 1–2
         báo cáo Q1 tính lại bằng... "ước lượng"
         mất uy tín với stakeholder
```

### Phân tích: sai ở đâu?

```
❌ SAI:  Kafka topic (retention 7 ngày) = nguồn dữ liệu duy nhất
         → data cũ bị xóa, không lấy lại được

✅ ĐÚNG: Pipeline đúng vai trò:
         Producer → Kafka (retention ngắn, luồng)
                → Kafka Connect sink → Postgres / S3 (lưu trữ vĩnh viễn)
                                   → query lại được bao lâu tùy thích

   Replay logic:
   • dữ liệu < 7 ngày  → replay từ Kafka (nhanh, vì Kafka còn giữ)
   • dữ liệu > 7 ngày  → query từ sink (Postgres/S3)
```

### Các pattern phòng tránh mất data

| Use case | Lời giải pháp |
|----------|---------------|
| Cần replay data lâu | Sink xuống data lake (S3, BigQuery) qua Kafka Connect |
| Cần trạng thái mới nhất mỗi key | Dùng `cleanup.policy=compact` |
| Cần tăng window replay | Tăng `retention.ms` (đắt hơn đĩa) |
| Cần query theo field | Sink xuống database, query ở đó |

> [!WARNING]
> Quy tắc vàng: **Kafka là luồng, không phải kho**. Nếu có khả năng cần data sau retention — sink nó. Đừng mặc định "Kafka lưu mãi mãi", đó là hiểu lầm phổ biến và tốn kém nhất với người mới.

---

## 10. Câu hỏi đào sâu

> **"Vì sao không tăng retention lên vô hạn luôn?"**
> Đĩa sẽ đầy. Một topic 100MB/s × retention 1 năm = ~3 PB mỗi partition. Chưa kể replication traffic tăng theo. Kafka tối ưu cho "đọc gần đây nhanh" — giữ mãi phá vỡ thiết kế đó. Nếu cần lâu, sink xuống storage rẻ (S3) thay vì giữ trong Kafka.

> **"Log compaction có biến Kafka thành database không?"**
> Một phần — nó cho phép tái tạo state từ key, giống table. Nhưng vẫn không có query theo value (`WHERE name LIKE ...`). Kafka Streams KTable cung cấp layer giống table hơn, nhưng dưới nền vẫn là log. Nếu cần SQL query, sink xuống database thật.

> **"Có cách nào backup Kafka để khôi phục data đã xóa không?"**
> Có — nhưng nên tránh dựa vào đó. Các cách: replicate topic sang cluster khác với retention dài hơn, hoặc dùng Kafka Connect backup sang S3. Tuy nhiên, đây là **biện pháp phòng hờ**, không thay thế việc **sink** data cần query vào database/data lake ngay từ đầu.

> **"Tăng `retention.ms` có ảnh hưởng performance không?"**
> Có, nhẹ. Nhiều data hơn = log segment lớn hơn = consumer mới đọc lâu hơn khi replay, page cache phải chứa nhiều hơn. Nhưng chủ yếu là **chi phí đĩa**. Đừng tăng retention chỉ vì "cho chắc" — sink data lâu xuống storage rẻ hiệu quả hơn.

---

## 11. Tóm tắt — Cheat sheet & 3 nguyên tắc

### Cheat sheet

```
╔═══════════════════════════════════════════════════════════════╗
║  Kafka = COMMIT LOG, không phải database                      ║
║  ───────────────────────────────────────────────────────────  ║
║  • Append-only, đọc theo offset tuần tự                       ║
║  • Không có WHERE / SELECT / UPDATE                           ║
║  • Message cũ bị retention XÓA (mặc định 7 ngày)              ║
║  ───────────────────────────────────────────────────────────  ║
║  cleanup.policy:                                              ║
║   • delete   → xóa theo thời gian (event log)                 ║
║   • compact  → giữ bản cuối mỗi key (state/table)             ║
║  ───────────────────────────────────────────────────────────  ║
║  Cần data lâu? SINK XUỐNG database/S3 qua Kafka Connect.      ║
║  Đừng dùng Kafka làm kho lưu trữ vĩnh viễn.                   ║
╚═══════════════════════════════════════════════════════════════╝
```

### 3 nguyên tắc áp dụng ngay

> [!IMPORTANT]
> **1. Kafka là luồng, không phải kho. Hãy sink.**
> Nếu có khả năng cần data sau retention (replay, báo cáo, audit), **sink ngay** xuống Postgres/S3/data lake qua Kafka Connect. Đừng giữ Kafka là nguồn dữ liệu duy nhất cho quá khứ xa.
>
> **2. Chọn đúng cleanup policy theo use case.**
> Event log/audit → `delete` với retention phù hợp. State/table (user profile, config) → `compact` để giữ bản cuối mỗi key. Không chọn default "cho nhẹ" rồi hối hận.
>
> **3. Set retention chủ động, đừng dùng default.**
> Mặc định 7 ngày — có thể quá ngắn (mất data cần replay) hoặc quá dài (tốn đĩa). Tính toán: traffic × retention = storage ước tính, set rõ ràng khi tạo topic. Monitor partition size để không bất ngờ.

### Quote cuối

> Kafka giống một **dòng chảy** — dữ liệu chảy qua, bạn có lấy lại nếu kịp (trong retention), nhưng không thể lấy lại thứ đã chảy qua lâu rồi. Database mới là **hồ chứa** — giữ dữ liệu vĩnh viễn, query lúc nào cũng được. Hiểu rõ ranh giới này, bạn sẽ dùng Kafka đúng chỗ (luồng sự kiện) và không lạm dụng nó làm kho dữ liệu — và không bao giờ bất ngờ khi "offset đã bị xóa".

<Cards>
  <Card title="Topics và Partitions" href="/core-concepts/topics-partitions/" description="Log segments, retention policies và cấu hình topic" />
  <Card title="Offset Management" href="/core-concepts/offsets/" description="Topic __consumer_offsets và log compaction giữ offset mới nhất" />
  <Card title="Brokers & Cluster" href="/core-concepts/brokers-cluster/" description="Cấu hình retention, log.dirs và storage ở tầng broker" />
</Cards>
