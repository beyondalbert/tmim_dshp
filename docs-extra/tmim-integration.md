# tm_im 管理后台 API（`/v1/admin`）

> 这份文档是**管理后台**的完整契约。后台是**另一个 JAR**（`tm-admin.jar`）、
> 另一个端口、另一套凭证体系：它与用户端的 `/v1` 不共享任何东西
> （DESIGN §13.2 讲了为什么必须如此）。用户端的契约见
> [03-rest-api.md](03-rest-api.md)。

---

## 1. 覆盖范围

| 覆盖 | 不覆盖 |
|---|---|
| `/v1/admin/**` 的全部端点、参数、响应字段 | 用户端 `/v1/**`（见 [03-rest-api.md](03-rest-api.md)） |
| 后台的认证与会话（`adm_` 前缀） | 用户端 JWT / Agent api_key（见 [02-auth.md](02-auth.md)） |
| 后台权限分级（SUPER / OPS） | 长连接协议（见 [04-realtime.md](04-realtime.md)） |
| 审计日志的查询口径 | 审计的归档与清理（那是 DBA 的动作，**没有** HTTP 接口） |

**谁会用这份文档**：写后台界面的人、写自动化运维脚本的人、以及排查
「某个运营动作到底发生了什么」的人（后者看 §6 的审计字段）。

> **一句话区分两个后台概念**：`admin_user` 是**运维账号**（能封号、能删帖），
> `actor` 是**用户/Actor 身份**（发消息、加好友）。它们在一套系统里，
> 但是两张互不相干的表。后台账号 **不是** 一个 `actor`，
> 所以它不会出现在参与者列表里。

---

## 2. 认证

### 2.1 登录

```
POST /v1/admin/auth/login
Content-Type: application/json

{ "username": "ops_zhang", "password": "…" }
```

响应里的 `token` 是**库里的会话**（`admin_session`），形如
`adm_` + 32 位随机串。之后的每个请求都带上它：

```
Authorization: Bearer adm_Y6TVWeh8bTOTKyGpYDMFJoclyIN2b94D5plNS2ihayA
```

### 2.2 为什么不是 JWT

用户端的 JWT 是**无状态**的：签发之后服务端无法让它失效。后台不能这样——
「停用一个后台账号」必须**立刻**生效，否则被停用的人还能继续封号到 token 过期
（默认 2 小时）。所以后台的凭证是库里的一行：

| | 用户端 | 后台 |
|---|---|---|
| 凭证 | JWT（无状态） | `adm_…` → `admin_session` 表的一行 |
| 有效期 | 2 小时 | **8 小时**（`tm.admin.session-ttl`） |
| 提前失效 | 做不到 | 登出 / 停用账号 / 删行，**立刻**生效 |
| 库里存什么 | 不存 | 只存 `SHA-256(凭证)`，泄漏库也拿不到可用凭证 |

**停用账号会连带删掉它的全部会话**（同一个事务）。所以「停用」的语义是
「立刻没有权限」，而不是「下次登录时会被拒」。

### 2.3 登录失败与锁定

| 行为 | 结果 |
|---|---|
| 用户名不存在 | `40101`（与「口令不对」**不可区分**——否则这个接口就是用户名枚举器） |
| 口令不对 | `40101`，`failed_attempts` +1，写一条 `ADMIN_LOGIN_FAILED` 审计 |
| 连续失败 5 次（`tm.admin.max-login-failures`） | 锁定 15 分钟（`tm.admin.lockout-duration`），期间一律 `42901` |
| 账号已停用 | `40301`（**先判停用再判口令**，所以停用账号不会因为口令错而回 40101） |
| 锁定到期 | 计数**清零**后重新给 5 次机会（不是「再差一次就再锁」） |

失败计数落在**库**里（`admin_user.failed_attempts` / `locked_until`），
不是进程内存：多实例部署时内存计数等于每个实例各给 5 次机会。

### 2.4 权限分级

| 角色 | `role` | 能做什么 |
|---|---|---|
| SUPER | 1 | 全部，包含**管理后台账号** |
| OPS | 2 | 查参与者与注册用户、封禁、看内容、删帖、看消息、删消息、查审计；**读不到账号管理** |

判据只有一处：`AdminService#requireSuper`。写在各个控制器里的权限判断会随
接口数量增长而漏写一个，而漏写的那一个恰好就是越权入口。

唯一的例外是 `GET /v1/admin/me`：**OPS 也必须能读到「我是谁、我是什么角色」**，
否则前端无法隐藏它没有权限的入口（这一条曾经写错成 SUPER only，接口回 403，
排查方向会被带向「权限配置错了」）。

---

## 3. 通用约定

### 3.1 统一信封

与用户端逐字一致：

```json
{ "code": 0, "message": "ok", "data": { } }
```

```json
{ "code": 40302, "message": "permission denied", "data": null }
```

**成功判据只有 `code === 0`**。业务失败**也是 HTTP 200**（除了下面 §3.2 那几类），
因为用状态码承载业务语义会让反向代理/网关对 4xx 做重试与改写，
而「权限不够」这种失败重试一万次也不会成功。

> 响应里还有一个 `ok` 字段（`ApiResponse#isOk` 被序列化了）。它是**冗余的**，
> 客户端不该用它——判据只有 `code`。它留着是因为删掉它要动用户端已经在用的形状。

### 3.2 HTTP 状态码

只有认证、限流与服务端异常用非 200：

| HTTP | 什么时候 |
|---|---|
| 200 | 成功，以及全部**业务失败**（`400xx` / `404xx` / `409xx`） |
| 401 | `40101`–`40106`（凭证缺失/无效/过期） |
| 403 | `40301`–`40306`（账号停用、权限不够） |
| 429 | `42901`（锁定） |
| 404 | **路由**不存在（URL 写错），响应体仍是信封 |
| 405 | 方法不支持 |
| 500 | `50000` 未预期异常（**不带** 异常消息：它常含 SQL 片段与参数值） |

### 3.3 字段命名

一律 `snake_case`（`spring.jackson.property-naming-strategy: SNAKE_CASE`），
可空字段**仍然输出** `null`（不是省略）。客户端不要自己转成驼峰：
转了的后果是「服务端改了字段名」在前端表现为**某个单元格永远空白**，
不报错、不红、类型检查也通过。

### 3.4 时间

一律 ISO-8601 的 **Instant**（UTC，带 `Z`）：

```json
{ "created_at": "2026-09-28T03:58:54.208Z" }
```

它对应库里按 `tm.time.zone`（默认 `Asia/Shanghai`）写入的墙上时间。
客户端按本机时区显示即可。

### 3.5 id 是 64 位整数——在 JS 里必须按字符串处理

所有主键（`admin_id` / `actor_id` / `post_id` / `target_id` / 审计 `id`）都是
Snowflake 生成的 64 位整数，**18–19 位十进制**。而 JS 的 `number` 只能精确到
`2^53 - 1`（16 位）。真机上的一次对照：

```
服务端返回的原文   362810375490994176
JSON.parse 之后    362810375490994180     ← 最后两位被改写
```

后果不是「显示得难看」，而是**拿这个 id 去请求会查不到东西**：
`PATCH /v1/admin/accounts/{adminId}/status` 回 `40400`、
`GET /v1/admin/actors/{actorId}` 回 `40401`。界面上的表现是「目标不存在」，
看起来像数据问题，实际是精度问题。

所以 JS 客户端必须：
① 解析响应时把超长整数保真成字符串（`web/admin/src/api/json.ts` 就是这么做的）；
② 不要在表单里用「数字输入框」收 id（那种控件的值是 `number`）；
③ id 只做字符串比较与拼接，不要 `Number()` / `parseInt`。

> 这是**客户端**的义务，不是服务端的缺陷：JSON 的数字是十进制文本，
> 服务端序列化 `long` 的方式符合规范；是 JS 那一边没有 64 位整数类型。
> 未来若要让所有客户端都省掉这一步，只能由服务端显式把 id 序列化成字符串
> （那是一次跨端的契约变更，见 §8）。

### 3.6 分页：只有游标，没有总数

所有的列表接口形状一致：

```json
{ "items": [], "next_cursor": "362810375490994176", "has_more": true }
```

| 字段 | 含义 |
|---|---|
| `next_cursor` | 取下一页时原样传回 `cursor` 参数；`has_more=false` 时可能是 `null` |
| `has_more` | 是否还有下一页 |

**没有 `total`**，也没有 `page` / `size`：后台的列表是「按时间倒序的运维视图」，
算一次总数在百万行的表上是一次全表 count，而它对使用者没有决策价值
（没人会因为「共 9 万条」而改变动作）。界面上的正确形态是「加载更多」。

`limit` 缺省用服务端配置值，**越界会被夹取**（要 1000 条得到配置上限），
不是报错——报错会让客户端只为了翻页多写一次重试。

游标就是上一页最后一行的主键（`id` 降序）。所以：

| 现象 | 原因 |
|---|---|
| 翻页时插入了新行，第二页可能重复 | 游标是 `id < cursor`，新行 `id` 更大，不会影响已翻过的部分 |
| 游标格式不对 | `40010`（`invalid cursor`） |
| 把另一类列表的游标贴过来 | `40010`——每类列表的游标带自己的类型标签（`aact`/`ausr`/`aucv`/`alog`/`aadm`/`apst`/`arel`），形状相同而语义不同 |

消息列表是唯一的例外：它按 `seq` 游标（`msg` 类型），因为消息的定序键不是主键 `id`，
而是 `(conv_id, seq)` 里的 `seq`。它与用户端历史消息接口是**同一个游标类型**——两者是同一件事。

---

## 4. 端点一览

| 方法 | 路径 | 权限 | 用途 |
|---|---|---|---|
| GET | `/v1/admin/auth/captcha` | 公开 | **取一张图形验证码**（登录的前置，PNG 的 data URL） |
| POST | `/v1/admin/auth/login` | 公开 | 建立后台会话（**必须带图形验证码**） |
| POST | `/v1/admin/auth/logout` | 公开（凭证本身即入参） | 删除当前会话，幂等 |
| GET | `/v1/admin/me` | 任意管理员 | 当前身份与角色（OPS 也要能读） |
| GET | `/v1/admin/actors` | 任意管理员 | 参与者列表（人 + Agent，可按类型/状态/handle 前缀过滤） |
| GET | `/v1/admin/actors/{actorId}` | 任意管理员 | 参与者详情（开过 Agent 接管的账号多一段 `agent_takeover`） |
| PATCH | `/v1/admin/actors/{actorId}/status` | 任意管理员 | 封禁 / 解封——**M9 验收标准里的「可封禁」** |
| GET | `/v1/admin/users` | 任意管理员 | **注册用户列表**（只列人，可按状态/handle 前缀过滤） |
| GET | `/v1/admin/users/{actorId}` | 任意管理员 | **注册用户详情**（账号 + 是否设过口令 + 会话数） |
| DELETE | `/v1/admin/users/{actorId}` | SUPER | **删除一个注册用户**（不可恢复，理由必填） |
| DELETE | `/v1/admin/users` | SUPER | **批量删除注册用户**（`actor_ids` 逗号串，一次 ≤ 50 个） |
| GET | `/v1/admin/users/{actorId}/conversations` | 任意管理员 | **该用户参与的会话**（消息管理的入口） |
| GET | `/v1/admin/conversations/{convId}` | 任意管理员 | **会话详情**（类型/标题/成员数/最后 seq） |
| GET | `/v1/admin/conversations/{convId}/messages` | 任意管理员 | **会话消息**（按 seq 倒序，游标翻页） |
| DELETE | `/v1/admin/conversations/{convId}/messages/{seq}` | 任意管理员 | **删一条消息**（写审计） |
| GET | `/v1/admin/posts` | 任意管理员 | 最新动态列表 |
| DELETE | `/v1/admin/posts/{postId}` | 任意管理员 | 删帖（走作者删帖那条级联路径） |
| GET | `/v1/admin/audit-logs` | 任意管理员 | 审计查询——**M9 验收标准里的「可查日志」** |
| GET | `/v1/admin/accounts` | SUPER | 后台账号列表 |
| GET | `/v1/admin/accounts/{adminId}` | SUPER | 后台账号详情 |
| POST | `/v1/admin/accounts` | SUPER | 新建后台账号 |
| PATCH | `/v1/admin/accounts/{adminId}/status` | SUPER | 停用 / 启用（停用连带删会话） |
| GET | `/v1/admin/app-releases` | SUPER | 已发布的 App 版本列表（按 id 倒序分页） |
| POST | `/v1/admin/app-releases` | SUPER | **上传并发布一个 App 新版本**（multipart：APK + 版本号 + 强制标志） |
| PATCH | `/v1/admin/app-releases/{id}` | SUPER | **编辑已发布版本的元数据**（对外版本名 / 强制标志 / 发布说明；APK 字节不可变） |
| DELETE | `/v1/admin/app-releases/{id}` | SUPER | **删除一个已发布版本**（先删行、后删对象存储里的 APK 字节） |

**没有的端点，以及为什么**：

| 没有 | 理由 |
|---|---|
| `/v1/admin/agents` | Agent 与人在库里是同一张表的同一批行，`actor_type=2` 就是 Agent 列表。为它另开一组接口会把「对等」从后台这一侧破功 |
| `GET /v1/admin/messages`（全站消息检索） | 消息表按 `conv_id` 分片（`message_0..15`），不带分片键的查询是 16 张表广播 + 内存归并。要做「按关键词搜全站」得先有一张独立的检索表，那是另一个决定，而不是加一个查询参数 |
| `PATCH /v1/admin/conversations/{convId}/messages/{seq}`（改消息） | 改动用户内容会让「谁说的」失去意义。删除是明确的，编辑不是（与 `PATCH /v1/admin/posts/{postId}` 同理） |
| `DELETE /v1/admin/conversations/{convId}`（删会话） | 会话是别人消息的容器：删它会连带让群里所有人的历史一起消失，而目前没有任何一个运维场景需要它 |
| `DELETE /v1/admin/audit-logs` | 能被改动或删掉的审计只能证明「当时大概是这么回事」 |
| `DELETE /v1/admin/accounts` | 后台账号只停用不删除：审计里的 `admin_id` 要永远指得回一个名字 |
| `PATCH /v1/admin/posts/{postId}` | 审核改动用户内容会让「谁说的」失去意义。删除是明确的，编辑不是 |
| `DELETE /v1/admin/users/{actorId}/messages` | 删一个用户不会删他的**消息**：消息属于会话而不属于他一个人（见 §5.11）。要删某一条消息走 `/v1/admin/conversations/{convId}/messages/{seq}` |

---

## 5. 端点详情

### 5.0 图形验证码（登录的前置）

```
GET /v1/admin/auth/captcha
```

公开接口，**不需要凭证**（忘了口令、还没登录的人也要能取图）。

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "captcha_id": "cap_9Kd2mQ",
    "image": "data:image/png;base64,iVBORw0KGgo...",
    "expires_in": 300
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `captcha_id` | string | `cap_` 前缀；登录时原样传回 `captcha_id` |
| `image` | string | **完整的 data URL**（`data:image/png;base64,...`），直接放进 `<img src>` |
| `expires_in` | int | 存活秒数（`tm.captcha.ttl`，默认 300）；**不要拿它做倒计时**，到期回 `40016` |

答案是 `tm.captcha.length`（默认 4）位数字，存在 Redis 的 `tm:cap:{captcha_id}`
（明文，与 `tm:rt:*` 同级敏感：能读 Redis 的人可以绕过验证码）。
它与用户端的 `GET /v1/auth/captcha` **是同一套实现**（`core.captcha`），
字段名也逐字一致。

### 5.1 登录

```
POST /v1/admin/auth/login
```

```json
{
  "username": "ops_zhang",
  "password": "正确的口令",
  "captcha_id": "cap_9Kd2mQ...",
  "captcha_code": "7043"
}
```

`captcha_id` / `captcha_code` 来自 `GET /v1/admin/auth/captcha`（§5.0）。
**它们是必需的**：验证码校验排在**任何一次库操作之前**（与用户端登录同一取舍）——
否则一个机器人仍然能把每一次尝试打到数据库上。

| 情况 | 结果 |
|---|---|
| 缺 `username` / `password` | `40001` |
| 验证码不存在 / 已过期 / 已用过 / 填错 | `40016`（客户端动作都是「重新取一张图」） |
| 用户名不存在或口令不对 | `40101`（两者不区分：区分开就成了用户名枚举器） |
| 账号被停用 | `40301` |
| 连续失败已锁定 | `42901` |

**一个 `captcha_id` 只有一次机会**：服务端是读 + 删（`GETDEL`），所以填错之后
同一张图也就作废了——客户端必须重新取一张。`tm.captcha.enabled=false` 时
**只关校验**，取图接口与界面上的那一行照旧存在（界面不读服务端配置）。

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "token": "adm_Y6TVWeh8bTOTKyGpYDMFJoclyIN2b94D5plNS2ihayA",
    "expires_at": "2026-09-28T12:03:59.251Z",
    "admin": {
      "admin_id": "362810375490994176",
      "username": "ops_zhang",
      "display_name": "张运维",
      "role": 2,
      "status": 1,
      "created_at": "2026-09-01T02:00:00.000Z",
      "last_login_at": null
    }
  }
}
```

失败见 §2.3。

### 5.2 登出

```
POST /v1/admin/auth/logout
```

**不做鉴权**：凭证已失效也回成功。否则客户端会陷入「登出失败 → 不敢清本地状态
→ 拿着过期凭证继续请求」的循环。它只需要凭证本身能把那一行删掉。

### 5.3 当前身份

```
GET /v1/admin/me
```

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "admin_id": "362810375490994176",
    "username": "ops_zhang",
    "display_name": "张运维",
    "role": 2,
    "status": 1,
    "created_at": "2026-09-01T02:00:00.000Z",
    "last_login_at": "2026-09-28T03:58:54.208Z"
  }
}
```

### 5.4 参与者列表

```
GET /v1/admin/actors?limit=20&cursor=&actor_type=2&status=1&handle_prefix=bot_
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `limit` | int | 缺省用服务端配置；越界被夹取 |
| `cursor` | string | 上一页的 `next_cursor` |
| `actor_type` | int | `1`=人 `2`=Agent；**越界回 `40002`**（不是「不过滤」） |
| `status` | int | `1`=正常 `2`=已封禁 |
| `handle_prefix` | string | handle 前缀匹配 |

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "items": [
      {
        "actor_id": "362810375490994177",
        "actor_type": 2,
        "handle": "bot_helper",
        "display_name": "小助手",
        "avatar_url": null,
        "bio": "有问题找我",
        "status": 1,
        "created_at": "2026-09-20T07:11:02.000Z",
        "agent_takeover": {
          "enabled": true,
          "push_mode": 1,
          "endpoint_url": "https://agent.example.com/hook",
          "capabilities": "[\"text\",\"image\"]",
          "model_info": "gpt-x",
          "rate_limit": 60
        }
      }
    ],
    "next_cursor": "362810375490994177",
    "has_more": false
  }
}
```

排序：注册时间倒序（`id` 降序）。

### 5.5 参与者详情

```
GET /v1/admin/actors/{actorId}
```

形状 = 上面 `items` 里的一行。**详情不做权限分级**：能进后台就能看，
因为它读的是公开资料（handle / 昵称 / 简介）；需要限制的是写动作。

开过 Agent 接管的账号多一段 `agent_takeover`，从没开启过是 `null`——那是**展示差异**，
不是模型差异：后台没有「Agent 专属接口」，只有同一份数据上的一个可选字段。

> **后台不提供改接管的接口**：接管配置只有账号主人自己的 JWT 能改（DESIGN §11.5）。
> 运营能做的与用户管理一样：封禁/解封那个账号——而封禁会让接管密钥同样失效
> （鉴权读的是 `actor.status`）。

`actorId` 不存在 → `40401`。

### 5.6 封禁 / 解封

```
PATCH /v1/admin/actors/{actorId}/status
```

```json
{ "status": 2, "reason": "群发广告" }
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `status` | **是** | `1`=ACTIVE `2`=SUSPENDED；缺失回 `40001` |
| `reason` | 否 | 会写进审计的 `detail`。**建议必填**——事后只能靠它回答「这个人为什么被封」 |

`status` 写成可选是危险的：少一个字段就静默启用一个被封的号。
所以服务端要求它显式出现，界面上封禁也强制填理由。

**它写的是 `actor.status`——与用户端鉴权读的是同一列**，所以封禁立刻生效，
不需要任何同步机制（下一次请求就会被拒，回 `40301`）。

响应是更新后的参与者视图。

### 5.7 动态列表

```
GET /v1/admin/posts?limit=20&cursor=
```

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "items": [
      {
        "post_id": "362810375490994180",
        "author_id": "362810375490994177",
        "content": "今天上线了",
        "visibility": 1,
        "like_count": 3,
        "comment_count": 1,
        "created_at": "2026-09-27T09:00:00.000Z"
      }
    ],
    "next_cursor": null,
    "has_more": false
  }
}
```

### 5.8 删帖

```
DELETE /v1/admin/posts/{postId}?reason=违规内容
```

**理由走查询串**，不是请求体：`DELETE` 带 body 在部分代理上会被丢掉，
而丢掉的恰好是「为什么删」——那种缺失不会报错，只会让审计里查不到原因。

```json
{ "code": 0, "message": "ok", "data": { "target_type": "POST", "target_id": "362810375490994180", "deleted": true } }
```

删除走的是**作者删帖那条级联路径**（`PostDeletionPort`），所以收件箱、点赞、
评论在同一个事务里一起清——后台与用户端不会出现两套删除语义。
目标不存在（或已被删过）→ `40404`。

### 5.9 审计查询

```
GET /v1/admin/audit-logs?limit=20&cursor=&admin_id=&action=ACTOR_STATUS&target_type=ACTOR&target_id=362810375490994177
```

四个过滤条件对应四种真实问题：

| 参数 | 回答的问题 |
|---|---|
| `admin_id` | 这个管理员干过什么 |
| `target_type` + `target_id` | 这个对象被谁动过 |
| `action` | 这类操作发生过几次 |
| 都不填 | 最近都发生了什么 |

后两个组合分别命中 `idx_admin_time` 与 `idx_target_time`。

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "items": [
      {
        "id": "362810375490994200",
        "admin_id": "362810375490994176",
        "admin_name": "ops_zhang",
        "action": "ACTOR_STATUS",
        "target_type": "ACTOR",
        "target_id": "362810375490994177",
        "detail": "{\"status\":2,\"reason\":\"群发广告\"}",
        "ip": "203.0.113.7",
        "created_at": "2026-09-28T04:10:00.000Z"
      }
    ],
    "next_cursor": "362810375490994200",
    "has_more": false
  }
}
```

三个字段值得单独说：

| 字段 | 为什么是这个形状 |
|---|---|
| `admin_name` | 是**快照**（不是 join 出来的）。账号改名或停用之后，这一行仍然能回答「当时是谁做的」 |
| `detail` | **原样透出的 JSON 文本**，不解析成对象。它是排查的入口，而解析成对象会把「某个动作多了一个字段」变成一次接口变更 |
| `ip` | 操作来源。后台的写动作泄露一次就是「封任何人号」的能力，所以来源必须留痕 |

### 5.10 后台账号管理（SUPER only）

| 端点 | 说明 |
|---|---|
| `GET /v1/admin/accounts?limit=&cursor=` | 列表（`next_cursor` / `has_more`） |
| `GET /v1/admin/accounts/{adminId}` | 详情 |
| `POST /v1/admin/accounts` | 新建 |
| `PATCH /v1/admin/accounts/{adminId}/status` | 停用 / 启用 |

新建：

```json
{ "username": "ops_li", "password": "至少 12 位", "display_name": "李运维", "role": 2 }
```

| 校验 | 失败码 |
|---|---|
| 用户名 3–32 位 `[a-z0-9_]` | `40002` |
| 口令长度 < `tm.admin.min-password-length`（默认 12） | `40002` |
| 用户名已存在 | `40909` |
| `role` 不是 1/2 | `40002` |
| 停用**自己** | `40904` |

`role` 缺省为 `2`（OPS）：新建时默认给小的那个角色，误选一次的代价是找人补权限，
而不是多一个能改权限的人。

**口令只进不回**：响应里没有任何口令字段，也没有 `failed_attempts` /
`locked_until`——后两者是「运维自己的操作状态」，出现在响应里只会诱使客户端
做「失败几次了」的判断，而那个判断在服务端。

**停用连带删会话**（同一事务），所以被停用的账号下一次请求就回 `40102`
（会话不存在），而不是等到 token 过期。

### 5.11 注册用户列表

```
GET /v1/admin/users?limit=20&cursor=&status=1&handle_prefix=zhang
```

**它不是另一套模型**：人与 Agent 在库里是同一张表的同一批行，这条接口只是把
`actor_type` 恒定成 `1`（人）。与参与者列表 `/v1/admin/actors` 的分工是**问题不同**：

| 页面 | 回答的问题 |
|---|---|
| `/v1/admin/actors` | 「哪个账号」——人可以、bot 也可以 |
| `/v1/admin/users` | 「这个注册用户是不是活的」——能不能登、有没有会话 |

> 后台界面里这两个已合成**一个页面**（`/admin/users`，类型是筛选条件）——两个页面
> 读同一张表、同样的行，差别只在一个筛选框，而那不是两个页面。接口两个都保留：
> `GET /v1/admin/users` 仍是「只列人」的契约（脚本与报表取数用），
> 而列表页用的是 `GET /v1/admin/actors`。

| 参数 | 类型 | 说明 |
|---|---|---|
| `limit` | int | 缺省用服务端配置；越界被夹取 |
| `cursor` | string | 上一页的 `next_cursor`（类型标签 `ausr`，不能与其它列表的游标混用） |
| `status` | int | `1`=正常 `2`=已封禁；越界回 `40002` |
| `handle_prefix` | string | handle 前缀匹配 |

响应形状与参与者列表**逐字相同**（`ActorPageView`）：同一批字段、同一套分页。
所以界面上的封禁/解封可以复用同一个对话框、同一个接口：
`PATCH /v1/admin/actors/{actorId}/status`（写的 `actor.status` 就是用户端鉴权读的那一列）。

> 服务端**没有**给注册用户单独一个封禁接口。多一个写入口之后，
> 「封禁还会不会让 Agent 接管密钥失效」这类问题就要回答两遍，而两遍迟早不一样。

### 5.12 注册用户详情 / 他的会话

```
GET /v1/admin/users/{actorId}
```

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "actor_id": "362810375490994177",
    "actor_type": 1,
    "handle": "zhang_san",
    "display_name": "张三",
    "avatar_url": null,
    "bio": null,
    "status": 1,
    "created_at": "2026-09-20T07:11:02.000Z",
    "has_password": true,
    "conversation_count": 12
  }
}
```

两个字段是这一页存在的理由：

| 字段 | 回答的问题 |
|---|---|
| `has_password` | 「这个号能不能登」——`false` 而账号又是 ACTIVE，说明它只走验证码/第三方。`actor` 表里看不出来（凭据在 `actor_secret`） |
| `conversation_count` | 「是不是空号」——为 0 意味着他从没跟任何人说过话，「消息丢了」这类工单到这里就结束了 |

**不返回任何凭据本身**（哈希、api_key、webhook_secret）：后台封号不需要它们，
而「能读到别人密钥的运维界面」是一个比封号权更大的权限面。

```
GET /v1/admin/users/{actorId}/conversations?limit=20&cursor=
```

该用户参与的会话，按**会话 id 倒序**（与建会话时间同序）。
单聊会带上对方的 `peer_actor_id` / `peer_handle`——两个 18 位 id 并排摆着没人读得出来。

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "items": [
      {
        "conv_id": "362810375490994200",
        "conv_type": 1,
        "title": null,
        "peer_actor_id": "362810375490994177",
        "peer_handle": "li_si",
        "last_seq": 42,
        "my_role": 3,
        "my_last_read_seq": 40,
        "joined_at": "2026-09-21T02:00:00.000Z"
      }
    ],
    "next_cursor": null,
    "has_more": false
  }
}
```

`last_seq` 是「这个会话的最后一个序号」而不是消息条数：`seq` 允许空洞
（重试、对账、后台删消息都会留下空号）。它的代价是每行一次点查（主键末端下降），
所以这一页的开销是 `O(limit)` 次查询而不是全表扫描。

### 5.13 会话详情与消息

```
GET /v1/admin/conversations/{convId}
```

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "conv_id": "362810375490994200",
    "conv_type": 2,
    "title": "项目群",
    "owner_actor": "362810375490994177",
    "member_count": 8,
    "last_seq": 420,
    "created_at": "2026-09-21T02:00:00.000Z"
  }
}
```

它存在的理由是让「拿一个 conv_id 进来」的人先看清自己在看什么。
没有 `unread` / `last_read_seq`：后台不是一个成员，「未读」在这里没有定义。

```
GET /v1/admin/conversations/{convId}/messages?limit=20&cursor=
```

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "items": [
      {
        "message_id": "362810375490994300",
        "conv_id": "362810375490994200",
        "seq": 42,
        "sender_id": "362810375490994177",
        "sender_handle": "zhang_san",
        "sender_display_name": "张三",
        "msg_type": 1,
        "content": "{\"text\":\"今天上线了\"}",
        "reply_to": null,
        "created_at": "2026-09-27T09:00:00.000Z"
      }
    ],
    "next_cursor": "eyJ2IjoxLCJ0IjoibXNnIiwic2VxIjo0Mn0",
    "has_more": true
  }
}
```

四个约定：

| 约定 | 理由 |
|---|---|
| **路径上必须有 `convId`** | 消息表按 `conv_id` 分片（`message_0..15`），不带分片键的查询是 16 张表广播 + 内存归并。这是分片键决定的形状，不是接口风格 |
| `content` 是**库里那一列的原样 JSON 文本** | 审核要看原文；解析成对象会把「某个消息类型多了一个字段」变成一次接口变更（与动态审核同一条理由） |
| 按 `seq` **倒序**，游标是上一页最后一条的 `seq` | 与用户端「上滑加载历史」同一个定序键，所以共用 `msg` 类型的游标 |
| `sender_handle` 可能为 `null` | 发送者行被删掉之后消息行还在（消息表不建外键）。界面显示 id，不显示「未知」 |

```
DELETE /v1/admin/conversations/{convId}/messages/{seq}?reason=违法内容
```

```json
{ "code": 0, "message": "ok", "data": { "conv_id": "362810375490994200", "seq": 42, "message_id": "362810375490994300", "deleted": true } }
```

理由走**查询串**，与删帖同理：`DELETE` 带 body 在部分代理上会被丢掉，而丢掉的恰好是「为什么删」。

**删除的影响范围必须说清**：

| 会发生的 | 不会发生的 |
|---|---|
| 服务端那一行没了，下次拉历史不会再出现 | 已经拉到它的客户端不会重拉历史，手里那份仍然显示它 |
| 写一条 `MESSAGE_DELETE` 审计，带 `conv_id` / `seq` / 发送者 / 内容摘要 | 从所有人的手机上消失（那需要推送撤销 + 客户端删除，本接口不做，也不假装做了） |

`seq` 空洞是**允许**的（`nextSeq` 不需要任何补偿），这与「重试、对账也会消耗号」是同一条不变式。
消息不存在（或已被删过）回 `40403`——**不是** 200 + `deleted: false`：
「我删了」与「它本来就不在」是两件事，而审计不能记一次假话。

### 5.14 首个账号（`tm.admin.bootstrap.*`）

不在 HTTP 上，但对接入是必要的上下文：`admin_user` 表**为空**时，
`tm-admin.jar` 启动会用 `tm.admin.bootstrap.username` / `password` 创建
一个 SUPER 账号，**只生效一次**。表非空时这两个配置被完全忽略。

这就是「为什么仓库里没有建号脚本」：一次性配置即使泄漏也没有可用的时间窗口。
建完之后应该从部署配置里删掉它们。

### 5.15 App 版本列表 / 发布 / 编辑 / 删除（SUPER only）

#### 列表

```
GET /v1/admin/app-releases?limit=20&cursor=...
```

返回 `AppReleasePageView`（按 `id` 倒序分页，游标类型标签 `rel`）。

#### 发布

```
POST /v1/admin/app-releases
```

multipart/form-data，字段：`file`（APK 文件）、`version_code`（int）、
`version_name`（string）、`mandatory`（1=强制 2=可选）、`note`（可选）。
返回新的 `AppReleaseAdminView`。

> **`version_code` 不再决定落库值**：真实版本号由 `version_name` 用与 Android
> `build.gradle.kts#versionCodeFromName` 相同的算法派生（`1.0.9 → 10009`），
> 保证与 APK 内 `BuildConfig.VERSION_CODE` 一致，客户端才能正确判定有新版本并弹更新
> （修复：后台手填 `109` ≠ APK `10009`，导致「latest > 装机」永远不成立、从不弹更新）。
> `version_code` 仍作为入参接收以兼容旧调用，但 `<=0` 校验保留，且该值本身不落库。

#### 编辑（本次新增）

```
PATCH /v1/admin/app-releases/{id}
```

编辑<b>已发布</b>版本的元数据。JSON 正体（字段名遵循 §3.3 的全局 snake_case，
与服务端 `AppReleaseEditRequest` 逐字一致）：

```json
{
  "version_name": "1.0.3",
  "mandatory": 2,
  "note": "修复若干问题"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `version_name` | string | 是 | 对外版本名（不能为空白） |
| `mandatory` | int | 否 | 1=强制更新 2=可选更新；不传 / 传 `null` 保持原值 |
| `note` | string \\| null | 否 | 更新说明；传空字符串或 `null` 清空 |

`id` 是 §3.5 的 int64 → string。APK 字节（`apk_path` / `apk_size_bytes`）
<b>不可变</b>：二进制发布后已被客户端按 `version_code` 校验过，这里只允许改
说明类元数据——改「强制/可选」会影响客户端升级提示，改「版本名/说明」只影响展示。

| 情况 | 结果 |
|---|---|
| `version_name` 缺失或全空白 | `40001`（缺参数） |
| 该 `id` 不存在 | `40400` |
| 非 SUPER | `40303` |

修改会记一条 `APP_RELEASE_EDIT` 审计（§7.2），`target_id` = 该版本 id。

#### 删除（本次新增）

```
DELETE /v1/admin/app-releases/{id}
```

删除<b>已发布</b>的一个版本。顺序是<b>先删行、后删字节</b>：先从
`app_release` 表删元数据行，再删除对象存储里的 APK 字节；万一字节删失败，
留下的是一个可清扫的孤儿文件，而不是一条指向空文件的「可用版本」。

| 情况 | 结果 |
|---|---|
| 该 `id` 不存在 | `40400` |
| 非 SUPER | `40303` |

删除会记一条 `APP_RELEASE_DELETE` 审计（§7.2），`target_id` = 该版本 id，
`detail` 里带上被删版本的 `version_code` / `version_name` / `mandatory` / `note` 快照。

---

## 6. 视图字段（wire shape）

以下就是网络上真实的字段名与类型。它们是 `tm-api-admin` 里 `view/` 包的
record 组件，由 `tools/verify_admin_spa.py` 与后台 SPA 的类型定义逐字段比对——
字段名写错的表现是「某个单元格永远空白」，不会报错。

#### `AdminView`

| 字段 | 类型 | 说明 |
|---|---|---|
| admin_id | int64 → string | 后台账号 id（见 §3.5） |
| username | string | 登录名 |
| display_name | string \\| null | 显示名 |
| role | int | 1=SUPER 2=OPS |
| status | int | 1=ACTIVE 2=DISABLED |
| created_at | instant | 创建时间 |
| last_login_at | instant \\| null | 最近一次登录成功的时间 |

#### `ActorAdminView`

| 字段 | 类型 | 说明 |
|---|---|---|
| actor_id | int64 → string | 参与者 id |
| actor_type | int | 1=HUMAN 2=AGENT |
| handle | string | 唯一的 @handle，全站唯一 |
| display_name | string \\| null | 昵称 |
| avatar_url | string \\| null | 头像地址 |
| bio | string \\| null | 简介 |
| status | int | 1=ACTIVE 2=SUSPENDED（与用户端鉴权读的同一列） |
| created_at | instant | 注册时间 |
| agent_takeover | object \\| null | 该账号的 Agent 接管配置；从没开启过是 null |

#### `AgentTakeoverView`

| 字段 | 类型 | 说明 |
|---|---|---|
| enabled | bool | 是否已开启接管（关闭之后这一行仍然存在：配置保留） |
| push_mode | int | 1=WEBHOOK 2=WS 3=PULL（与用户端同一套码值） |
| endpoint_url | string \\| null | Webhook 地址（`push_mode=1` 时必填） |
| capabilities | string \\| null | 能力声明（库里存的是 JSON 数组文本） |
| model_info | string \\| null | 模型标识 |
| rate_limit | int \\| null | 每分钟消息上限（声明值） |

#### `PostAdminView`

| 字段 | 类型 | 说明 |
|---|---|---|
| post_id | int64 → string | 动态 id |
| author_id | int64 → string | 作者 actor_id |
| content | string | 正文 |
| visibility | int | 1=PUBLIC 2=FRIENDS |
| like_count | int | 点赞数（库里是原子加减的计数列） |
| comment_count | int | 评论数 |
| created_at | instant | 发布时间 |

#### `AuditLogView`

| 字段 | 类型 | 说明 |
|---|---|---|
| id | int64 → string | 审计行 id（也是翻页游标） |
| admin_id | int64 → string | 操作者 id |
| admin_name | string | 操作者用户名的**快照** |
| action | string | 见 §7.2 的取值表 |
| target_type | string | ACTOR / AGENT / POST / ADMIN / MESSAGE |
| target_id | int64 → string \\| null | 目标 id（登录这类动作的目标是自己） |
| detail | string \\| null | 动作细节，JSON **文本** |
| ip | string \\| null | 来源 IP |
| created_at | instant | 发生时间 |

#### `ActorPageView`

| 字段 | 类型 | 说明 |
|---|---|---|
| items | ActorAdminView[] | 本页数据 |
| next_cursor | string \\| null | 下一页游标 |
| has_more | boolean | 是否还有下一页 |

#### `UserDetailView`

| 字段 | 类型 | 说明 |
|---|---|---|
| actor_id | int64 → string | 参与者 id |
| actor_type | int | 固定 `1`=HUMAN |
| handle | string | 唯一的 @handle |
| display_name | string \\| null | 昵称 |
| avatar_url | string \\| null | 头像地址 |
| bio | string \\| null | 简介 |
| status | int | 1=ACTIVE 2=SUSPENDED（与用户端鉴权读的同一列） |
| created_at | instant | 注册时间 |
| has_password | boolean | 是否设过口令（`actor_secret` 里有 `1=PASSWORD_HASH` 那一行） |
| conversation_count | int | 参与的会话数（`conversation_member` 按 `actor_id`） |

#### `UserConversationView`

| 字段 | 类型 | 说明 |
|---|---|---|
| conv_id | int64 → string | 会话 id（也是单聊/群聊的同一个模型） |
| conv_type | int | 1=DIRECT 2=GROUP |
| title | string \\| null | 群名；单聊为 null |
| peer_actor_id | int64 → string \\| null | 单聊的对方；群聊为 null |
| peer_handle | string \\| null | 对方的 @handle（同上） |
| last_seq | int64 | 会话最后一个序号（`seq` 允许空洞，所以不是条数） |
| my_role | int | 他在这个会话里的角色：1=OWNER 2=ADMIN 3=MEMBER |
| my_last_read_seq | int64 | 他的已读游标（后台看「他看到哪了」） |
| joined_at | instant | 加会话时间 |

#### `UserConversationPageView`

| 字段 | 类型 | 说明 |
|---|---|---|
| items | UserConversationView[] | 本页数据 |
| next_cursor | string \\| null | 下一页游标（类型标签 `aucv`） |
| has_more | boolean | 是否还有下一页 |

#### `ConversationAdminView`

| 字段 | 类型 | 说明 |
|---|---|---|
| conv_id | int64 → string | 会话 id |
| conv_type | int | 1=DIRECT 2=GROUP |
| title | string \\| null | 群名；单聊为 null |
| owner_actor | int64 → string \\| null | 群主；单聊为 null |
| member_count | int64 | 成员数（精确值） |
| last_seq | int64 | 最后一个序号 |
| created_at | instant | 建会话时间 |

#### `MessageAdminView`

| 字段 | 类型 | 说明 |
|---|---|---|
| message_id | int64 → string | 消息主键（只用于关联审计） |
| conv_id | int64 → string | 分片键；也是消息身份的一半 |
| seq | int64 | 会话内序号；消息身份的另一半 |
| sender_id | int64 → string | 发送者 actor_id |
| sender_handle | string \\| null | 发送者 handle；发送者行被删后为 null |
| sender_display_name | string \\| null | 发送者昵称（同上） |
| msg_type | int | 1=TEXT 2=IMAGE 3=SYSTEM |
| content | string | 库里那一列的**原样 JSON 文本** |
| reply_to | int64 \\| null | 回复的 seq（同会话内） |
| created_at | instant | 发送时间 |

#### `MessagePageView`

| 字段 | 类型 | 说明 |
|---|---|---|
| items | MessageAdminView[] | 本页数据（按 `seq` 倒序） |
| next_cursor | string \\| null | 下一页游标（类型标签 `msg`，与用户端历史消息同一种） |
| has_more | boolean | 是否还有下一页 |

#### `MessageDeletedView`

| 字段 | 类型 | 说明 |
|---|---|---|
| conv_id | int64 → string | 被删消息所在的会话 |
| seq | int64 | 被删消息的序号 |
| message_id | int64 → string | 被删消息的主键（审计里的 `target_id`） |
| deleted | boolean | 恒为 true（删不掉的情况回 `40403`） |

#### `PostPageView`

| 字段 | 类型 | 说明 |
|---|---|---|
| items | PostAdminView[] | 本页数据 |
| next_cursor | string \\| null | 下一页游标 |
| has_more | boolean | 是否还有下一页 |

#### `AuditLogPageView`

| 字段 | 类型 | 说明 |
|---|---|---|
| items | AuditLogView[] | 本页数据 |
| next_cursor | string \\| null | 下一页游标 |
| has_more | boolean | 是否还有下一页 |

#### `AdminPageView`

| 字段 | 类型 | 说明 |
|---|---|---|
| items | AdminView[] | 本页数据 |
| next_cursor | string \\| null | 下一页游标 |
| has_more | boolean | 是否还有下一页 |

#### `AppReleaseAdminView`

| 字段 | 类型 | 说明 |
|---|---|---|
| id | int64 → string | 发布 id（下载接口的路径参数） |
| version_code | int | Android 的 `versionCode`，由 `version_name` 派生（`1.2.3→10203`），严格单调；客户端拿它比大小 |
| version_name | string | 展示用的版本名（`1.0.3`） |
| mandatory | int | 1=强制更新，2=可选更新 |
| apk_size_bytes | int64 | APK 字节数 |
| download_path | string | 下载接口相对路径（`/v1/updates/{id}/apk`，用户端匿名可下，拼上公网前缀即可下载） |
| note | string \\| null | 更新说明 |
| published_at | instant | 发布时间 |

#### `AppReleasePageView`

| 字段 | 类型 | 说明 |
|---|---|---|
| items | AppReleaseAdminView[] | 本页数据 |
| next_cursor | string \\| null | 下一页游标 |
| has_more | boolean | 是否还有下一页 |

#### `AdminCaptchaView`

| 字段 | 类型 | 说明 |
|---|---|---|
| captcha_id | string | `cap_` 前缀；登录时原样传回 |
| image | string | 完整 data URL（`data:image/png;base64,...`），直接放 `<img src>` |
| expires_in | int | 存活秒数（`tm.captcha.ttl`，默认 300） |

#### `AdminLoginView`

| 字段 | 类型 | 说明 |
|---|---|---|
| token | string | `adm_` 前缀的会话凭证 |
| expires_at | instant | 过期时间（默认 8 小时） |
| admin | AdminView | 登录者 |

#### `AdminDeletedView`

| 字段 | 类型 | 说明 |
|---|---|---|
| target_type | string | 固定 `POST` |
| target_id | int64 → string | 被删的对象 id |
| deleted | boolean | 是否真的删掉了 |

#### `AdminLoginRequest`

| 字段 | 类型 | 说明 |
|---|---|---|
| username | string | 后台用户名 |
| password | string | 明文口令（只进不回） |
| captcha_id | string \\| null | 来自 `GET /v1/admin/auth/captcha` |
| captcha_code | string \\| null | 人从图里读到的数字；一码只用一次 |

#### `UserDeletionView`

| 字段 | 类型 | 说明 |
|---|---|---|
| items | UserDeletedView[] | 逐条结果（批量时与 `actor_ids` 的顺序一致、已去重） |
| deleted_count | int | 真的删掉了几个（= `items` 里 `deleted=true` 的条数） |
| skipped_count | int | 被跳过了几个（每条的原因在 `note` 里） |

#### `UserDeletedView`

| 字段 | 类型 | 说明 |
|---|---|---|
| actor_id | int64 → string | 被请求删的那个 id |
| handle | string \\| null | 账号已不存在时为 null（拿 id 去猜 handle 是最糟的选择） |
| deleted | boolean | 这次是否真的删掉了 |
| note | string \\| null | 为什么没删（`deleted=true` 时是 null） |

#### `ActorStatusRequest`

| 字段 | 类型 | 说明 |
|---|---|---|
| status | int | 1=ACTIVE 2=SUSPENDED，必填 |
| reason | string \\| null | 审计用的理由 |

#### `AdminStatusRequest`

| 字段 | 类型 | 说明 |
|---|---|---|
| status | int | 1=ACTIVE 2=DISABLED，必填 |

#### `AdminCreateRequest`

| 字段 | 类型 | 说明 |
|---|---|---|
| username | string | 3–32 位 `[a-z0-9_]` |
| password | string | 至少 `tm.admin.min-password-length` 位 |
| display_name | string \\| null | 显示名 |
| role | int \\| null | 1=SUPER 2=OPS，缺省 OPS |

#### `AppReleaseEditRequest`

| 字段 | 类型 | 说明 |
|---|---|---|
| version_name | string | 对外版本名，必填（不能为空白） |
| mandatory | int \\| null | 1=强制更新 2=可选更新；不传保持原值 |
| note | string \\| null | 更新说明；空则清空 |

---

## 7. 错误码

### 7.1 后台这条路径上会出现的错误码

| 码 | 含义 | HTTP | 客户端该做什么 |
|---|---|---|---|
| 40000 | bad request | 200 | 请求体格式不对（例如漏了 body）。检查 JSON |
| 40001 | missing parameter | 200 | 缺必填参数（如 `status`） |
| 40002 | invalid parameter | 200 | 参数取值不合法（码值越界、用户名格式、口令太短、actor_ids 里有坏段、批量超 50） |
| 40016 | captcha invalid | 200 | 图形验证码不存在 / 已过期 / 已用过 / 填错。**重新取一张图**再填（不是口令错了） |
| 40101 | unauthorized | 401 | 用户名或口令不对；或凭证已失效。**清本地凭证并回登录页** |
| 40102 | invalid token format | 401 | 凭证不是 `adm_` 会话（例如拿用户端 JWT 贴过来），或会话已被登出/停用 |
| 40103 | token expired | 401 | 会话过期（默认 8 小时）。可重试一次（重新登录） |
| 40301 | account suspended | 403 | 该后台账号被停用（或目标参与者被封禁）。**不要重试** |
| 40302 | permission denied | 403 | 需要 SUPER。隐藏/禁用那个入口，**不要**清凭证 |
| 40400 | not found | 200 | 目标不存在，或路由写错（后者 HTTP 是 404） |
| 40401 | actor not found | 200 | `actor_id` 不存在（也常见于「id 被 JS 四舍五入过」） |
| 40402 | conversation not found | 200 | `conv_id` 不存在（常见于按 id 手输/拼接时贴错） |
| 40403 | message not found | 200 | 这个 `(conv_id, seq)` 没有消息（也可能刚被别人删过） |
| 40404 | post not found | 200 | 这条动态不存在（可能已经被删过一次） |
| 40904 | self operation | 200 | 不能停用自己 |
| 40909 | admin username exists | 200 | 后台用户名已被占用（与用户端 `40005` 不是同一个身份体系） |
| 42901 | rate limit exceeded | 429 | 登录失败次数过多，账号被临时锁定。**退避**后重试 |
| 50000 | internal error | 500 | 服务端缺陷。拿服务端日志查，**不要**解析 message（响应里不含细节） |

### 7.2 审计动作取值

| `action` | 何时写 | `target_type` |
|---|---|---|
| `ADMIN_LOGIN` | 登录成功 | `ADMIN`（自己） |
| `ADMIN_LOGIN_FAILED` | 口令不对 / 账号停用 / 已锁定 | `ADMIN`（自己） |
| `ADMIN_LOGOUT` | 主动登出 | `ADMIN`（自己） |
| `ADMIN_CREATE` | 新建后台账号 | `ADMIN`（新账号） |
| `ADMIN_STATUS` | 停用 / 启用后台账号 | `ADMIN`（目标账号） |
| `ACTOR_STATUS` | 封禁 / 解封参与者 | `ACTOR`（或 `AGENT`，按 `actor_type`） |
| `USER_DELETE` | 删除注册用户（单个或批量，每一条一行） | `ACTOR`（被删的那个 id） |
| `POST_DELETE` | 后台删帖 | `POST` |
| `MESSAGE_DELETE` | 后台删消息 | `MESSAGE`（`target_id` 是消息主键；`detail` 里带 `convId`/`seq`/发送者/内容摘要） |
| `APP_RELEASE` | 发布 App 版本 | `APP_RELEASE`（该版本 id） |
| `APP_RELEASE_EDIT` | 编辑已发布版本的元数据 | `APP_RELEASE`（该版本 id） |
| `APP_RELEASE_DELETE` | 删除一个已发布版本 | `APP_RELEASE`（该版本 id） |

每个写动作与业务变更**在同一个事务里**写审计。所以不存在「改了库但没记日志」
的中间状态——那种状态下事后只能靠「谁可能知道口令」来推断。

审计表**只写不删**，也没有对应的清理接口。

---

## 8. 与用户端的三处不同（以及为什么）

| 面 | 用户端 | 后台 |
|---|---|---|
| 凭证 | JWT，无状态，2 小时 | `adm_…` 库内会话，**可即时吊销**，8 小时 |
| 进程 | `tm-app.jar`（Tomcat + Netty） | `tm-admin.jar`（只有 Tomcat，**不解析任何长连接协议**） |
| 身份表 | `actor` | `admin_user`（**两张互不相干的表**） |

第三条最容易被当成「重复建模」：如果管理员也是一行 `actor`，
那么「列全站用户」的后台接口会顺手把管理员列出去，审计里的 `admin_id`
也会指向「某个人」——于是「谁能封号」与「谁在聊天」混成了同一张表。

第一条与第二条是同一个理由的两半：后台的每一项能力都是「封任何人的号 /
删任何一条动态」，所以它不能与用户端共享进程、也不能共享那套「签发后删不掉」
的凭证体系。

---

## 9. 相关文档

| 想了解 | 看 |
|---|---|
| 后台为什么必须是另一个 JAR | DESIGN §13.2 |
| 后台的 DDL（三张表） | DESIGN §9.5 |
| 真实 HTTP + 真实 MySQL 的端到端验证 | `server/tm-admin/src/test/java/com/tm/im/admin/AdminHttpIT.java` |
| 后台界面的实现 | `web/admin/`（Vue 3 + Element Plus） |
| 用户端契约 | [03-rest-api.md](03-rest-api.md) |
| 错误码总表（含用户端的码） | [07-errors-limits.md](07-errors-limits.md) |
`,O=`# 02 · 认证与授权

> tm_im 有两类凭证：**账号主人用自己的 JWT，被接管的账号还给 Agent 一把长期密钥**。
> 除此之外，权限模型完全相同。

---

## 1. 两种凭证对比

| | 账号主人 | 接管方（Agent 程序）|
|---|---|---|
| 凭证类型 | JWT | `api_key`（文档里叫**接管密钥**）|
| 获取方式 | 注册/登录 | 账号主人在 H5 的「Agent 接管」页开启接管时返回（§3）|
| 有效期 | 短期（默认 2h）+ refresh_token | 长期有效，直到被轮换或关闭接管 |
| 请求头 | `Authorization: Bearer <jwt>` | `Authorization: Bearer <api_key>` |
| 长连接鉴权 | `AUTH` 帧带 jwt | `AUTH` 帧带 api_key |
| 能改接管配置吗 | ✅（只有它能改）| ❌（`40302`，见 §3.5）|

> **注意**：两者的**请求头格式完全一样**（都是 `Bearer`）。服务端通过前缀识别类型（`sk_` 开头为接管密钥）。客户端不需要区分。
>
> **两者是同一个账号**：开启接管不会新建 `actor`，也不会改 `actor_id`。用接管密钥调
> `GET /v1/me` 拿到的是账号主人自己那个人。

---

## 2. 人类：注册与登录

### 2.0 图形验证码（注册与登录的前置）

注册与登录都**必须**带一张图形验证码（除非部署方把 `tm.captcha.enabled` 关掉，见下）。

取一张：

```bash
GET /v1/auth/captcha          # 不需要 Authorization：这一刻调用方还没有 token
```

```json
{
  "code": 0,
  "data": {
    "captcha_id": "cap_3d9a…（43 位 base64url）",
    "image": "data:image/png;base64,iVBORw0KG…",   // 直接放进 <img src>
    "expires_in": 300
  }
}
```

把它交给用户之后，注册/登录的请求体带上这两个字段：

```json
{ "captcha_id": "cap_3d9a…", "captcha_code": "7043" }
```

规则（每一条都对应一个客户端必须做的事）：

| 项 | 值 | 为什么 |
|---|---|---|
| 位数 | 4 位纯数字（`tm.captcha.length`） | 一万种组合，而一个 id 只有一次机会 + 5 分钟过期 ⇒ 在线穷举不可行 |
| 有效期 | 5 分钟（`tm.captcha.ttl`） | 一边看手机一边在电脑上注册的人不该反复过期 |
| 一次机会 | **用过即删**（含填错的那一次） | 「同一个 id 反复试一万种」是四位数验证码唯一的现实威胁 |
| 大小写 / 空格 | 忽略前后空格 | 移动端键盘粘进来一个空格属于「人做对了、机器判错」 |
| 尺寸 | 148×48 PNG | 客户端按原始尺寸显示；图里是七段笔画画的数字，不依赖任何字体 |

失败一律 `40016`（HTTP 200），**不区分**「没带」「填错」「已过期」「已用过」：
这四种情况下客户端要做的事是同一件——**重新 `GET /v1/auth/captcha` 并把输入框清掉**。

> **它挡的是什么**：批量注册、拿口令字典逐条撞库。它**不**挡针对某一个账号的耐心攻击
> （每张图停几秒即可），也不挡打码平台——所以它是一道成本门槛，不是安全边界。
> 真正的边界是口令哈希与令牌（见本文件 §1）。

**服务端把答案存在哪**：Redis 的 `tm:cap:{captcha_id}`，值为那四位明文数字，TTL = 5 分钟。
与 refresh_token（`tm:rt:*` 只存哈希）不同，这里存的是明文——验证码本身不带任何权限，
而且必须被读出来比较。代价是**能读 Redis 的人能绕过验证码**，所以这一组键与 `tm:rt:*` 同级敏感。

**关掉它**（`tm.captcha.enabled=false`）只会关掉校验：`GET /v1/auth/captcha` 与界面上的
那一行照旧存在。这是有意的——界面不读服务端配置，而「测试环境看不见、生产上第一次见到」
的代价是没人会去点一遍它。只有两类场景该关：

* 不面向互联网的环境；
* **没有眼睛的机器客户端**：压测、并发注册验证、多节点演练（它们在启动参数里显式传
  `--tm.captcha.enabled=false`）。

### 2.1 注册

```bash
POST /v1/auth/register
Content-Type: application/json

{
  "handle": "alice2026",          # 8-32 位字母数字、至少含一个字母（见下表）
  "password": "******",           # 最少 8 位
  "display_name": "Alice",
  "captcha_id": "cap_3d9a…",      # §2.0（部署关掉验证码时可不填）
  "captcha_code": "7043",
  "email": "alice@example.com"    # 可选，用于找回
}
```

响应：

```json
{
  "code": 0,
  "data": {
    "actor_id": 1001,
    "handle": "alice2026",
    "access_token": "eyJhbGciOiJIUzI1NiIs...",
    "refresh_token": "rt_8f2c...",
    "expires_in": 7200
  }
}
```

#### handle 规则

| 项 | 注册（新账号） | 登录 / `@handle` 查找 |
|---|---|---|
| 长度 | 8-32 位 | 3-32 位 |
| 字符 | **只有字母和数字**（不允许下划线等符号） | 字母、数字、下划线 |
| 必须含字母 | ✅（纯数字的账号看起来像手机号） | — |
| 连号 | ❌ 拒绝（`AAAAAAAA`、`abcdefgh`、`87654321`） | — |
| 保留名 | ❌ 拒绝（`admin`、`root`、`system` 等） | — |

两条规则的分工是**故意的**：注册策略只管新名字，而登录与查找只查语法。
库里有一批按旧规则起的账号（`albert` 6 位、带下划线的测试账号），
把新策略套到登录上等于把它们锁在门外，而他们的主人只会看到「账号格式不对」。

> 升级已有部署前，先数一下影响面：`uv run --with pymysql python tools/list_actors.py`
> 逐行列出 `actor` 表的 handle 并标出「新规则下不通过」的那些（本项目实测 128 个）。
> 它们就是「登录必须仍然可用」的那一批——本表的第二列（登录 / `@handle` 查找）不能收紧。

| 码 | 含义 | 客户端处理 |
|---|---|---|
| `40004` | `invalid handle`：长度或字符不合规 | 提示用户改名字的**形状** |
| `40015` | `reserved handle`：形状合规，但名字被保留（连号/保留名） | 提示用户**换一个**名字 |
| `40005` | `handle exists`：这个名字已经被用了 | 提示用户换一个名字 |
| `40016` | `captcha invalid`：验证码没带/填错/过期（§2.0） | **重新取一张**并清空输入框 |

> 大小写不敏感：`Alice2026` 与 `alice2026` 是同一个账号（落库前一律转小写）。
>
> 几个错误的先后顺序：**验证码在最前**（它在任何一次库操作之前生效，
> 于是机器人拿不到任何字段级的反馈），于是在一个没有验证码的请求上，
> 即使 handle 也不合法，回的仍然是 `40016`。

### 2.2 登录

```bash
POST /v1/auth/login
Content-Type: application/json

{
  "handle": "alice",
  "password": "******",
  "captcha_id": "cap_3d9a…",      # §2.0（同注册）
  "captcha_code": "7043"
}
```

响应同注册。

**口令不对时**：HTTP `401` + `code=40101`（验证码不对时是 HTTP 200 + `40016`——
两者必须分得开：前者的动作是「确认口令」，后者是「换一张图」）。

**失败时**：HTTP `401` + `code=40101`。

> 账号不存在、口令错误、以及「这个账号没有口令」（Agent 账号）三种情况返回
> **同一个**错误码与同一句文案。区分它们就等于提供了一个 handle 存在性探测器
> （`02-auth.md` 对 refresh 失败也是同一口径）。

### 2.3 刷新 token

Access token 有效期 2 小时。过期后用 refresh_token 换新：

```bash
POST /v1/auth/refresh
Content-Type: application/json

{ "refresh_token": "rt_8f2c..." }
```

```json
{
  "code": 0,
  "data": {
    "access_token": "eyJhbGciOi...",
    "refresh_token": "rt_3d9a...",   // ★ 会轮换，请替换保存
    "expires_in": 7200
  }
}
```

> ⚠️ **refresh_token 是一次性的**。每次刷新都会签发新的，旧的立即失效。这是防重放的标准做法。

### 2.4 登出

```bash
POST /v1/auth/logout
Authorization: Bearer <access_token>
Content-Type: application/json

{ "refresh_token": "rt_8f2c..." }
```

`refresh_token` 字段**可选**：带上它，服务端会真的作废那条会话；
不带则只当作「客户端已丢弃本地副本」（仍然回 200）。

> **access token 本身作不了废**：它是无状态 JWT，会在 2 小时后自然过期。
> 所以「登出」的实际效果是「**这个客户端无法再续期**」——
> 这一点必须写清楚，否则会以为登出之后旧 token 立刻失效。
>
> 该接口**幂等**：凭证已用过/已过期都返回成功。

---

## 3. Agent 接管：密钥与配置

**Agent 不属于任何人类账号。** 平台里没有「我创建的 Agent」这个东西：接管是**账号自己**
的一个开关——任何账号都可以开启它，开启之后拿到的那把长期密钥（`sk_` 开头）就是
Agent 程序接管这个账号的入口。

于是这一节里的每个接口都长在 `/v1/me/agent-takeover` 下面，路径里**没有 `actor_id`**：
能被接管的就是调用者自己，没有「一批身份」可列。

> **为什么要这样设计**：旧的「人类创建 Agent」把「Agent 是不是一级公民」变成了一个权限问题
> （谁能建、谁拥有、能不能建 Agent 的 Agent）。接管模型下它不再是权限问题——就是同一行
> `actor` 多了一个长期入口，而「谁负责它」由账号自己回答。

### 3.1 开启接管（同时下发接管密钥）

用**账号主人自己的 token** 调用（接管密钥调它会回 `40302`，见 §3.5）：

```bash
POST /v1/me/agent-takeover
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "push_mode": 1,                                    # 1=WEBHOOK 2=WS 3=PULL
  "endpoint_url": "https://my-agent.example.com/tm/callback",
  "capabilities": ["text", "image"],                 # 声明式能力（展示用）
  "model_info": "gpt-4o",                            # 可选，展示用
  "rate_limit": 60                                   # 可选，默认取服务端配置
}
```

`push_mode` 在**首次开启时必填**：没有默认模式是有意的——默认成 `WEBHOOK` 会给一个没有
地址的账号一个永远投不出去的推送模式，而它要等到第一条消息才会被发现。

响应（**`api_key` 只在此刻返回一次，务必保存**）：

```json
{
  "code": 0,
  "data": {
    "takeover": {
      "actor_id": 1001,
      "enabled": true,
      "push_mode": 1,
      "endpoint_url": "https://my-agent.example.com/tm/callback",
      "capabilities": ["text", "image"],
      "model_info": "gpt-4o",
      "rate_limit": 60,
      "has_api_key": true,
      "has_webhook_secret": true,
      "updated_at": "2026-01-01T08:00:00.000Z"
    },
    "api_key": "sk_live_9f2c1d7a4b8e3f60",          // ★ 仅此一次！
    "webhook_secret": "whsec_3a7f9c2e5b8d1046"       // ★ 仅此一次！用于验签
  }
}
```

`push_mode=3`（轮询）或 `2`（长连接）时 `webhook_secret` 是 `null`（给一个永远不会被调用的
密钥，只会让接收方以为自己的回调通道是通的）。

#### 3.1.1 两把密钥的区别（以及为什么其中一把存明文）

| | 接管密钥（`api_key`）| `webhook_secret` |
|---|---|---|
| 用途 | 接管方证明「我是这个账号」 | 平台与接管方互相证明「这条回调没被伪造」 |
| 长度 | `sk_live_` + 32 个十六进制字符（128 位随机） | `whsec_` + 32 个十六进制字符 |
| 服务端存什么 | SHA-256 哈希（只能拿它反查是哪个账号） | **明文** |
| 为什么 | 鉴权是「拿哈希查表」，服务端从不需要明文 | 签名要算 HMAC，而 **HMAC 的密钥不能是哈希**（哈希不可逆，用它签出来的东西对方验不了） |
| 如何失效 | 轮换（覆盖哈希）或关闭接管（删掉哈希 → `40105`） | 关闭接管时删除，或被重签覆盖 |

> 上面示例里的 16 个 hex 字符只是排版示例：实际下发的是 32 个（128 位）。
> 这两把凭据都是长期有效的（没有「用户可记忆」的约束），而 64 位在今天不足以抵抗在线爆破。
>
> **明文 webhook_secret 是一个有意的取舍**：它意味着「拖库 = 能伪造回调」。
> 替代方案（用主密钥加密后落库）只是把风险从数据库挪到主密钥上，
> 而主密钥同样在配置里；真正降低风险的做法是「每个账号一把、只用于验签、可随时重签」。

### 3.2 再调用一次 = 改配置（**不会**重新签发密钥）

同一个接口同时承担「首次开启」与「改配置」：除了 `push_mode`（首次必填）之外的字段
缺省表示**「这一项不改」**。

```bash
POST /v1/me/agent-takeover
{ "endpoint_url": "https://new-endpoint.com/hook" }
```

```json
{ "code": 0, "data": { "takeover": { "...": "..." }, "api_key": null, "webhook_secret": null } }
```

**`api_key` 为 `null` 的含义是「这次没有新签发」**（账号已经有一把）。这不是省略：
重复调用就重新签发一把，会把正在跑的 Agent 静默踢下线，而它下一次调用收到的是 `40105`
——那时没人会想到是刚才那次配置。想换一把请显式调 §3.3。

> 判定「有没有密钥」请看 `takeover.has_api_key` / `takeover.has_webhook_secret`，
> 不要看那两个字段是不是 `null`。

### 3.3 轮换接管密钥

```bash
POST /v1/me/agent-takeover/rotate-key
Authorization: Bearer <jwt>
```

```json
{ "code": 0, "data": { "api_key": "sk_live_<新的>" } }
```

**旧的立即失效**（再拿它调用会得到 `40105`）——请做好双密钥过渡：先把新密钥换到
Agent 的配置里，再让它重连。

### 3.3.1 签发（或轮换）回调密钥

```bash
POST /v1/me/agent-takeover/rotate-webhook-secret
Authorization: Bearer <jwt>
```

返回新的 `webhook_secret`（也只有这一次）。为什么需要一个单独的接口：它**只在下发时出现**，
而推送模式可以后改——密钥丢了、泄了、或者上一家接收方不做了，都只有这一个办法。
细节与那道「模式与密钥必须同时成立」的约束见 [03-rest-api.md §7.5](03-rest-api.md)。

> 它与接管密钥是**两把独立的钥匙**：换一把不会动另一把，
> 而两者的失效后果也不同（前者让 Agent 登不上，后者让回调验签对不上）。

### 3.4 关闭接管

```bash
DELETE /v1/me/agent-takeover
Authorization: Bearer <jwt>
```

关闭之后：

| 项 | 结果 |
|---|---|
| 接管密钥 | **立即失效**：再拿它调用会得到 `40105`（客户端动作：停止使用这把密钥）|
| `webhook_secret` | 被删除，不再签出任何回调 |
| 配置（模式、地址、能力）| **保留**：重新开启时不必再配一遍 |
| 账号本身 | **不受影响**：账号主人照旧登录、照旧聊天 |

> 它与「封禁一个账号」是两件事。封号写的是 `actor.status`（`40301`），
> 而那会让账号主人的 JWT 一起失效；关闭接管只影响那把长期密钥。

### 3.5 这一组接口只认账号主人自己的 JWT

用接管密钥调 `/v1/me/agent-takeover`（任何方法）都会得到 **`40302`**，包括它自己那一把。
三条理由各自都够：

* 配置决定「哪些事件送到哪个地址」。密钥若能改地址，一个泄漏的密钥
  （它躺在 Agent 程序的环境变量里）就能把事件引到别处；
* 密钥若能轮换自己，泄漏之后就无法通过「换一把」止血——换的那把还是它；
* 密钥若能关闭接管，那次关闭是静默的（它本来的用途就是替账号收消息）。

---
## 4. 鉴权失败的响应

| HTTP | code | 含义 | 客户端应做什么 |
|---|---|---|---|
| 401 | 40101 | 缺少 Authorization 头 / **登录时 handle 或口令错误** | 加请求头；或检查登录参数 |
| 401 | 40102 | token 格式错误 | 检查 `Bearer ` 前缀 |
| 401 | 40103 | **token 已过期** | 用 refresh_token 刷新后重试 |
| 401 | 40104 | refresh_token 无效/已使用 | **要求用户重新登录** |
| 403 | 40301 | 账号被停用 | 提示用户，停止重试 |
| 403 | 40302 | 无权访问该资源 | 检查 actor_id 归属 |

**示例响应：**

```json
{
  "code": 40103,
  "message": "token expired",
  "data": null
}
```

---

## 5. 长连接鉴权

建立连接后，**第一帧必须是 `AUTH`**，否则服务端会在 5 秒内断开。

**客户端 → 服务端：**

```protobuf
Frame {
  cmd:    CMD_AUTH    // = 1
  req_id: 1
  payload: AuthRequest {
    token: "sk_live_9f2c1d7a4b8e3f60",   // 或人类 JWT
    client_version: "1.0.0",
    device_id: "web-chrome-131"
  }
}
```

真实字节（55 字节，已实测）：

```
08 01 10 01 1a 31 0a 18 73 6b 5f 6c 69 76 65 5f
39 66 32 63 31 64 37 61 34 62 38 65 33 66 36 30
12 05 31 2e 30 2e 30 1a 0e 77 65 62 2d 63 68 72
6f 6d 65 2d 31 33 31
```

**服务端 → 客户端（成功）：**

```protobuf
Frame {
  cmd:    CMD_AUTH_OK   // = 2
  req_id: 1
  payload: AuthResponse {
    actor_id: 2002
    handle: "weatherbot2026"
    actor_type: ACTOR_TYPE_AGENT   // = 2
    heartbeat_sec: 30
  }
}
```

**服务端 → 客户端（失败）：**

```protobuf
Frame {
  cmd:    CMD_ERROR   // = 21
  req_id: 1
  payload: ErrorFrame {
    code: 40103
    message: "token expired"
    retryable: false
  }
}
```

失败后服务端**会主动关闭连接**。客户端应刷新 token 后重连。

---

## 6. Webhook 签名（Agent 必须实现）

平台向你的 `endpoint_url` 推送事件时，会带上签名头。**你必须校验，否则任何人都能伪造请求打你的服务。**

### 6.1 请求头

```
POST /tm/callback HTTP/1.1
Host: my-agent.example.com
Content-Type: application/json; charset=utf-8
X-TM-Signature: sha256=eefcc660e1b273f9a9c36eedc162ccda38380f638d69c434fff0ac633b035712
X-TM-Timestamp: 1767225600
X-TM-Event-Id: evt_01HQ2X3Y4Z5A6B7C8D9E0F
X-TM-Event-Type: message.created
```

### 6.2 签名算法

```
签名原文 = timestamp + "." + raw_body
签名值   = HMAC-SHA256(webhook_secret, 签名原文)
Header   = "sha256=" + hex(签名值)
```

**规范细节（极易出错，逐条对照）：**

| 项 | 要求 |
|---|---|
| `timestamp` | `X-TM-Timestamp` 头的**字符串原文**（不是数字，不要转换） |
| 分隔符 | **半角句点 `.`** |
| `raw_body` | **请求体的原始字节**，UTF-8 编码 |
| HMAC key | `webhook_secret` 的 UTF-8 字节 |
| 输出 | 小写十六进制 |

> 🔴 **最常见的错误**：先 `json.loads()` 再 `json.dumps()` 拿 body。
> JSON 序列化在**键顺序、空格、Unicode 转义**上都不保证一致，字节必然对不上。
> **必须使用框架提供的原始请求体字节**（Flask: `request.get_data()`、Express: `express.raw()`、Spring: `@RequestBody byte[]`）。

### 6.3 各语言实现（可直接复制）

**Python（Flask）**

```python
import hmac, hashlib, time
from flask import Flask, request

app = Flask(__name__)
WEBHOOK_SECRET = "whsec_3a7f9c2e5b8d1046"   # 从环境变量读取，勿硬编码

@app.post("/tm/callback")
def callback():
    # ★ 关键：拿原始字节，不要用 request.json
    raw_body = request.get_data()
    ts       = request.headers.get("X-TM-Timestamp", "")
    sig_hdr  = request.headers.get("X-TM-Signature", "")

    # 1) 防重放：时间戳偏差不超过 300 秒
    try:
        if abs(time.time() - int(ts)) > 300:
            return {"error": "timestamp out of range"}, 400
    except ValueError:
        return {"error": "bad timestamp"}, 400

    # 2) 计算期望签名
    signing_string = ts.encode("utf-8") + b"." + raw_body
    expected = hmac.new(WEBHOOK_SECRET.encode("utf-8"),
                        signing_string, hashlib.sha256).hexdigest()

    # 3) 常量时间比较（防时序攻击）
    given = sig_hdr.removeprefix("sha256=")
    if not hmac.compare_digest(expected, given):
        return {"error": "bad signature"}, 401

    # 4) 幂等：同一 event_id 只处理一次
    event_id = request.headers.get("X-TM-Event-Id")
    if already_processed(event_id):
        return {"ok": True}, 200          # 重复投递直接 200

    handle_event(request.get_json())
    return {"ok": True}, 200
```

**Node.js（Express）**

```js
const express = require("express");
const crypto  = require("crypto");

const app = express();
const WEBHOOK_SECRET = process.env.TM_WEBHOOK_SECRET;

// ★ 必须用 raw body，不能用 express.json()
app.post("/tm/callback",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const rawBody = req.body;                      // Buffer
    const ts      = req.get("X-TM-Timestamp") || "";
    const sigHdr  = req.get("X-TM-Signature") || "";

    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
      return res.status(400).json({ error: "timestamp out of range" });
    }

    const expected = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(ts + "." + rawBody.toString("utf8"))
      .digest("hex");

    const given = sigHdr.replace(/^sha256=/, "");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(given, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: "bad signature" });
    }

    const payload = JSON.parse(rawBody.toString("utf8"));
    handleEvent(payload);
    res.json({ ok: true });
  }
);
```

**Java（Spring Boot）**

```java
@PostMapping("/tm/callback")
public ResponseEntity<?> callback(
        @RequestHeader("X-TM-Timestamp") String ts,
        @RequestHeader("X-TM-Signature") String sig,
        @RequestBody byte[] rawBody) {          // ★ byte[] 而非对象

    if (Math.abs(Instant.now().getEpochSecond() - Long.parseLong(ts)) > 300) {
        return ResponseEntity.badRequest().body(Map.of("error", "timestamp out of range"));
    }

    String expected = hmacSha256Hex(secret, ts + "." + new String(rawBody, UTF_8));
    String given = sig.replaceFirst("^sha256=", "");

    if (!MessageDigest.isEqual(                      // 常量时间比较
            expected.getBytes(UTF_8), given.getBytes(UTF_8))) {
        return ResponseEntity.status(401).body(Map.of("error", "bad signature"));
    }
    handleEvent(new String(rawBody, UTF_8));
    return ResponseEntity.ok(Map.of("ok", true));
}
```

**Go**

```go
func callback(w http.ResponseWriter, r *http.Request) {
    rawBody, _ := io.ReadAll(r.Body)
    ts  := r.Header.Get("X-TM-Timestamp")
    sig := strings.TrimPrefix(r.Header.Get("X-TM-Signature"), "sha256=")

    t, err := strconv.ParseInt(ts, 10, 64)
    if err != nil || math.Abs(float64(time.Now().Unix()-t)) > 300 {
        http.Error(w, "timestamp out of range", 400); return
    }

    mac := hmac.New(sha256.New, []byte(webhookSecret))
    mac.Write([]byte(ts + "." + string(rawBody)))
    expected := hex.EncodeToString(mac.Sum(nil))

    if !hmac.Equal([]byte(expected), []byte(sig)) {   // 常量时间比较
        http.Error(w, "bad signature", 401); return
    }
    handleEvent(rawBody)
    w.WriteHeader(200)
}
```

### 6.4 自测向量（用这个验证你的实现）

用以下固定输入，你的实现应得出相同结果：

```
webhook_secret = whsec_3a7f9c2e5b8d1046
timestamp      = 1767225600
body (原始字节, 235 bytes):
{"event":"message.created","event_id":"evt_01HQ2X3Y4Z5A6B7C8D9E0F","occurred_at":1767225600456,"data":{"message_id":730000000000000002,"conv_id":1001,"seq":8,"sender_id":2002,"msg_type":1,"content":{"text":"收到，今天北京晴"}}}

签名原文 = "1767225600." + body
期望签名 = eefcc660e1b273f9a9c36eedc162ccda38380f638d69c434fff0ac633b035712
```

**能算出这个值，说明你的签名实现正确。**

---

## 7. 安全建议

| 项 | 建议 |
|---|---|
| 凭证存储 | **绝不硬编码**。用环境变量或密钥管理服务 |
| 传输 | 生产强制 HTTPS / WSS |
| token 日志 | 日志中**脱敏**（只留前 8 位） |
| refresh_token | 一次性、轮换、绑定设备指纹 |
| webhook_secret | 独立于接管密钥，可单独轮换（两个接口分开就是这个原因）|
| 时间戳窗口 | 建议 300 秒，配合 event_id 幂等 |
| 密钥轮换 | 支持双密钥过渡期（新旧并存 24h）｜**平台侧的现状：不支持**——轮换是覆盖式的（旧的立即失效），所以先切配置再轮换 |
`,I=`# 01 · 核心概念

> 读懂这一篇，后面所有设计都会变得「显然」。

---

## 1. Actor：人与 Agent 是同一种东西

tm_im 中**只有一种参与者**，叫 **Actor**：

```json
{
  "actor_id": 2002,
  "actor_type": 2,          // 1 = 人类, 2 = Agent（历史数据/外部导入；见下）
  "handle": "weatherbot2026",  // 唯一标识，全站可 @
  "display_name": "天气助手",
  "avatar_url": "https://...",
  "status": 1               // 1 = 正常, 2 = 停用
}
```

**这就是「对等」的全部含义**：它们共用同一张表、同一套 API、同一套权限模型。
`actor_type` 字段存在的目的**仅仅是展示**，**不影响任何业务能力**。

### Agent 不是一个「归属」出来的身份

平台里**没有「我创建的 Agent」这个东西**。Agent 是一段程序，而它接管一个账号的方式只有一条：

```
账号主人（他自己的 JWT）在 H5「我 → Agent 接管」里开启接管
   └─► 平台当场下发一把长期密钥（接管密钥，sk_ 开头，只显示一次）
        └─► 程序拿它调与真人客户端完全相同的 REST / 长连接
```

于是就有一个很容易想歪的地方：**接管不新建账号**。被接管的那个账号还是它自己——
同一个 `actor_id`、同一份好友关系、同一个会话列表、同样的历史消息。
别人看到的仍然是那个人，只是它现在由程序在回。

| 能力 | 账号主人（JWT）| 接管方（接管密钥）|
|---|---|---|
| 发消息（文字/图片） | ✅ | ✅ |
| 建群 / 入群 | ✅ | ✅ |
| 加好友 | ✅ | ✅ |
| 发广场动态 | ✅ | ✅ |
| 被 @ 通知 | ✅ | ✅ |
| **改接管配置**（推送模式、回调地址）| ✅ | ❌（`40302`）|
| 凭证有效期 | 短期（2h）+ refresh_token | 长期，直到被轮换或关闭接管 |

> **为什么接管方不能改接管配置**：配置决定「哪些事件送到哪个地址」，而接管密钥
> 恰恰是可能已经泄到外部的那一个（它躺在 Agent 程序的环境变量里）。
> 详见 [02-auth.md §3.5](02-auth.md)。

### 那 `actor_type = 2` 是什么

它是**展示元数据**（给头像加个标识），以及历史数据里「这个账号是给程序用的」这个事实。
平台不再提供「创建 Agent 账号」的接口——要接一个 Agent，用**接管**就够了，
而接管跟你账号的 `actor_type` 无关。

## 2. Conversation：单聊与群聊统一抽象

```json
{
  "conv_id": 1001,
  "conv_type": 1,          // 1 = DIRECT(单聊), 2 = GROUP(群聊)
  "title": null,           // 单聊为 null，群聊为群名
  "owner_actor": null,     // 群主；单聊为 null
  "created_at": "2026-01-01T08:00:00Z"
}
```

**为什么统一**：如果单聊和群聊是两套 API，客户端要写两套逻辑，Agent 也要写两套。统一后，「发消息」永远是一个接口：`POST /v1/conversations/{conv_id}/messages`。

### 单聊的唯一性

两个 Actor 之间**有且只有一个** DIRECT 会话。重复请求返回同一个 `conv_id`（幂等）。

```
POST /v1/conversations/direct  {"peer":"@alice"}
→ 第一次：创建 conv_id=1001
→ 第二次：返回同一个 conv_id=1001
```

### 成员关系

```json
{
  "conv_id": 1001,
  "actor_id": 2002,
  "role": 3,               // 1=OWNER 2=ADMIN 3=MEMBER
  "last_read_seq": 5,      // 已读游标（统一未读计算）
  "muted": false,
  "joined_at": "2026-01-01T08:00:00Z"
}
```

---

## 3. Message 与 seq：为什么不用时间戳

### 消息结构

```json
{
  "message_id": 730000000000000001,   // 全局唯一（Snowflake）
  "conv_id": 1001,
  "seq": 7,                            // ★ 会话内严格递增
  "sender_id": 2002,
  "msg_type": 1,                       // 1=TEXT 2=IMAGE 3=SYSTEM
  "content": {"text": "你好"},
  "reply_to": null,
  "client_msg_id": "c-7f3a9b21",
  "created_at": "2026-01-01T08:00:00.123Z"
}
```

### `seq` 是会话内单调整数

```
会话 1001 的消息序列：
  seq=1  alice: 在吗
  seq=2  bot:   在的
  seq=3  alice: 帮我看下天气
  seq=4  bot:   [图片]
  ...
  seq=7  bot:   你好，Agent
```

**为什么必须用 `seq` 而不是时间戳：**

| 问题 | 时间戳 | `seq` |
|---|---|---|
| 多服务器时钟偏差 | ❌ 顺序可能错乱 | ✅ 服务端统一分配 |
| 同一毫秒多条消息 | ❌ 无法定序 | ✅ 严格递增 |
| 断线补拉 | ❌ 边界条件复杂（>= 还是 >？） | ✅ `seq > last_seq` 精确 |
| 消息去重 | ❌ 不可靠 | ✅ 唯一 |
| 已读游标 | ❌ 难以表达 | ✅ 一个整数搞定 |

> **记住**：`created_at` 只用于**展示**（「3 分钟前」）。任何**排序、去重、同步、未读**逻辑都必须基于 `seq`。

### 未读数怎么算

```
未读数 = 会话最新 seq - 我的 last_read_seq
```

就这一个减法，人和 Agent 完全相同。

---

## 4. 幂等：`client_msg_id` 为什么必需

### 问题

```
客户端 ──发送消息──► 服务端
         ◄─(超时，无响应)─
客户端：消息到底发了没有？
```

此时客户端**只有两个选择**，且都有问题：

- 不重试 → 消息可能永久丢失
- 重试 → 可能产生**两条重复消息**

### 解法：幂等键

```json
POST /v1/conversations/1001/messages
{
  "client_msg_id": "c-7f3a9b21",   // ★ 客户端生成，全局唯一
  "msg_type": "TEXT",
  "content": {"text": "你好"}
}
```

服务端行为：

```
收到请求
 ├─ 该 (conv_id, sender_id, client_msg_id) 已存在？
 │    ├─ 是 → 返回【已存在的那条消息】（含原 seq），不新建
 │    └─ 否 → 创建新消息，分配新 seq
```

**结果**：客户端可以**放心重试任意次**，效果与发送一次完全相同。

### 生成建议

| 语言 | 推荐 |
|---|---|
| 任意 | UUID v4 |
| 有业务序号 | `{业务ID}-{递增序号}` |
| 移动端 | `{设备ID}-{本地自增}` |

**要求**：同一发送者、同一会话内不重复即可（不需要全局唯一）。

> ⚠️ **不要用时间戳毫秒做幂等键**。高并发下同一毫秒会碰撞。

---

## 5. 投递语义：至少一次 + 幂等 = 恰好一次

这是分布式消息系统的经典结论，理解它能避免大量困惑：

```
网络层保证：至少一次（at-least-once）
  └─ 消息可能重复投递（重试导致）

应用层补足：幂等去重（基于 seq / message_id）
  └─ 重复的消息被忽略

最终效果：恰好一次（exactly-once）—— 业务视角
```

### 三层去重

| 层 | 依据 | 作用 |
|---|---|---|
| 发送方 | `client_msg_id` | 防自己重试产生重复 |
| 服务端 | `(conv_id, sender_id, client_msg_id)` 唯一索引 | 兜底防重复落库 |
| 接收方 | `(conv_id, seq)` 已处理集合 | 防重复投递导致重复展示 |

**客户端必须实现第三层**。伪代码：

```python
seen = {}   # conv_id -> 已处理的最大 seq

def on_push(msg):
    last = seen.get(msg["conv_id"], 0)
    if msg["seq"] <= last:
        return                      # 已处理过，忽略
    seen[msg["conv_id"]] = msg["seq"]
    render(msg)
```

> **注意**：`seq <= last` 就忽略，而不是 `== `。因为网络乱序时你可能先收到 seq=9 再收到 seq=8，此时 8 已经被「跨过」了。

---

## 6. 断线续传：`last_seq` 是唯一需要持久化的状态

客户端**只需要为每个会话记住一个整数**：最后处理到的 `seq`。

### 重连流程

```
1. 保存各会话的 last_seq（本地持久化）
2. 重连长连接，重新 AUTH
3. 对每个会话发送 SYNC，带上 since_seq = last_seq
4. 服务端返回 (last_seq, 当前最新] 之间的所有消息，按 seq 升序
5. 若 has_more=true，继续请求，直到补完
6. 补齐后，恢复正常实时接收
```

### 为什么这不会丢消息

```
断线期间产生的消息 seq = 8, 9, 10
客户端本地 last_seq = 7

重连后 SYNC(since_seq=7) → 返回 8, 9, 10
```

服务端**只按 seq 区间查询**，与消息产生时间、断线时长都无关。

> 这正是「用 seq 而非时间戳」的最大回报。

---

## 7. 好友关系：互相对称

```json
{
  "actor_a": 1001,
  "actor_b": 2002,
  "status": 2,             // 1=PENDING 2=ACCEPTED 3=BLOCKED
  "initiator": 1001,       // 谁发起的
  "updated_at": "..."
}
```

**存储约定**：`actor_a < actor_b`，消除方向。所以 `A-B` 和 `B-A` 是**同一条记录**。

### 状态机

```
     发起请求                对方同意
None ──────────► PENDING ──────────────► ACCEPTED
                    │
                    ├─ 对方拒绝/超时(7天) ──► 删除（回到 None）
                    │
                    └─ 任一方拉黑 ──────────► BLOCKED
```

### 与发消息的关系（关键）

| 场景 | 是否要求 ACCEPTED |
|---|---|
| **单聊发消息** | ✅ **必须** |
| 群聊发消息 | ❌ 只需是群成员 |
| 发广场动态 | ❌ |
| 好友请求本身 | ❌（否则死锁） |

> **死锁说明**：如果「非好友不能发消息」也限制了「加好友请求」，那么
> A 不能加 B（因为不是好友）→ 永远不是好友 → 永远不能发消息。所以好友请求必须有独立通路。

---

## 8. 广场（Feed）：好友优先

```json
{
  "post_id": 880000000000000001,
  "author_id": 1001,
  "content": {"text": "今天天气不错", "images": [{"media_id": ...}]},
  "visibility": 1,          // 1=PUBLIC 2=FRIENDS_ONLY
  "created_at": "..."
}
```

### 排序规则

信息流分数（内部实现，接入方只需知道效果）：

```
score = 时间序 + 好友加权
```

**效果**：

- 你**好友**的动态优先展示
- 非好友的公开动态排在后面
- 同优先级下按时间倒序

### 可见性

| 值 | 含义 |
|---|---|
| `PUBLIC` (1) | 所有人可见（会进入非好友的信息流，但排序靠后）|
| `FRIENDS_ONLY` (2) | 仅好友可见 |

### 拉取

```
GET /v1/plaza/feed?limit=20&cursor=<上一页返回的cursor>
```

用**游标分页**，不用 offset（offset 在信息流会因新内容插入而错位）。

---

## 9. 三种推送模式（接管方声明「怎么被通知」）

被接管的账号可以声明它**希望怎么被通知**（也就是接管方希望怎么收到消息）：

| 模式 | 值 | 机制 | 适用 |
|---|---|---|---|
| `WEBHOOK` | 1 | 平台 POST 到你提供的 `endpoint_url` | 有公网 HTTP 端点的服务 |
| `WS` | 2 | 你建立长连接，平台实时推 | 低延迟、能持长连接 |
| `PULL` | 3 | 你轮询 `GET /v1/conversations/{id}/messages?since_seq=` | 弱网、Serverless、批处理 |

**H5 客户端用 `WS`**（浏览器只能 WebSocket）。**接管方三种都可以**。

> 这就是「对等」在接入层的体现：选择推送模式的权力，被接管的账号与任何客户端一样。

---

## 10. 一张图总结数据流

```
                    ┌─────────────────────────────────────┐
                    │            tm-app (无状态)           │
   写入路径          │                                     │
   ─────────        │  REST /v1/**        ┌─────────────┐  │
   POST message ────┼────────────────────►│  tm-core    │  │
                    │                     │  领域服务    │  │
   读取路径          │  Netty :8090        │             │  │
   ─────────        │  PUSH ──────────────►│  (同一套逻辑)│  │
   实时收 ──────────┼─────────────────────│             │  │
                    │                     └──────┬──────┘  │
   Webhook 路径     │  POST endpoint_url          │         │
   ─────────        │◄────────────────────────────┘         │
                    └─────────────────────────────────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
                 MySQL           Redis          object store
              (分片存储)      (路由/seq/缓存)      (图片)
```

---

## 下一步

- 要开始写代码 → [02-auth.md](02-auth.md) 拿凭证
- 要看接口细节 → [03-rest-api.md](03-rest-api.md)
- 要做实时 → [04-realtime.md](04-realtime.md)
`,j=`# 07 · 错误码与限流

> 联调时对着这张表查，比看日志快。

---

## 1. 响应格式约定

**所有业务响应都是 HTTP 200**，靠 `code` 区分成败：

```json
{ "code": 0, "message": "ok", "data": { ... } }          // 成功
{ "code": 40003, "message": "not friends", "data": null } // 业务失败
```

**只有认证/限流/服务异常**才用非 200 状态码。

| HTTP | 场景 |
|---|---|
| 200 | 业务处理完成（含业务失败） |
| 401 | 认证问题 |
| 403 | 账号被停用 |
| 404 | **路由**不存在 |
| 429 | 限流 |
| 500 | 服务端异常 |
| 503 | 服务过载/维护 |

**重试原则**：

- `code` 以 `4xxxx` 开头 → 客户端错误，**不要盲目重试**
- `code` 以 `5xxxx` 开头 → 服务端问题，**可退避重试**
- 明确标注 `retryable` 的按标注处理

> **`code` 是唯一的判据；`message` 只进日志。** 下面那张表里 `message` 那一列是固定文案
> （服务端不会往里塞内部状态）；只有请求形状类的错误（`40000`/`40001`/`40002`）有时会跟一句
> 给**客户端开发者**的解释。客户端应当自己把 `code` 映射成用户文案——
> 把 `message` 直接显示给用户，界面上就会出现「服务端拒绝：code=40003 not friends」
> 这种日志形状的提示（真实用户反馈）。参考实现见 04-realtime.md §7.0。
>
> 两份现成的映射表（44 个码的「标题 + 建议」）：`web/h5/src/api/errors.ts` 与
> `web/android/core/src/main/java/com/tm/im/android/core/api/Errors.kt`，两者**逐字相同**，
> 由 `tools/verify_error_text.py` 守着。自己写客户端时照抄这三条就行：标题只说「发生了什么」、
> 建议只说「下一步」（写不出可执行的下一步就不给）、错误码与 `message` 原文只放进默认折叠的「详情」。

---

## 2. 错误码表

### 2.1 通用（0, 40000-40099）

| code | message | 含义 | 可重试 | 客户端处理 |
|---|---|---|---|---|
| 0 | ok | 成功 | — | — |
| 40000 | bad request | 请求格式错误 | ❌ | 检查 JSON 结构 |
| 40001 | missing parameter | 缺少必填参数 | ❌ | 检查字段 |
| 40002 | invalid parameter | 参数值非法 | ❌ | 检查取值范围 |
| **40003** | **not friends** | **非好友不能发消息** | ❌ | **先走加好友流程** |
| 40004 | invalid handle | handle 长度或字符不合规（注册） | ❌ | 8-32 位字母数字、含字母；见 02-auth §2.1 |
| 40005 | handle exists | handle 已被占用 | ❌ | 换一个 |
| 40006 | content too long | 内容超长 | ❌ | 文字 ≤ 5000 字符 |
| 40007 | invalid msg_type | 未知消息类型 | ❌ | 用 TEXT/IMAGE/SYSTEM |
| `40008` | media not found | 图片不存在 | ❌ | 重新上传（拿到引用前已被清理） |
| 40009 | content type mismatch | content 与 msg_type 不符 | ❌ | 见 03-rest-api §4.5 |
| 40010 | invalid cursor | 分页游标无效 | ❌ | 重新从头拉 |
| 40011 | reply_to not found | 引用的消息不存在 | ❌ | 去掉 reply_to |
| 40012 | message too large | 消息体过大 | ❌ | 图片先上传 |
| 40013 | unsupported image type | 图片格式不支持或内容损坏 | ❌ | jpg/png/gif/webp（按内容判断，不看文件名） |
| 40014 | image too large | 图片超过 10MB，或像素数超过 4000 万 | ❌ | 压缩后再传 |

> **40014 有两个来源，而它们必须成对配置**：容器层（Spring 的
> `spring.servlet.multipart.max-file-size`，超过时 Tomcat 在解析 multipart 时就中断请求）
> 与应用层（`tm.storage.max-size-bytes`）。两个值不一致时，实际生效的是**更小的那个**，
> 而报错码都是 40014——看不出是哪一层拦的。
>
> ⚠ 容器层的 **Spring 默认值是 1MB**（不是 10MB），所以「没给外部配置」的那条路上
> （开发跑 `tools/run_app.py`、或 `java -jar` 不带 `--spring.config.additional-location`）
> 上限不是文档里的那个数。`tm-app.jar` 内部的 `application.yml` 因此也写了那一对值；
> 它是 `tools/verify_media_limits.py` 拓出来的：拿一张 1.85 MB 的图上传拿到了 40014，
> 而代码里写着 10 MB。
| `40015` | reserved handle | handle 形状合规但被保留（连号/保留名） | ❌ | 换一个名字（与 40004 的动作不同：那个是改形状） |
| `40016` | captcha invalid | 图形验证码没带 / 填错 / 已过期或已用过 | ❌ | **重新取一张**（`GET /v1/auth/captcha`）并清空输入框；同一个 captcha_id 只有一次机会 |

### 2.2 认证与权限（40100-40399）

| code | message | 含义 | 可重试 | 客户端处理 |
|---|---|---|---|---|
| 40101 | unauthorized | 缺少 Authorization 头 | ❌ | 加请求头 |
| 40102 | invalid token format | token 格式错误 | ❌ | 检查 `Bearer ` 前缀 |
| **40103** | **token expired** | **token 已过期** | ✅ | **刷新后重试** |
| 40104 | invalid refresh token | refresh_token 无效/已用 | ❌ | **重新登录** |
| 40105 | invalid api key | 接管密钥无效（不存在、已被轮换或接管已关闭）| ❌ | 检查或轮换 |
| 40106 | api key revoked | api_key 已吊销 | ❌ | 轮换新 key（本实现不会回它，见下） |
| 40301 | account suspended | **账号被停用** | ❌ | 提示用户，停止重试 |
| 40302 | permission denied | 无权访问 | ❌ | 检查资源归属 |
| 40303 | not a member | 不是会话成员 | ❌ | 先加入会话 |
| 40304 | blocked by peer | 被对方拉黑 | ❌ | 停止重试 |
| 40305 | no privilege | 群内权限不足 | ❌ | 需 ADMIN/OWNER |
| 40306 | owner cannot leave | 群主不能直接退群 | ❌ | 先转让群主 |

### 2.3 资源（40400-40999）

| code | message | 含义 | 可重试 | 客户端处理 |
|---|---|---|---|---|
| 40400 | not found | 资源不存在 | ❌ | 检查 ID |
| 40401 | actor not found | Actor 不存在 | ❌ | 检查 handle |
| 40402 | conversation not found | 会话不存在 | ❌ | 检查 conv_id |
| 40403 | message not found | 消息不存在 | ❌ | 检查 message_id |
| 40404 | post not found | 动态不存在 | ❌ | 检查 post_id |
| 40901 | already friends | 已经是好友 | ❌ | 直接发消息即可 |
| 40902 | request pending | 已有待处理请求 | ❌ | 等待对方处理 |
| 40903 | blocked | 对方拒绝你的请求 | ❌ | 无法添加 |
| 40904 | self operation | 不能对自己操作 | ❌ | 检查 target |
| 40905 | already member | 已是群成员 | ❌ | —（§4.9 的加人是幂等的，不会返回它） |
| 40906 | group member limit | 群成员数超限 | ❌ | 上限 500 |
| 40907 | already liked | 已点过赞 | ❌ | 幂等，忽略 |
| 40908 | target not a member | 目标不在群里 | ❌ | 刷新成员列表（多为过期视图，不是错误） |
| 40909 | admin username exists | 后台账号重名 | ❌ | 换一个用户名（仅 `/v1/admin`，与 `40005` 不是同一个身份体系） |

> **`40106` 在本实现里不会出现**：它的语义是「密钥被吊销但账号正常」，
> 而本系统的吊销只有两种：轮换（旧哈希被覆盖 → `40105`）与**关闭 Agent 接管**
> （那把密钥的行被删掉 → 同样是 `40105`，因为接管密钥**不是**账号的密码）；
> 而「账号被停用」走的是 `40301`（那时账号主人自己的 JWT 也一样失效）。
> 三者里没有任何一个需要 `40106`，留着它是因为它是错误码总表的一部分
> （与 `40905` 同一处境）。

### 2.4 限流（42900-42999）

| code | message | 含义 | 可重试 | 客户端处理 |
|---|---|---|---|---|
| **42901** | **rate limit exceeded** | 超出速率限制 | ✅ | 按 `Retry-After` 退避 |
| 42902 | daily quota exceeded | 日配额用尽 | ✅（次日） | 停止今日发送 |
| 42903 | friend request quota exceeded | 好友请求配额用尽 | ✅（次日） | 停止加好友 |
| 42904 | connection limit exceeded | 同一账号连接数超限 | ✅ | 先关旧连接 |
| 42905 | upload quota exceeded | 上传配额用尽 | ✅（次日） | — |

### 2.5 服务端（50000+）

| code | message | 含义 | 可重试 | 客户端处理 |
|---|---|---|---|---|
| 50000 | internal error | 服务端异常 | ✅ | 指数退避重试 |
| 50001 | database unavailable | 数据库不可用 | ✅ | 退避重试 |
| 50002 | cache unavailable | 缓存不可用 | ✅ | 退避重试 |
| 50003 | storage unavailable | 存储不可用 | ✅ | 退避重试 |
| 50004 | service overloaded | 服务过载 | ✅ | 退避 + 降频 |
| 50005 | webhook delivery failed | webhook 投递失败 | ✅ | 平台会自动重试 |
| 50006 | request timeout | 处理超时 | ✅ | 幂等前提下可重试 |

---

## 3. 限流规则

### 3.1 默认配额

| 维度 | `actor_type=1`（人类）| `actor_type=2` | 说明 |
|---|---|---|---|
| 发消息 | 60 / 分钟 | 60 / 分钟 | 按发送者计 |
| 发消息（单会话） | 20 / 分钟 | 20 / 分钟 | 防刷屏 |
| 好友请求 | 50 / 天 | 100 / 天 | 防批量骚扰（前者防手滑，后者防批量扫描）|
| 发动态 | 20 / 天 | 50 / 天 | — |
| 上传图片 | 100 / 天 | 500 / 天 | — |
| REST 总请求 | 600 / 分钟 | 600 / 分钟 | 按 actor 计 |
| 长连接 | 5 条并发 | 5 条并发 | 超限踢最旧的 |

> **对等**：两个 `actor_type` 的限流维度**完全相同**，只有个别配额不同。
>
> **配额看的是 `actor_type`，不是凭证种类**：一个被 Agent 接管的账号（`actor_type=1`）
> 用的是 50/天——配额回答的是「这个身份能对别人做多少事」，不属于「谁在操作它」这件事。
> 拿接管密钥调 `/v1/me` 得到的 `actor_type` 与用 JWT 调完全一致（我们不做
> 「同一账号两种配额」那种口径），这也正是对等性验收里「只改认证头」能成立的原因之一。
> 平台**不再创建** `actor_type=2` 的账号（见 01-concepts.md §1），所以第二列只对历史数据与外部导入生效。

### 3.2 限流响应

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 12
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1767225612

{
  "code": 42901,
  "message": "rate limit exceeded",
  "data": { "limit": 60, "window_seconds": 60, "retry_after": 12 }
}
```

**必须处理 `Retry-After`**——那是服务端算好的最优等待时间。

### 3.3 主动查询配额

```http
GET /v1/quota
```

```json
{
  "code": 0,
  "data": {
    "rate_limit": {
      "limit": 60, "remaining": 43, "reset_at": "2026-01-01T08:01:00.000Z"
    },
    "daily": {
      "messages":  { "limit": 5000, "used": 231, "reset_at": "2026-01-02T00:00:00.000Z" },
      "friend_requests": { "limit": 100, "used": 3, "reset_at": "..." },
      "uploads":   { "limit": 500, "used": 12, "reset_at": "..." }
    }
  }
}
```

### 3.4 客户端限流实现（参考）

```python
import random
import time

class RateLimiter:
    """令牌桶 + 服务端 Retry-After 优先。"""

    def __init__(self, rate_per_sec: float, burst: int):
        self.rate = rate_per_sec
        self.burst = burst
        self.tokens = float(burst)
        self.last = time.monotonic()

    def acquire(self):
        now = time.monotonic()
        self.tokens = min(self.burst, self.tokens + (now - self.last) * self.rate)
        self.last = now
        if self.tokens < 1:
            wait = (1 - self.tokens) / self.rate
            time.sleep(wait)
            self.tokens = 0
        else:
            self.tokens -= 1


def request_with_retry(fn, max_attempts=5):
    """对可重试错误做指数退避。"""
    backoff = 1.0
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except ApiError as e:
            # 服务端给了 Retry-After，优先遵从
            if e.retry_after:
                delay = e.retry_after
            elif e.retryable:
                delay = min(30.0, backoff) * (1 + random.uniform(-0.3, 0.3))
                backoff *= 2
            else:
                raise                       # 不可重试，直接抛出

            if attempt == max_attempts:
                raise
            print(f"[{e.code}] {e.message}；{delay:.1f}s 后重试 ({attempt}/{max_attempts})")
            time.sleep(delay)
```

### 3.5 ⚠️ 重试前确认幂等

**只有幂等的请求才可安全重试：**

| 操作 | 幂等 | 可安全重试 |
|---|---|---|
| 发消息（带 `client_msg_id`） | ✅ | ✅ |
| 上报已读 | ✅ | ✅ |
| 拉消息（GET） | ✅ | ✅ |
| 创建单聊会话 | ✅ | ✅ |
| 同意好友请求 | ✅ | ✅ |
| 发好友请求 | ⚠️ | 建议先查是否已有 pending |
| 发好友请求（每日配额 50/100） | ⚠️ | 超限回 `42903` |
| 拒绝好友请求 | ❌ | 拒绝是删除，第二次回 `40400` |
| 发动态（无幂等键） | ❌ | **会重复发** |
| 上传图片 | ❌ | **会产生多份** |

> **设计建议**：`POST /v1/plaza/posts` 也支持传入客户端生成的 `client_post_id` 做幂等，
> 与消息接口对称。

---

## 4. 长连接的错误处理

长连接上的错误通过 `CMD_ERROR`（21）帧传递，与 HTTP 语义一致：

```protobuf
Frame {
  cmd: 21,
  req_id: 2,                    // 对应哪个请求
  payload: ErrorFrame {
    code: 40003,
    message: "not friends",
    retryable: false
  }
}
```

### 4.1 哪些错误会断开连接

| 错误 | 是否断开 | 客户端应做 |
|---|---|---|
| `40101`-`40106` 认证类 | ✅ 断开 | 刷新 token 后重连 |
| `40301` 账号停用 | ✅ 断开 | 停止重连 |
| `42904` 连接数超限 | ✅ 断开最旧的 | 关闭多余连接 |
| `KICK` 帧 | ✅ | 按 reason 处理 |
| 业务错误（40003 等） | ❌ 不断开 | 仅该请求失败 |
| `50004` 服务过载 | ⚠️ 可能断开 | 退避重连 |

### 4.2 处理示例

```python
if cmd == CMD["ERROR"]:
    e = decode_error(f[3])
    if e["code"] in AUTH_ERRORS:
        # 认证类：刷新 token，重连
        refresh_token()
        await reconnect()
    elif e["code"] == 42901:
        await asyncio.sleep(e.get("retry_after", 5))
    elif not e["retryable"]:
        log_permanent_failure(e)      # 记录，不要重试
    else:
        log_transient(e)
```

---

## 5. 排错速查表

| 症状 | 最可能原因 | 排查动作 |
|---|---|---|
| `40003` 一直返回 | 不是好友 | `GET /v1/friends` 确认 |
| `40103` 频繁出现 | token 有效期太短或未刷新 | 实现自动刷新逻辑 |
| `42901` 频繁出现 | 发送速率过高 | 加客户端令牌桶 |
| `40400` | 资源 ID 写错 | 打印实际 ID 对照 |
| 消息重复 | 缺 `client_msg_id` 或未去重 | 加幂等键 + `seq` 去重 |
| 消息顺序错乱 | 用时间戳排序 | 改用 `seq` |
| 断线后丢消息 | 未持久化 `last_seq` | 落盘 + 重连发 SYNC |
| 收不到推送 | Webhook 不可达 / 长连接没建 | 查投递日志 / 连接状态 |
| 图片 404 | ID 写错（已删或从未上传） | 检查 media_id 来源；不是「别人的图」——见 03-rest-api §5.2 |
| 验签一直失败 | 序列化后再签名 | 用原始 body 字节 |

---

## 6. 完整错误处理骨架

```python
class ApiError(Exception):
    def __init__(self, code, message, retryable=False, retry_after=None):
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message
        self.retryable = retryable
        self.retry_after = retry_after


RETRYABLE_SERVER = {50000, 50001, 50002, 50003, 50004, 50006}
AUTH_ERRORS = {40101, 40102, 40103, 40104, 40105, 40106}


def classify(code: int, retry_after=None) -> ApiError:
    if code == 42901:
        return ApiError(code, "rate limited", retryable=True, retry_after=retry_after)
    if code == 42902:
        return ApiError(code, "daily quota exceeded", retryable=False)
    if code == 42904:
        return ApiError(code, "too many connections", retryable=True, retry_after=retry_after)
    if code in RETRYABLE_SERVER:
        return ApiError(code, "server error", retryable=True)
    if code in AUTH_ERRORS:
        return ApiError(code, "auth failed", retryable=False)   # 由上层刷新后重试
    if code == 40003:
        return ApiError(code, "not friends", retryable=False)   # 走加好友流程
    return ApiError(code, "client error", retryable=False)
```

---

## 7. 接入质量清单

- [ ] 区分「业务失败（200 + code）」与「HTTP 错误」
- [ ] 明确列出哪些错误**可重试**、哪些**不可重试**
- [ ] 重试前确认操作**幂等**
- [ ] 遵从 `Retry-After` 头
- [ ] 指数退避带**随机抖动**
- [ ] `40103` 能自动刷新 token 并重试
- [ ] `40003` 能引导用户加好友，而不是无限重试
- [ ] `40301`（停用）停止重试并提示用户
- [ ] 长连接区分「认证错误（需重连）」与「业务错误（仅该请求失败）」
- [ ] 关键错误有日志与告警
`,H=`# 06 · 零依赖裸实现指南

> 目标：**只用语言标准库**，实现一个能收发的 Agent —— 拿到的接管密钥（`sk_` 开头）就是它的入口。
> 读完本文，你应该能不看 SDK 源码就把接入跑通。

---

## 1. 最小可用实现（REST 轮询）

**只需 HTTP + JSON，约 60 行。**

### Python（仅标准库）

```python
"""
最小可用 Agent —— 只用 Python 标准库，无任何第三方依赖。
功能：加好友 → 发消息 → 轮询收消息 → 自动回复
"""
import json
import time
import urllib.request
import urllib.error

BASE = "http://localhost:8080/v1"
API_KEY = "sk_live_9f2c1d7a4b8e3f60"     # 从环境变量读，勿硬编码
ME = None
CURSORS = {}                              # conv_id -> last_seq（生产环境需持久化）


def call(method: str, path: str, body=None, timeout=10):
    """统一请求封装，返回 data 字段；业务错误抛异常。"""
    url = BASE + path
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + API_KEY)
    if data:
        req.add_header("Content-Type", "application/json; charset=utf-8")

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "ignore")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            raise RuntimeError(f"HTTP {e.code}: {raw[:200]}")
        payload.setdefault("code", -1)

    if payload.get("code") != 0:
        raise RuntimeError(f"code={payload['code']} msg={payload.get('message')}")
    return payload.get("data")


# ---------- 启动 ----------
ME = call("GET", "/me")
print(f"我是 {ME['handle']} (actor_id={ME['actor_id']}, type={ME['actor_type']})")

print(call("GET", "/conversations"))
```

> ⚠️ 以上示例省略了会话发现逻辑，完整版见 §3。

### Node.js（仅内置模块，Node 18+）

```js
const BASE = "http://localhost:8080/v1";
const API_KEY = process.env.TM_API_KEY;

let cursors = {};   // conv_id -> last_seq

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json();
  if (payload.code !== 0) {
    throw new Error(`code=${payload.code} msg=${payload.message}`);
  }
  return payload.data;
}
```

### Go（仅标准库）

```go
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

const baseURL = "http://localhost:8080/v1"

var apiKey = mustEnv("TM_API_KEY")

func call(method, path string, body any, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil { return err }
		rdr = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, baseURL+path, rdr)
	req.Header.Set("Authorization", "Bearer "+apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil { return err }
	defer resp.Body.Close()

	var env struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil { return err }
	if env.Code != 0 {
		return fmt.Errorf("code=%d msg=%s", env.Code, env.Message)
	}
	if out != nil { return json.Unmarshal(env.Data, out) }
	return nil
}
```

---

## 2. 手写 Protobuf（不依赖任何 protobuf 库）

如果你不想引入 protobuf 运行时（比如在嵌入式环境），可以手写编解码。

### 2.1 只有两个原语

```
varint  : 整数编码，每字节 7 位数据 + 1 位延续标志
LEN     : 长度前缀 + 原始字节（用于 string/bytes/嵌套消息）
```

### 2.2 完整实现（Python）

```python
"""
手写 protobuf 编解码 —— 零依赖。
覆盖本协议所需的全部场景：varint、LEN、嵌套消息。
"""

# ============ 基础原语 ============

def enc_varint(n: int) -> bytes:
    """无符号 varint 编码。"""
    if n < 0:
        n &= (1 << 64) - 1          # 负数按补码处理（proto 的 int64 语义）
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def dec_varint(buf: bytes, i: int):
    """返回 (值, 新偏移)。"""
    val, shift = 0, 0
    while True:
        if i >= len(buf):
            raise ValueError("varint 越界：数据被截断")
        b = buf[i]
        i += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, i
        shift += 7
        if shift > 63:
            raise ValueError("varint 过长")


def tag(field: int, wire: int) -> bytes:
    """tag = (字段号 << 3) | 线类型"""
    return enc_varint((field << 3) | wire)


def enc_uint(field: int, v: int) -> bytes:
    """VARINT 字段；值为 0 时【不编码】（proto3 默认值规则）"""
    if v == 0:
        return b""
    return tag(field, 0) + enc_varint(v)


def enc_bytes(field: int, v: bytes) -> bytes:
    """LEN 字段；空值时【不编码】"""
    if not v:
        return b""
    return tag(field, 2) + enc_varint(len(v)) + v


def enc_str(field: int, s: str) -> bytes:
    return enc_bytes(field, s.encode("utf-8"))


# ============ Frame 编解码 ============

CMD = {
    "AUTH": 1, "AUTH_OK": 2, "PING": 3, "PONG": 4,
    "SEND": 10, "SEND_ACK": 11, "PUSH": 12, "READ": 13,
    "SYNC": 14, "SYNC_END": 15, "SYNC_RESP": 16, "KICK": 20, "ERROR": 21,
}
CMD_NAME = {v: k for k, v in CMD.items()}


def encode_frame(cmd: int, req_id: int, payload: bytes = b"") -> bytes:
    """Frame { cmd=1, req_id=2, payload=3 }"""
    return enc_uint(1, cmd) + enc_uint(2, req_id) + enc_bytes(3, payload)


def decode_frame(buf: bytes) -> dict:
    """通用解码：返回 {字段号: 值}，LEN 字段保留 bytes。"""
    fields, i = {}, 0
    while i < len(buf):
        t, i = dec_varint(buf, i)
        fno, wire = t >> 3, t & 0x07
        if wire == 0:
            v, i = dec_varint(buf, i)
            fields[fno] = v
        elif wire == 2:
            ln, i = dec_varint(buf, i)
            if i + ln > len(buf):
                raise ValueError("LEN 越界")
            fields[fno] = buf[i:i + ln]
            i += ln
        elif wire == 1:
            fields[fno] = buf[i:i + 8]; i += 8
        elif wire == 5:
            fields[fno] = buf[i:i + 4]; i += 4
        else:
            raise ValueError(f"未知线类型 {wire}（字段 {fno}）")
    return fields


# ============ 具体消息编解码 ============

def encode_auth_request(token: str, client_version="", device_id="") -> bytes:
    """AuthRequest { token=1, client_version=2, device_id=3 }"""
    return (enc_str(1, token) + enc_str(2, client_version) + enc_str(3, device_id))


def decode_auth_response(payload: bytes) -> dict:
    """AuthResponse { actor_id=1, handle=2, actor_type=3, heartbeat_sec=4 }"""
    f = decode_frame(payload)
    return {
        "actor_id": f.get(1, 0),
        "handle": f.get(2, b"").decode("utf-8"),
        "actor_type": f.get(3, 0),
        "heartbeat_sec": f.get(4, 0),
    }


def encode_send_request(conv_id: int, client_msg_id: str,
                        msg_type: int, content_json: str, reply_to: int = 0) -> bytes:
    """SendRequest { conv_id=1, client_msg_id=2, msg_type=3, content_json=4, reply_to=5 }"""
    return (enc_uint(1, conv_id)
            + enc_str(2, client_msg_id)
            + enc_uint(3, msg_type)
            + enc_str(4, content_json)
            + enc_uint(5, reply_to))


def decode_message(payload: bytes) -> dict:
    """Message { message_id=1, conv_id=2, seq=3, sender_id=4, msg_type=5,
                 content_json=6, reply_to=7, created_at_ms=8 }"""
    f = decode_frame(payload)
    return {
        "message_id": f.get(1, 0),
        "conv_id": f.get(2, 0),
        "seq": f.get(3, 0),
        "sender_id": f.get(4, 0),
        "msg_type": f.get(5, 0),
        "content_json": f.get(6, b"").decode("utf-8"),
        "reply_to": f.get(7, 0),
        "created_at_ms": f.get(8, 0),
    }


def decode_send_ack(payload: bytes) -> dict:
    """SendAck { conv_id=1, seq=2, message_id=3, created_at_ms=4, client_msg_id=5 }"""
    f = decode_frame(payload)
    return {
        "conv_id": f.get(1, 0),
        "seq": f.get(2, 0),
        "message_id": f.get(3, 0),
        "created_at_ms": f.get(4, 0),
        "client_msg_id": f.get(5, b"").decode("utf-8"),
    }
```

### 2.3 自测：用文档中的实测字节校验

```python
# 已知：这一帧的十六进制为
KNOWN_HEX = """
08 0a 10 02 1a 2c 08 e9 07 12 0a 63 2d 37 66 33
61 39 62 32 31 18 01 22 19 7b 22 74 65 78 74 22
3a 22 e4 bd a0 e5 a5 bd ef bc 8c 41 67 65 6e 74
22 7d
"""
known = bytes(int(x, 16) for x in KNOWN_HEX.split())

# 自己编码一份
mine = encode_frame(CMD["SEND"], 2,
    encode_send_request(1001, "c-7f3a9b21", 1, '{"text":"你好，Agent"}'))

assert mine == known, f"\
期望 {known.hex()}\
实际 {mine.hex()}"
print("✓ 我的编码器与官方实现完全一致")

# 再解码验证
f = decode_frame(known)
assert f[1] == 10 and f[2] == 2
msg = decode_frame(f[3])
assert msg[1] == 1001
assert msg[2] == b"c-7f3a9b21"
assert msg[3] == 1
assert msg[4].decode() == '{"text":"你好，Agent"}'
print("✓ 解码正确")
```

**这个断言能通过，说明你的手写实现是正确的。**

---

## 3. 完整 Agent 示例（WebSocket + 自动回复）

```python
"""
一个完整可用的 Agent：
  - WebSocket 长连接（用 websockets 库；若不可用见 §1 的 REST 轮询版）
  - 手写 protobuf 编解码（无 protobuf 运行时依赖）
  - 心跳、重连、断点续传、seq 去重
"""
import asyncio
import json
import random
import time

import websockets

from minimal_proto import (          # 上一节的手写实现
    CMD, decode_varint, encode_frame, decode_frame,
    encode_auth_request, decode_auth_response,
    encode_send_request, decode_message, decode_send_ack,
)

WS_URL = "ws://localhost:8090/ws"
API_KEY = "sk_live_9f2c1d7a4b8e3f60"

last_seq = {}          # conv_id -> 已处理的最大 seq
req_counter = 0


def next_req_id() -> int:
    global req_counter
    req_counter += 1
    return req_counter


class Agent:
    def __init__(self):
        self.ws = None
        self.actor_id = None
        self.heartbeat_sec = 30

    # ---------- 连接与鉴权 ----------
    async def connect(self):
        self.ws = await websockets.connect(WS_URL, max_size=2 ** 20)
        await self.ws.send(encode_frame(
            CMD["AUTH"], next_req_id(),
            encode_auth_request(API_KEY, "1.0.0", "py-agent-1"),
        ))

        # 等待 AUTH_OK 或 ERROR
        raw = await asyncio.wait_for(self.ws.recv(), timeout=10)
        f = decode_frame(raw)
        if f[1] == CMD["ERROR"]:
            err = decode_frame(f.get(3, b""))
            raise RuntimeError(f"鉴权失败 code={err.get(1)} msg={err.get(2, b'').decode()}")
        if f[1] != CMD["AUTH_OK"]:
            raise RuntimeError(f"意外帧 cmd={f[1]}")

        info = decode_auth_response(f[3])
        self.actor_id = info["actor_id"]
        self.heartbeat_sec = info["heartbeat_sec"] or 30
        print(f"✓ 已鉴权: {info['handle']} (actor_id={self.actor_id})")

        # 断线续传
        if last_seq:
            await self.sync()

    # ---------- 断点续传 ----------
    async def sync(self):
        cursors = b""
        for conv_id, seq in last_seq.items():
            item = (b"\\x08" + self._varint(conv_id) + b"\\x10" + self._varint(seq))
            cursors += b"\\x0a" + self._varint(len(item)) + item
        payload = cursors + (b"\\x10" + self._varint(200))

        req = next_req_id()
        await self.ws.send(encode_frame(CMD["SYNC"], req, payload))
        print(f"→ SYNC {len(last_seq)} 个会话")

    @staticmethod
    def _varint(n: int) -> bytes:
        out = bytearray()
        while True:
            b = n & 0x7F
            n >>= 7
            if n:
                out.append(b | 0x80)
            else:
                out.append(b)
                return bytes(out)

    # ---------- 心跳 ----------
    async def heartbeat_loop(self):
        while True:
            await asyncio.sleep(self.heartbeat_sec)
            try:
                await self.ws.send(encode_frame(CMD["PING"], 0))
            except Exception:
                return

    # ---------- 发消息 ----------
    async def send_text(self, conv_id: int, text: str):
        content = json.dumps({"text": text}, ensure_ascii=False, separators=(",", ":"))
        payload = encode_send_request(
            conv_id, f"c-{random.randrange(16**8):08x}", 1, content
        )
        await self.ws.send(encode_frame(CMD["SEND"], next_req_id(), payload))

    # ---------- 主循环 ----------
    async def run(self):
        await self.connect()
        hb = asyncio.create_task(self.heartbeat_loop())
        try:
            async for raw in self.ws:
                await self.on_frame(raw)
        finally:
            hb.cancel()

    async def on_frame(self, raw: bytes):
        f = decode_frame(raw)
        cmd, req_id = f.get(1, 0), f.get(2, 0)
        name = {v: k for k, v in CMD.items()}.get(cmd, f"?{cmd}")

        if cmd == CMD["PONG"]:
            return

        if cmd == CMD["PING"]:
            await self.ws.send(encode_frame(CMD["PONG"], 0))
            return

        if cmd == CMD["SEND_ACK"]:
            ack = decode_send_ack(f[3])
            last_seq[ack["conv_id"]] = ack["seq"]
            print(f"✓ 已发送 conv={ack['conv_id']} seq={ack['seq']}")
            return

        if cmd == CMD["PUSH"]:
            inner = decode_frame(f[3])           # PushMessage { message = 1 }
            msg = decode_message(inner[1])
            await self.on_message(msg)
            return

        # 续传响应是 **16**，不是 14：14 只用于客户端发出的请求（04-realtime.md §2.3）。
        # 两者分开编号，就是因为载荷类型完全由 cmd 决定，同一个编号没法区分两个方向。
        if cmd == CMD["SYNC_RESP"]:
            # 「本轮没什么要补」时 SyncResponse 的字段全是默认值，而 proto3 不编码默认值——
            # 于是线上真的没有 payload 字段，f.get(3) 会拿不到。这不是异常，是最常见的一帧。
            payload = f.get(3, b"")
            resp = decode_frame(payload) if payload else {}
            has_more = resp.get(2, 0)
            # messages 是 repeated Message（字段号 1，可能有多个）
            for m in self._extract_repeated(payload, 1):
                msg = decode_message(m)
                last_seq[msg["conv_id"]] = msg["seq"]
                await self.on_message(msg)
            if has_more:
                # 本轮没补齐：游标已经推到本帧最后一条，再发一次 SYNC（04-realtime.md §6.2）
                await self.sync()
            else:
                print("✓ 续传完成（紧跟的 SYNC_END 表示整轮结束）")
            return

        if cmd == CMD["SYNC_END"]:
            # 它只在 has_more=false 时出现：收到它就说明补齐了，可以开始收实时推送
            print("✓ 续传结束")
            return

        if cmd == CMD["KICK"]:
            n = decode_frame(f[3])
            print(f"✗ 被踢下线 reason={n.get(1)} detail={n.get(2, b'').decode()}")
            return

        if cmd == CMD["ERROR"]:
            e = decode_frame(f[3])
            print(f"✗ 错误 code={e.get(1)} msg={e.get(2, b'').decode()}")
            return

        print(f"? 未处理的帧 {name}")

    @staticmethod
    def _extract_repeated(buf: bytes, target_field: int):
        """提取 repeated LEN 字段的所有值（同字段号可重复出现）。"""
        out, i = [], 0
        while i < len(buf):
            t, i = decode_varint(buf, i)
            fno, wire = t >> 3, t & 0x07
            if wire == 0:
                _, i = decode_varint(buf, i)
            elif wire == 2:
                ln, i = decode_varint(buf, i)
                data = buf[i:i + ln]; i += ln
                if fno == target_field:
                    out.append(data)
            else:
                break
        return out

    # ---------- 收到消息的处理 ----------
    async def on_message(self, msg: dict):
        conv_id, seq = msg["conv_id"], msg["seq"]

        # ★ 去重：用 <= 而非 ==（防乱序）
        if seq <= last_seq.get(conv_id, 0):
            return

        last_seq[conv_id] = seq
        content = json.loads(msg["content_json"] or "{}")
        text = content.get("text", "")
        print(f"← [{conv_id}#{seq}] sender={msg['sender_id']}: {text}")

        # 自动回复（示例逻辑）
        if msg["sender_id"] != self.actor_id and text:
            await self.send_text(conv_id, f"收到：{text}")


async def main():
    backoff = 1.0
    while True:
        try:
            await Agent().run()
            backoff = 1.0
        except Exception as e:
            print(f"连接断开: {e}")
            delay = min(30.0, backoff) * (1 + random.uniform(-0.3, 0.3))
            print(f"{delay:.1f}s 后重连...")
            await asyncio.sleep(delay)
            backoff *= 2


if __name__ == "__main__":
    asyncio.run(main())
```

---

## 4. 实现检查清单

按顺序逐项确认：

### 编解码层

- [ ] varint 编码：`128` → `80 01`，`1001` → `e9 07`
- [ ] tag 编码：字段 1 VARINT → `08`，字段 3 LEN → `1a`
- [ ] 默认值不编码：`req_id=0` 时字段整体消失
- [ ] 解码时字段缺失用默认值补齐
- [ ] LEN 是**字节数**不是字符数（中文 3 字节）
- [ ] 用文档的实测字节做断言测试，能通过

### 连接层

- [ ] WebSocket 无长度前缀；TCP 需要 4 字节大端前缀
- [ ] AUTH 是第一帧，5 秒内完成
- [ ] 处理 `AUTH_OK` / `ERROR` / `KICK`
- [ ] 应用层心跳（`PING`/`PONG`），间隔用服务端下发的 `heartbeat_sec`
- [ ] 指数退避重连 + **随机抖动**

### 数据层

- [ ] 按 `seq` 去重，用 `seq <= last` 判断（**不是 `==`**）
- [ ] `last_seq` 本地持久化（重启不丢）
- [ ] 重连后发送 `SYNC` 补齐
- [ ] `has_more=true` 时继续拉

### 业务层

- [ ] 发消息带 `client_msg_id`（幂等）
- [ ] 处理 `40003`（非好友）——先走加好友流程
- [ ] 处理 `429`（限流）——退避
- [ ] Webhook 场景：验签 + `event_id` 幂等

---

## 5. 常见失败模式速查

| 症状 | 最可能的原因 |
|---|---|
| `AUTH` 后无响应且连接被关 | token 无效；或首帧不是 AUTH |
| 解码报「varint 越界」 | 漏了长度前缀（TCP）或加了多余前缀（WS） |
| 中文乱码 | LEN 用了字符数而非字节数 |
| 消息重复展示 | 没做 `seq` 去重，或用了 `==` 而非 `<=` |
| 断线后丢消息 | 没持久化 `last_seq`，或重连后没发 `SYNC` |
| 服务端反复断开 | 没发心跳，被 idle 检测踢掉 |
| 重启后大量重连打垮服务端 | 退避没加抖动 |
| 编码结果和文档不符 | 检查默认值是否被错误编码 |

---

## 6. 下一步

- 完整 REST 接口 → [03-rest-api.md](03-rest-api.md)
- 长连接字节细节 → [04-realtime.md](04-realtime.md)
- 错误码与限流 → [07-errors-limits.md](07-errors-limits.md)
`,G=`# tm_im 接入文档

> **不使用官方 SDK，也能完整接入。** 本目录给出全部协议细节、字节级规范和签名算法，
> 任何语言按此实现即可。

---

## 1. 先选路径：三种接入方式

接入方式**不取决于你是人还是 Agent**，而取决于你的场景。这也是 tm_im「对等」的体现——真人客户端和 Agent 程序面对的是同一套 API。

| 路径 | 适用场景 | 需要实现 | 实时性 |
|---|---|---|---|
| **A. REST 轮询** | 快速验证、Serverless、无状态 Agent | 仅 HTTP + JSON | 秒级（靠轮询） |
| **B. REST + Webhook** | 服务端 Agent，需要被实时唤醒 | HTTP 服务端 + 签名校验 | 毫秒级 |
| **C. REST + 长连接** | 高实时客户端、移动端、桌面端 | WebSocket/TCP + Protobuf | 毫秒级 |

**决策树：**

```
你要接入的是什么？
│
├─ 只是想发消息/发动态，不需要“被实时通知”
│    └─► 路径 A：只用 REST，最简单，5 分钟可跑通
│
├─ 我是服务端程序，希望有新消息时平台推给我
│    ├─ 我有公网可访问的 HTTP 端点 ──► 路径 B：Webhook
│    └─ 我没有公网端点            ──► 路径 A（轮询）或 C（长连接）
│
└─ 我要做实时聊天客户端（浏览器/APP）
     └─► 路径 C：REST 负责写，长连接负责实时收
```

> **关键理解**：REST 与长连接**不是二选一**。REST 负责所有「写」和「拉历史」，长连接只负责「实时收推送」。生产客户端通常**两者都用**。

---

## 2. 文档导航

| 文档 | 内容 | 何时读 |
|---|---|---|
| **[01-concepts.md](01-concepts.md)** | 核心概念：Actor 对等、seq、幂等、投递语义 | **先读这个**，它解释后续所有设计 |
| [02-auth.md](02-auth.md) | 认证：账号主人的 JWT、接管密钥（api_key）| 接入第一步 |
| [03-rest-api.md](03-rest-api.md) | REST API 完整参考（含 curl） | 实现业务逻辑 |
| [04-realtime.md](04-realtime.md) | 长连接：字节级协议、握手、重连、断点续传 | 路径 C |
| [05-webhook.md](05-webhook.md) | Webhook 事件、HMAC 签名校验、重试 | 路径 B |
| [06-no-sdk-guide.md](06-no-sdk-guide.md) | **零依赖裸实现**（Python/Node/Go 原生） | 不想装任何库时 |
| [07-errors-limits.md](07-errors-limits.md) | 错误码表、限流、重试策略 | 联调排错 |
| [08-admin-api.md](08-admin-api.md) | 管理后台 `/v1/admin` 的完整契约（另一个 JAR、另一套凭证） | 做后台界面 / 运营 |

---

## 3. 端点与端口

| 服务 | 地址 | 协议 |
|---|---|---|
| REST API | `https://<host>:8080/v1` | HTTPS / JSON |
| 长连接 | `wss://<host>:8090/ws`（浏览器）<br/>`<host>:8090`（原生 TCP） | WebSocket / TCP + Protobuf |
| 图片上传下载 | `https://<host>:8080/v1/media` | HTTPS / multipart |
| **管理后台 API** | `https://<host>:8081/v1/admin` | HTTPS / JSON（**另一个 JAR**，见 [08-admin-api.md](08-admin-api.md)） |

> 开发环境常用 `http://localhost:8080` 与 `ws://localhost:8090/ws`。生产必须 HTTPS/WSS。
>
> 管理后台是独立的第二个应用（`tm-admin.jar`、默认 :8081），本文档剩下的部分
> 只讲用户端与接管方共用的那一套 REST；后台的契约单独一篇。

---

## 4. 五分钟跑通（REST 路径）

以下用最通用的工具演示，**不需要任何 SDK**。

```bash
# ---------- 第 0 步：拿到接管密钥 ----------
# 在 H5 的「我 → Agent 接管」里开启接管（见 02-auth.md §3.1），
# 它返回的 api_key 只显示一次。这里假设你已经把它存成了环境变量。
API_KEY="sk_live_9f2c1d7a4b8e3f60"
BASE="http://localhost:8080/v1"

# ---------- 第 1 步：确认我是谁 ----------
curl -s "$BASE/me" -H "Authorization: Bearer $API_KEY"
# → {"code":0,"data":{"actor_id":1001,"actor_type":1,"handle":"alice2026",...}}
#   ★ 拿到的是被接管的那个账号本身（同一个 actor_id），不是另一个身份

# ---------- 第 2 步：加好友（非好友无法发消息，见 01-concepts）----------
curl -s -X POST "$BASE/friends/requests" \  -H "Authorization: Bearer $API_KEY" \  -H "Content-Type: application/json" \  -d '{"target":"@alice","message":"你好，我是天气助手"}'
# → {"code":0,"data":{"request_id":...,"status":"PENDING"}}

# 等待对方同意后再继续（对方可通过 REST 或 H5 同意）

# ---------- 第 3 步：拿到与好友的单聊会话 ----------
curl -s -X POST "$BASE/conversations/direct" \  -H "Authorization: Bearer $API_KEY" \  -H "Content-Type: application/json" \  -d '{"peer":"@alice"}'
# → {"code":0,"data":{"conv_id":1001,"conv_type":"DIRECT"}}

# ---------- 第 4 步：发一条文字消息 ----------
curl -s -X POST "$BASE/conversations/1001/messages" \  -H "Authorization: Bearer $API_KEY" \  -H "Content-Type: application/json" \  -d '{"msg_type":"TEXT","client_msg_id":"c-7f3a9b21","content":{"text":"你好，Agent"}}'
# → {"code":0,"data":{"message_id":730000000000000001,"seq":7,...}}

# ---------- 第 5 步：拉取消息（轮询方式）----------
curl -s "$BASE/conversations/1001/messages?since_seq=0&limit=50" \  -H "Authorization: Bearer $API_KEY"
# → {"code":0,"data":{"messages":[...],"has_more":false}}
```

**到这里，你已经完成了完整的消息收发。** 剩下的都是这个模式的扩展。

---

## 5. 三个必须理解的点（否则一定会踩坑）

### 5.1 排序用 `seq`，不要用时间戳

每条消息在会话内有一个**严格递增的整数 `seq`**。

- ❌ 不要用 `created_at` 排序或去重（多节点时钟不可能完全一致）
- ✅ 用 `seq`：排序、去重、断点续传、已读游标全都基于它

### 5.2 发消息必须带 `client_msg_id`（幂等键）

网络超时你无法确定消息是否送达，只能重试。**没有幂等键，重试就会产生重复消息。**

```json
{"client_msg_id": "c-7f3a9b21", ...}
```

- 同一 `client_msg_id` 重复提交 → 服务端返回**同一条**消息（含相同 `seq`），不会产生新消息
- 建议：UUID 或 `业务ID-序号`

### 5.3 非好友不能发消息（硬规则）

这不是可配置的开关：

- **单聊**：双方必须是 `ACCEPTED` 好友，否则返回 `40003`
- **群聊**：只要求你是群成员（群内不要求互为好友）
- **加好友请求本身**不受此限制（否则新用户永远无法建立关系）

这条规则对**账号主人和接管方一视同仁**。它也是防 Agent 骚扰的根本机制：接管方想主动触达你，只能发好友请求，**同意权在你手里**。

---

## 6. 协议文件（给需要二进制接入的人）

长连接协议定义在仓库根目录：

```
proto/transport.proto
```

自行生成代码：

```bash
# 安装 protoc（或用 Maven 插件自动下载，见 proto 文件头部注释）
# Java
protoc -I proto --java_out=./out proto/transport.proto

# Python
protoc -I proto --python_out=./out proto/transport.proto

# Go
protoc -I proto --go_out=./out --go_opt=paths=source_relative proto/transport.proto

# TypeScript
protoc -I proto --ts_out=./out proto/transport.proto
```

> ⚠️ **`-I proto` 不能省略**。protoc 要求被编译文件的路径能由 `--proto_path` 精确前缀推导出来，否则会报 `File does not reside within any path specified using --proto_path`。

---

## 7. 关于官方 SDK

SDK 是**便利层**，不是**必需层**：

- SDK 帮你处理：Protobuf 编解码、心跳、重连退避、断点续传、签名校验
- 不装 SDK 的代价：这些你需要自己实现（本文档给出完整细节）

**如果你只是想发消息，REST 就够了——不需要 SDK，也不需要理解 Protobuf。**

---

## 8. 快速自检清单

接入完成后，用这个清单验证：

- [ ] `/v1/me` 能正确返回我的 `actor_id` 和 `actor_type`
- [ ] 发消息带了 `client_msg_id`，且重试同一条不会产生重复消息
- [ ] 处理了 `40003`（非好友）错误
- [ ] 按 `seq` 排序，而不是 `created_at`
- [ ] 长连接（若使用）实现了心跳，且能识别 `KICK` 并重连
- [ ] 按 `cmd` 解码而不是猜载荷，且**不回显服务端专用命令**（`CMD_PUSH`/`CMD_SYNC_RESP` 等）
- [ ] 重连后能通过 `last_seq` 补齐断线期间的消息
- [ ] Webhook（若使用）校验了 `X-TM-Signature` 并做了时间戳防重放
- [ ] 处理了 `429`（限流），并做了指数退避
`,B=`# 04 · 长连接协议（字节级）

> 长连接只做一件事：**实时收推送**。所有「写」操作仍走 REST。
> 本篇给出完整字节规范，任何语言可自行实现，**不需要官方 SDK**。

---

## 1. 传输承载

### 1.1 两种承载方式

| 场景 | 地址 | 承载 |
|---|---|---|
| 浏览器 / 移动端 | `wss://<host>:8090/ws` | **WebSocket**（二进制帧） |
| 原生程序（推荐） | `<host>:8090` | **原生 TCP** |

> 地址里的 `8090` 是 Netty 的默认端口（`TM_NETTY_PORT`）。生产通常由反代把 HTTP 与
> 长连接收成**一个**对外入口（`location /ws` → 8090），那时浏览器的地址就是
> `wss://<域名>/ws`（没有端口）——而**页面自己推不出这个地址**，所以服务端用
> `GET /v1/client-config` 告诉它（见下）。

**客户端怎么知道该连哪儿**（优先级从高到低，实现见 `web/h5/src/api/realtime.ts`）：

> 1. 运行时 `?ws=` 参数（调试用）；
> 2. `GET /v1/client-config` 的 `ws_url` —— 服务端部署期配置（`tm.netty.public-ws-url`），
>    响应包络与其余接口相同，无需凭证，未配置时是 `null`；
> 3. 构建期 `VITE_TM_WS_URL`；
> 4. 默认：页面在标准端口上（80/443）→ 同源 `/ws`，否则 `<host>:8090/ws`。
>
> 路径**必须**带 `/ws`：Netty 在同一个端口上同时收 WebSocket 与原生 TCP，
> 靠升级请求的路径分流（服务端的 `WS_PATH`）。少一段的表现只是「一直重连」，
> 看起来像网络问题——所以部署期的那个地址配错时服务端**启动直接失败**。

### 1.2 帧边界规则（关键区别）

**WebSocket 承载：**

```
一个 WebSocket 二进制消息 = 一个完整的 Frame
```

✅ **不需要额外长度前缀**——WebSocket 协议自身已有帧边界。

**原生 TCP 承载：**

```
[4 字节大端长度 N][N 字节 Frame 字节流][4 字节大端长度 M][M 字节 Frame]...
```

⚠️ TCP 是**字节流**，没有消息边界，**必须**自己加长度前缀。

示例（实测）：

```
00 00 00 32                                     ← 长度 0x32 = 50
08 0a 10 02 1a 2c 08 e9 07 12 0a 63 2d 37 66 33   ← Frame 本体
61 39 62 32 31 18 01 22 19 7b 22 74 65 78 74 22
3a 22 e4 bd a0 e5 a5 bd ef bc 8c 41 67 65 6e 74
22 7d
```

> **易错点**：长度前缀是 **Frame 的字节数（50）**，**不含** 前缀自身 4 字节。

---

## 2. Frame 结构

```protobuf
message Frame {
  Cmd    cmd     = 1;   // 字段号 1，线类型 VARINT
  uint64 req_id  = 2;   // 字段号 2，线类型 VARINT
  bytes  payload = 3;   // 字段号 3，线类型 LEN
}
```

### 2.1 命令字表（`cmd`）

| 值 | 名称 | 方向 | payload 类型 | 说明 |
|---|---|---|---|---|
| 0 | `CMD_UNKNOWN` | — | — | 保留，任何一方都不得使用 |
| 1 | `CMD_AUTH` | C→S | `AuthRequest` | 鉴权（**必须是第一帧**） |
| 2 | `CMD_AUTH_OK` | S→C | `AuthResponse` | 鉴权成功 |
| 3 | `CMD_PING` | 双向 | — | 心跳 |
| 4 | `CMD_PONG` | 双向 | — | 心跳应答 |
| 10 | `CMD_SEND` | C→S | `SendRequest` | 发消息 |
| 11 | `CMD_SEND_ACK` | S→C | `SendAck` | 发送成功回执（含最终 seq） |
| 12 | `CMD_PUSH` | S→C | `PushMessage` | 新消息推送 |
| 13 | `CMD_READ` | C→S | `ReadRequest` | 已读上报 |
| 14 | `CMD_SYNC` | C→S | `SyncRequest` | 断点续传拉取 |
| 15 | `CMD_SYNC_END` | S→C | `SyncEnd` | 续传一轮结束（仅 `has_more=false` 时发） |
| 16 | `CMD_SYNC_RESP` | S→C | `SyncResponse` | 续传响应（一次请求恰好一帧） |
| 20 | `CMD_KICK` | S→C | `KickNotice` | 强制下线 |
| 21 | `CMD_ERROR` | S→C | `ErrorFrame` | 错误（关联 req_id） |

### 2.2 `req_id` 规则

| 场景 | 值 |
|---|---|
| 客户端发起的请求 | 客户端自增（建议从 1 开始，u64 递增） |
| 服务端对请求的响应 | **原样回传**该请求的 `req_id` |
| 服务端主动推送 | `0` |

**用途**：并发请求时配对响应。因为长连接是全双工的，`req_id` 让你知道哪个响应属于哪个请求。

> 也用于 SDK 层的「同步调用」封装（把异步响应转成 Future/Promise）。

### 2.3 命令字的三条不变量（含一条真实的修正记录）

| # | 不变量 | 违反时的表现 |
|---|---|---|
| 1 | **一个命令字只有一个方向**（因此请求与响应必须是两个不同命令字） | 接收方拿到一帧无法判断是请求还是响应 |
| 2 | **一个命令字只对应一种 payload 类型，且一种 payload 只属于一个命令字** | `payload` 是 `bytes`，类型信息全靠 `cmd`；错配时 protobuf **不报错**，只把不匹配的字段当未知字段跳过 → 「解析成功但字段含义全错」 |
| 3 | **编号只增不改**：一个值一旦写进本篇，含义就冻结 | 照旧版文档实现过的接入方静默错位（新编号被当成旧语义） |

#### 修正记录：`CMD_SYNC` 的响应

早期版本里 `CMD_SYNC = 14` 一个编号承担了两个方向的两种载荷：

```
C→S  payload = SyncRequest     // 「我要补消息」
S→C  payload = SyncResponse    // 「给你补消息」
```

同一条连接上收到 `cmd=14`，接收方**没有任何依据**判断该按哪个类型解 —— 而 protobuf 又不会报错（两者都含嵌套消息字段，只是字段号不同），于是会出现「解析成功、字段为空或串位」这种最难查的现象。这一条同时违反不变量 1 与 2。

修法是**给响应一个独立编号**，而不是让实现者去猜载荷：

| | 请求 | 响应 |
|---|---|---|
| 命令字 | `CMD_SYNC` = **14** | `CMD_SYNC_RESP` = **16** |
| 方向 | C→S | S→C |
| 载荷 | `SyncRequest` | `SyncResponse` |

> **为什么是「追加 16」而不是「把 `CMD_SYNC_END` 挪到 16、响应占 15」**：
> 15 已经写在对外文档里（不变量 3）。重排会让任何一份按文档实现的客户端静默错位，
> 而追加一个新编号的代价只是表格里多一行。

#### 这三条不变量是机器校验的，不靠 reviewer 记得

| 校验内容 | 位置 |
|---|---|
| 编号/方向/载荷三方一致：`proto/transport.proto` ↔ 本篇 §2.1 ↔ 服务端 `Frames` | `tools/verify_integration_docs.py` 第 5 节 |
| 每条命令必须显式声明方向与载荷（格式写死，漏写即失败） | 同上（逐行校验 proto 的 `Cmd` 枚举） |
| 编号冻结：`CMD_SYNC=14` / `CMD_SYNC_END=15` / `CMD_SYNC_RESP=16` | `FramesTest.commandDirectionsAreDeclared` |
| 客户端发送服务端专用命令 → 40000 且说明是哪一类错 | `TwoClientEndToEndTest.serverOnlyCommandsAreRejectedAsClientMistakes` |
| 请求与响应不会用到同一个编号 | `FramesTest.syncResponseHasItsOwnCommandWord` |

#### 客户端必须做到的两件事

1. **不要回显服务端帧**。`CMD_AUTH_OK`/`CMD_SEND_ACK`/`CMD_PUSH`/`CMD_SYNC_RESP`/`CMD_SYNC_END`/`CMD_KICK`/`CMD_ERROR` 都只由服务端发出；
   发过去会得到 `40000`（服务端能明确指出「这是服务端专用命令」，而不是含混的「未知命令」）。
2. **按命令字解码，不要按「猜」**。`payload` 里没有类型信息，`cmd` 是唯一依据；
   解不出来就是协议实现错了，应该当作致命错误处理，不要用默认值堆过去。

---

## 3. Flutter/浏览器要实现 protobuf 吗？

**要，但如果不想实现，见 §8 的替代方案。**

protobuf 线格式其实很简单，只有 3 种编码需要实现：

### 3.1 varint 编码（用于 `cmd`、`req_id` 等整数）

规则：每字节低 7 位是数据，最高位（bit 7）表示「还有后续字节」。

实测对照表（**自己实现的黄金测试用例**）：

| 值 | 编码（hex） | 字节数 |
|---|---|---|
| 1 | `01` | 1 |
| 2 | `02` | 1 |
| 10 | `0a` | 1 |
| 127 | `7f` | 1 |
| 128 | `80 01` | 2 |
| 300 | `ac 02` | 2 |
| 1001 | `e9 07` | 2 |
| 16384 | `80 80 01` | 3 |

**编码算法：**

```python
def encode_varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)
```

**解码算法：**

```python
def decode_varint(buf: bytes, i: int):
    val = 0
    shift = 0
    while True:
        b = buf[i]; i += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, i
        shift += 7
```

### 3.2 tag 编码

```
tag = (字段号 << 3) | 线类型
```

| 线类型 | 值 | 用于 |
|---|---|---|
| VARINT | 0 | int32/int64/uint32/uint64/bool/enum |
| I64 | 1 | fixed64/double |
| LEN | 2 | string/bytes/嵌套消息 |
| I32 | 5 | fixed32/float |

实测：

| 字段 | 线类型 | tag（十进制） | tag（hex） |
|---|---|---|---|
| 1 | VARINT | 8 | `08` |
| 2 | VARINT | 16 | `10` |
| 3 | LEN | 26 | `1a` |
| 4 | LEN | 34 | `22` |

### 3.3 Frame 的完整手写编解码

```python
# ---------- 编码 ----------
def encode_frame(cmd: int, req_id: int, payload: bytes) -> bytes:
    out = bytearray()
    # 字段 1: cmd (VARINT)
    out += bytes([(1 << 3) | 0]) + encode_varint(cmd)
    # 字段 2: req_id (VARINT)
    out += bytes([(2 << 3) | 0]) + encode_varint(req_id)
    # 字段 3: payload (LEN)
    if payload:
        out += bytes([(3 << 3) | 2]) + encode_varint(len(payload)) + payload
    return bytes(out)

# ---------- 解码 ----------
def decode_frame(buf: bytes) -> dict:
    i = 0
    frame = {"cmd": 0, "req_id": 0, "payload": b""}
    while i < len(buf):
        tag, i = decode_varint(buf, i)
        field, wire = tag >> 3, tag & 0x07
        if wire == 0:
            v, i = decode_varint(buf, i)
            if field == 1: frame["cmd"] = v
            elif field == 2: frame["req_id"] = v
        elif wire == 2:
            ln, i = decode_varint(buf, i)
            data = buf[i:i + ln]; i += ln
            if field == 3: frame["payload"] = data
        else:
            raise ValueError(f"unsupported wire type {wire}")
    return frame
```

---

## 4. 逐字节示例（实测，可用来自测）

### 4.1 AUTH 帧（55 字节）

```
08 01 10 01 1a 31 0a 18 73 6b 5f 6c 69 76 65 5f
39 66 32 63 31 64 37 61 34 62 38 65 33 66 36 30
12 05 31 2e 30 2e 30 1a 0e 77 65 62 2d 63 68 72
6f 6d 65 2d 31 33 31
```

**逐字段解析：**

```
Frame 层：
  08 01       字段1 cmd    = 1   (CMD_AUTH)
  10 01       字段2 req_id = 1
  1a 31       字段3 payload, LEN=0x31=49 字节

payload（AuthRequest）展开：
  0a 18 73 6b 5f ...    字段1 token, LEN=0x18=24 → "sk_live_9f2c1d7a4b8e3f60"
  12 05 31 2e 30 2e 30  字段2 client_version, LEN=5 → "1.0.0"
  1a 0e 77 65 62 2d ... 字段3 device_id, LEN=0x0e=14 → "web-chrome-131"
```

### 4.2 SEND 帧（50 字节）

```
08 0a 10 02 1a 2c 08 e9 07 12 0a 63 2d 37 66 33
61 39 62 32 31 18 01 22 19 7b 22 74 65 78 74 22
3a 22 e4 bd a0 e5 a5 bd ef bc 8c 41 67 65 6e 74
22 7d
```

**逐字段解析：**

```
Frame 层：
  08 0a       字段1 cmd    = 10  (CMD_SEND)
  10 02       字段2 req_id = 2
  1a 2c       字段3 payload, LEN=0x2c=44 字节

payload（SendRequest）展开：
  08 e9 07              字段1 conv_id        = 1001
  12 0a 63 2d ...       字段2 client_msg_id  = "c-7f3a9b21" (10 字节)
  18 01                 字段3 msg_type       = 1 (TEXT)
  22 19 7b 22 ...       字段4 content_json   = {"text":"你好，Agent"} (25 字节)
```

> **注意 `content_json` 是 25 字节**，不是字符数。中文 UTF-8 占 3 字节：
> `你`(3) + `好`(3) + `，`(3) + `Agent`(5) + 结构 11 = 25。
> 这正是必须由工具生成而非手算的原因。

### 4.3 SEND_ACK 帧（40 字节）

```
08 0b 10 02 1a 22 08 e9 07 10 07 18 81 80 a4 f0
9d e4 de 90 0a 20 fb d0 ea b6 b7 33 2a 0a 63 2d
37 66 33 61 39 62 32 31
```

```
Frame 层：
  08 0b        cmd    = 11 (CMD_SEND_ACK)
  10 02        req_id = 2   ← 与 SEND 的 req_id 相同，用于配对
  1a 22        payload LEN=0x22=34

payload（SendAck）：
  08 e9 07        conv_id = 1001
  10 07           seq = 7        ★ 服务端分配的最终序号
  18 81 80 ...    message_id = 730000000000000001 (varint, 9 字节)
  20 fb d0 ...    created_at_ms = 1767225600123
  2a 0a 63 2d...  client_msg_id = "c-7f3a9b21"
```

> `message_id` 是雪花 ID（约 7.3×10^17），varint 编码后是 9 字节，
> 这让整帧比用固定 8 字节还多 1 字节——**大整数用 varint 不一定省**，但这是 protobuf 的默认行为。

### 4.4 PUSH 帧（70 字节）

```
08 0c 1a 42 0a 40 08 82 80 a4 f0 9d e4 de 90 0a
10 e9 07 18 08 20 d2 0f 28 01 32 23 7b 22 74 65
78 74 22 3a 22 e6 94 b6 e5 88 b0 ef bc 8c e4 bb
8a e5 a4 a9 e5 8c 97 e4 ba ac e6 99 b4 22 7d 40
c8 d3 ea b6 b7 33
```

```
Frame 层：
  08 0c        cmd    = 12 (CMD_PUSH)
  （无 req_id！服务端主动推送时为 0，protobuf 默认值不编码 → 直接省略）
  1a 42        payload LEN=0x42=66

payload（PushMessage）：
  0a 40 ...    字段1 message, LEN=0x40=64
                └─ 内嵌 Message 消息
```

> **重要观察**：`req_id=0` 时字段**完全不出现**（protobuf3 默认值不编码）。
> 你的解码器必须能处理「字段缺失」，用默认值 0 补齐。

### 4.5 SYNC_RESP 帧（123 字节）

重连后补齐丢失消息的响应（§6）。注意命令字是 **16**，不是 14 —— 14 只用于客户端发出的 `SyncRequest`（§2.3）。

```
08 10 10 03 1a 75 0a 40 08 82 80 a4 f0 9d e4 de
90 0a 10 e9 07 18 08 20 d2 0f 28 01 32 23 7b 22
74 65 78 74 22 3a 22 e6 94 b6 e5 88 b0 ef bc 8c
e4 bb 8a e5 a4 a9 e5 8c 97 e4 ba ac e6 99 b4 22
7d 40 c8 d3 ea b6 b7 33 0a 31 08 83 80 a4 f0 9d
e4 de 90 0a 10 e9 07 18 09 20 e9 07 28 01 32 14
7b 22 74 65 78 74 22 3a 22 e6 98 8e e5 a4 a9 e8
a7 81 22 7d 40 95 d6 ea b6 b7 33
```

```
Frame 层：
  08 10        cmd    = 16 (CMD_SYNC_RESP)
  10 03        req_id = 3    ← 与客户端发出的 CMD_SYNC 相同
  1a 75        payload LEN=0x75=117

payload（SyncResponse）：
  0a 40 ...    字段1 messages，第 1 条，LEN=0x40=64
                └─ 与 §4.4 PUSH 里那条完全相同的 Message（seq=8）
  0a 31 ...    字段1 messages，第 2 条，LEN=0x31=49
                ├─ 08 83 80 ...  message_id = 730000000000000003
                ├─ 10 e9 07     conv_id = 1001
                ├─ 18 09        seq = 9        ★ 必须严格递增
                ├─ 20 e9 07     sender_id = 1001
                ├─ 28 01        msg_type = 1 (TEXT)
                ├─ 32 14        content_json LEN=0x14=20 → {"text":"明天见"}
                └─ 40 95 d6 ... created_at_ms = 1767225600789
  字段2 has_more 与 字段3 truncated 都是 false
  → （protobuf3 默认值不编码，两个字段完全不出现；解码时必须当作 false）
```

> **为什么 `has_more` / `truncated` 一个字节都没有？** protobuf3 **不编码默认值**（`false`），
> 「没出现」就等于 `false`。这必须当真处理：把缺失当成「不知道」会让客户端行为不确定，
> 而把 `truncated` 的缺失当成 `true`，会把所有客户端都送去走 REST 补拉。
> §4.4 的 `req_id=0`（字段消失）是同一个机制，不是特例。

### 4.6 SYNC_END 帧（10 字节）

```
08 0f 10 03 1a 04 08 01 18 02
```

```
Frame 层：
  08 0f        cmd    = 15 (CMD_SYNC_END)
  10 03        req_id = 3    ← 与上面那帧相同
  1a 04        payload LEN=4

payload（SyncEnd）：
  08 01        ok = true
  （message 为空字符串 → 不编码）
  18 02        conv_synced = 2   ← 本轮补齐的会话数
```

> 这两帧是**一对**：`CMD_SYNC_RESP(16)` 带消息，`CMD_SYNC_END(15)` 带「这轮完了」。
> 它们共用同一个 `req_id`，且都不属于客户端可发送的方向。

---

## 5. 连接生命周期

### 5.1 完整时序

```mermaid
sequenceDiagram
  participant C as 客户端
  participant S as 服务端

  C->>S: TCP/WS 连接建立
  C->>S: AUTH(req_id=1, token)
  S-->>C: AUTH_OK(actor_id, handle, heartbeat_sec=30)
  Note over C,S: 连接就绪

  loop 每 30 秒
    C->>S: PING
    S-->>C: PONG
  end

  C->>S: SEND(req_id=2, conv_id, client_msg_id, text)
  S-->>C: SEND_ACK(req_id=2, seq=7)
  S-->>C: PUSH(message)          ← 对方回的消息
  C->>S: READ(conv_id, last_read_seq=8)

  C->>S: SYNC(req_id=3, cursors=[{conv_id, since_seq=last}])
  S-->>C: SYNC_RESP(req_id=3, messages...)
  S-->>C: SYNC_END(req_id=3, ok=true)

  S-->>C: KICK(reason=SERVER_RESTART)
  Note over C: 指数退避后重连
```

### 5.2 握手（必须按顺序）

```
1. 建立 TCP/WebSocket 连接
2. 客户端立即发送 AUTH 帧
3. 服务端校验
   ├─ 成功 → 回 AUTH_OK，连接进入就绪态
   └─ 失败 → 回 ERROR，然后【服务端主动关闭连接】
4. 若 5 秒内未收到 AUTH 帧，服务端主动断开
```

> **超时保护**：服务端对未鉴权连接有 5 秒超时，防止连接资源被空占。

### 5.3 心跳

| 参数 | 值 |
|---|---|
| 客户端发送 PING 间隔 | `heartbeat_sec`（AUTH_OK 返回，默认 30 秒） |
| 服务端 idle 判定 | 60 秒无任何数据 |
| 服务端断开阈值 | 90 秒无任何数据 |

**规则：**

- 任一方收到 `PING` → 立即回 `PONG`
- 客户端也可以用任何帧代替 PING（有数据即视为活跃）
- 客户端若 90 秒没收到任何服务端数据 → 认为连接已死，主动重连

> **不要只依赖 TCP keepalive**。中间设备（NAT、LB）会静默切断闲置连接，
> 应用层心跳是唯一可靠的存活检测。

### 5.4 强制下线（KICK）

```protobuf
KickNotice {
  reason: 3,                        // 3 = SERVER_RESTART
  detail: "server restarting",
  retry_after_ms: 2000
}
```

| reason | 含义 | 客户端应做 |
|---|---|---|
| 1 | `OTHER_DEVICE` | 提示「已在其他设备登录」，停止重连 |
| 2 | `SUSPENDED` | 提示账号被停用，停止重连 |
| 3 | `SERVER_RESTART` | **按 `retry_after_ms` 退避重连** |
| 4 | `AUTH_EXPIRED` | 刷新 token 后重连 |

> **「停止重连」对顶号那一种是硬要求，不是优化。** 长连接上的 `AUTH` 就是一次登录，
> 而服务端对同一账号是**后到的连接顶掉先到的**（`LocalConnectionRegistry`，DESIGN §7.4）。
> 于是被顶下线的那一台若按退避重连，它 `AUTH` 的那一下子就把**刚登录的那台**顶掉了；
> 那台再重连又顶回来——两台设备永远互相顶号，**谁都收不到消息**，而日志上看起来
> 只是「一直在重连」。实测（两个连接的脚本化 A/B，见 `tools/probe_kick_other_device.py`）：
> 每一轮重连都换成对方收到 `KICK(1)`，三轮回合下来两台轮流被踢。
>
> 停在这一层还不够：**本地凭证也要作废**（各客户端的「被踢下线」处理里清掉
> token 并回登录页）。否则重启应用 / 刷新页面时，客户端会拿同一份凭证**自动又登录一次**
> ——在「重启一下」「刷新一下」这个粒度上继续互顶。这也是为什么顶号之后用户
> 需要重新输一次口令，而不是等一会儿就自己好了（`SERVER_RESTART` 才是那一种）。
>
> `AUTH_EXPIRED`（4）那一行的「刷新 token 后重连」，H5 已经做了（2026-10-21）：断线
> 撞上 access token 过期时，重连前先走一次 REST（`/v1/me`）续期，再带上新凭证连——
> 登录归登录、长连接只管消息，普通断线自己重连、不退出登录。真正的登出只剩下
> `refresh_token` 也失效（40104）那一条，而它由 REST 层决定（客户端不自己重登）。

### 5.5 错误帧的 `message` 里是什么（**别拿它当文案**）

```protobuf
ErrorFrame { code: 40003, message: "not friends", retryable: false }
```

| 字段 | 是什么 | 客户端该怎么做 |
|---|---|---|
| `code` | **唯一的判据**（07-errors-limits.md §2 的表） | 用它决定动作（改请求 / 重试 / 引导用户去加好友） |
| `message` | 错误码表里那一句固定的英文（恒等于该 `code` 的文案）。个别请求形状类的错误（`40000`/`40001`/`40002`）后面会跟一句**给客户端开发者**的解释，例如 `bad request: CMD_SYNC_RESP 是服务端专用命令字` | 只进日志；**不要**把它当成给最终用户的文案 |
| `retryable` | 这个操作假定幂等时能否安全重试 | 决定要不要自动重试 |

> **`message` 里不会有服务端的内部状态。** 曾经它会带上判据的入参
> （`not friends: convType=DIRECT,isMember=true,friendship=PENDING`），于是一个把
> `message` 直接显示给用户的客户端，界面上出现的就是一行日志（用户的原话：
> 「不要出现类似『服务端拒绝：code=40003 not friends』这样的日志形式的提示」）。
> 现在这类 detail 只进服务端日志，线上只有错误码表里那一句
> （`Frames.error` / `errorWithDetail` 两个方法把这条规则写在调用点上，
> `FramesTest.errorAndErrorWithDetailDifferByIntent` 钉住它）。
>
> 同一件事在 REST 侧早就是这样：`ApiExceptionHandler` 只回 `code` 与固定文案，
> detail 进日志。两条链路对同一个错误现在有同一种行为。

---

## 6. 断点续传（核心机制）

> ✅ **服务端读取路径已实现**（DESIGN §10.2）。本节描述的字段、方向与载荷已冻结（§2.3，有机器校验），
> 客户端按本节实现即可，不需要在“服务端还没做”这件事上做任何兼容分支。

### 6.0 服务端的行为承诺

下面每一条都是**可验证**的（右列是钉住它的测试用例，`tools/verify_integration_docs.py` 会检查
这些用例名真的存在——文档引用在代码里找不到的用例，也是一类漂移）。

| 服务端承诺 | 具体含义 | 钉住它的用例 |
|---|---|---|
| 只按 `seq > since_seq` 查 | 与断线时长、消息产生时间完全无关（§6.3） | `MessageSyncIT.syncReturnsExactlyTheMissingRangeInOrder` |
| 每会话最多 `limit` 条 | 客户端传的 `limit` 会被收敛到 `tm.message.max-pull-size`（默认 200） | `MessageServiceTest.syncClampsPageSize` |
| `has_more` 是精确值 | 服务端会多读一行来判断「还有没有」，不是估计值 | `MessageServiceTest.syncReportsHasMoreByFetchingOneExtraRow` |
| `has_more=true` 时本帧必有消息 | 客户端总能把游标往前推，不会死循环 | `MessageServiceTest.syncReportsHasMoreByFetchingOneExtraRow` |
| `has_more=true` 时**不发** `SYNC_END` | 否则客户端会以为已追平（§6.2） | `TwoClientEndToEndTest.syncDoesNotSendEndWhileMoreRoundsArePending` |
| 补齐时 `SYNC_RESP` 后紧跟一帧 `SYNC_END` | 两帧 `req_id` 相同，且落在同一个 TCP 段里 | `TwoClientEndToEndTest.syncDeliversTheGapAndEndsTheRound` |
| 一次最多带 N 个会话游标 | 超出回 `40002` 并要求分批（`tm.message.max-cursors-per-sync`，默认 50） | `MessageServiceTest.syncRejectsTooManyCursors` |
| 非成员/已不存在的会话被跳过 | 整轮不因它失败；被跳过的会话在 `SYNC_END.message` 里点名 | `MessageSyncIT.nonMemberCursorIsSkippedWithoutLeakingItsMessages` |
| 失败时回 `CMD_ERROR`（可重试） | 不会静默回一帧空结果：假成功比报错危险得多 | `TwoClientEndToEndTest.syncFailureIsReportedInsteadOfSilentSuccess` |
| `truncated` 目前恒为 `false` | 服务端还没做归档，没有依据说「补不齐」（§6.4） | `MessageSyncIT.seqHolesAreLegalAndAreNotReportedAsTruncation` |

服务端的实现取舍（为什么是「多读一行」而不是查 `max_seq`、为什么非成员游标只跳过不报错、
为什么 `truncated` 不能从「某行不存在」反推）写在 DESIGN §10.2——那是服务端自己需要解释的东西，
接入方只需依赖上表。

### 6.1 客户端需要持久化的唯一状态

**每个会话一个整数**：最后处理到的 `seq`。

```json
{ "1001": 7, "1002": 23 }
```

### 6.2 重连后的同步流程

```
1. 重连 + AUTH
2. 构造 SYNC 请求，带上所有会话的 last_seq
3. 服务端按 (conv_id, seq) 升序返回缺失消息（一帧 CMD_SYNC_RESP）
4. 若 has_more=true，按 §6.5 推进游标（每个会话推到本帧里**该会话**最后一条的 seq）后继续发 SYNC，直到 false
5. 收到 SYNC_END 后，恢复正常实时接收
```

**请求（`CMD_SYNC` = 14，C→S，载荷 `SyncRequest`）：**

```protobuf
SyncRequest {
  cursors: [
    { conv_id: 1001, since_seq: 7 },     // 只要 seq > 7 的消息
    { conv_id: 1002, since_seq: 23 }
  ],
  limit: 200
}
```

> **两个请求侧的约束**（本地会话很多的客户端需要知道）：
> 游标数不能超过 `tm.message.max-cursors-per-sync`（默认 50，超出回 `40002` 并要求分批），
> 同一个 `conv_id` 不能出现两次（回 `40002`——「该按哪个游标算」没有定义，服务端不会替你挑一个）。
> 分批时各批互不影响：每批有自己的 `has_more` 与自己的一对 `SYNC_RESP`/`SYNC_END`。

**响应（`CMD_SYNC_RESP` = 16，S→C）：一次请求恰好收到一帧**，`req_id` 原样回传：

```protobuf
Frame {
  cmd: 16,                          // CMD_SYNC_RESP（不是 14——见 §2.3）
  req_id: <原样回传>,
  payload: SyncResponse {
    messages: [ /* 按 (conv_id, seq) 升序 */ ],
    has_more: false,
    truncated: false
  }
}
```

| 响应字段 | 客户端应做 |
|---|---|
| `has_more = true` | 按 §6.5 推进游标后再发一次 `CMD_SYNC`（本帧一定至少有一条消息，所以循环必然收敛） |
| `has_more = false` | 紧接着会收到一帧 `CMD_SYNC_END`，此后恢复正常接收 |
| `truncated = true` | 服务端补不齐（超出消息保留期），改用 REST 拉历史（§6.4） |

> **载荷缺失不等于解析失败**：当本轮没有任何消息、且 `has_more`/`truncated` 都是默认值（`false`）时，
> 整个 `SyncResponse` 的字段都是默认值，而 proto3 不编码默认值——线上就是<b>没有 `payload` 字段</b>。
> 最正常的「没什么要补」就是这个形状，客户端必须把它当成空的 `SyncResponse`
> （拿不到 `payload` 时按「空消息 + `has_more=false`」处理）。由
> `TwoClientEndToEndTest.syncReportsSkippedCursorsInTheEndFrame` 钉住这一形状。

```protobuf
Frame {
  cmd: 15,                              // CMD_SYNC_END
  req_id: <与上面那帧相同>,
  payload: SyncEnd { ok: true, conv_synced: 2 }
}
```

> **`CMD_SYNC_END` 只在 `has_more=false` 时出现。** `has_more=true` 时不得发它——
> 否则客户端会在还没补齐的情况下以为已经追平，接着开始接收实时推送，
> 而中间缺的那段再也没人补。
>
> **命名提醒：**`CMD_SYNC`（14，C→S）是「我来拉」，`CMD_SYNC_RESP`（16，S→C）是「给你」，
> `CMD_SYNC_END`（15，S→C）是「这轮完了」。三者方向固定，不存在同一编号双向的情况。

### 6.3 为什么不会丢消息

服务端只按 **`seq > since_seq`** 查询，与断线时长、消息产生时间**完全无关**。

```
断线期间产生 seq=8,9,10；客户端 last_seq=7
重连 SYNC(since_seq=7) → 返回 8,9,10   ✓ 一条不漏
```

### 6.4 服务端截断（`truncated`）

`truncated = true` 的含义是「你要的区间里有一部分服务端已经给不出来了」，此时客户端应改用 REST 拉历史：

```http
GET /v1/conversations/1001/messages?limit=200&cursor=...
```

**当前实现不会置位它，这是刻意的**：`seq` 在会话内允许有空洞（发消息时「取号即消耗」，
重试、对账都会留下空洞），所以「某一行不存在」推不出「已被删除」——把空洞当成截断，
客户端会去做一次没有意义的 REST 重拉（拿到的是同一批消息）。
真正能回答「补得齐吗」的只有归档/清理任务的**水位**（「本会话 `seq <= N` 的消息已归档」）；
它落地后，服务端才应据此置位。在此之前，SYNC 返回的就是库里现存的全部消息——
所谓「保留期」目前由归档任务定义，而它尚未上线。

### 6.5 推进游标的规则（最容易写错的一处）

客户端为每个会话维护的 `last_seq` 语义必须精确：
**「`seq <= last_seq` 的消息我已经全部处理完」**。由此推出三条处置：

| 情况 | 该做什么 |
|---|---|
| `seq <= last_seq` | 忽略：重复投递，去重即可 |
| `seq == last_seq + 1` | 处理它，`last_seq = seq` |
| `seq > last_seq + 1`（中间有洞） | **先补洞**：用当前 `last_seq` 发一次 `SYNC`，把整段补齐后再推进 |

为什么第三条必须这样：`seq` 允许有空洞，而**客户端分不清「这个号从来没用过」与「有这个号只是我没收到」**。
把游标直接跳到洞后面的序号，等于把「没收到」判成「不存在」——那条消息再也不会被补回来。
宁可多拉一次（最坏拿到一帧空响应，只花一个往返）。

反过来，服务端给的两条保证让这个循环必然收敛：`seq > last_seq` 的消息一条都不会少（§6.3），
且 `has_more=true` 时本帧一定有消息可以推进游标（§6.0）。

---

## 7. 客户端实现要点清单

| # | 要点 | 说明 |
|---|---|---|
| 1 | **区分两种承载** | WebSocket 无长度前缀；TCP 必须 4 字节大端前缀 |
| 2 | **处理字段缺失** | protobuf3 默认值不编码，`req_id=0` 时字段不出现 |
| 3 | **AUTH 必须第一帧** | 5 秒超时会被断开 |
| 4 | **req_id 配对** | 并发请求靠它区分响应；推送的 req_id 恒为 0 |
| 5 | **按 seq 去重，但别把 last_seq 当成水位** | 已处理过的 `seq` 直接忽略；但「当前游标」是「连续处理到哪」，不是「见过的最大号」——`PUSH` 可丢，`seq > last_seq + 1` 说明中间有洞，要用 `last_seq` 发一次 `SYNC`（§6.5） |
| 6 | **持久化 last_seq** | 每个会话一个整数，本地落盘 |
| 7 | **应用层心跳** | 不要依赖 TCP keepalive |
| 8 | **指数退避重连** | 1s → 2s → 4s → … 上限 30s，加抖动 |
| 9 | **识别 KICK** | 不同 reason 处理策略不同，不要盲目重连 |
| 10 | **UTF-8 长度按字节算** | 中文 3 字节，LEN 是字节数不是字符数 |
| 11 | **不要回显服务端帧** | `CMD_PUSH`/`CMD_SYNC_RESP`/`CMD_SYNC_END` 等只由服务端发出，发过去会得 40000（§2.3） |

### 7.0 界面上显示什么（一条来自真实用户反馈的规则）

服务端的 `message` 是给**开发者**看的（英文、固定文案），不是给用户看的。
客户端应当把 `code` 映射成自己的文案（中文短句 + 下一步该做什么），`code` 本身只在
「详情 / 诊断信息」里出现（用户报障时能复制给支持）。参考实现：

```
40003 → 「你们还不是好友」+「在『通讯录 → 加好友』里发送请求，对方同意之后就能发消息了」+ 一个「去加好友」按钮
40304 → 「对方已把你拉黑」+「重试没有用」                       （不给重试按钮）
42901 → 「操作太快了，慢一点再试」+「等几秒再试」                （给重试按钮）
```

`web/h5/src/api/errors.ts` 里那张表就是它的一份实现（每个码一句「发生了什么」+
一句「下一步」，`tests/unit/user-facing-errors.test.ts` 断言可见文案里不出现
`code=`/英文原文这种日志形状的内容）。

### 7.1 重连退避参考实现

```python
import random, time

def backoff_sequence(base=1.0, cap=30.0, jitter=0.3):
    """1, 2, 4, 8, 16, 30, 30... 加上 ±30% 抖动（防惊群）"""
    n = 0
    while True:
        delay = min(cap, base * (2 ** n))
        yield delay * (1 + random.uniform(-jitter, jitter))
        n += 1
```

> **抖动（jitter）不是可选项**。服务端重启时，若所有客户端同时按相同间隔重连，
> 会造成「惊群」——瞬间打满服务端。

---

## 8. 不想实现 Protobuf？用 REST 轮询代替

如果你不想实现 protobuf 编解码，**完全可以不用长连接**。

用 REST 增量拉取 + 轮询：

```python
import time, httpx

cursors = {1001: 0, 1002: 0}   # 本地持久化

while True:
    for conv_id, last_seq in list(cursors.items()):
        r = httpx.get(
            f"http://localhost:8080/v1/conversations/{conv_id}/messages",
            params={"since_seq": last_seq, "limit": 200},
            headers={"Authorization": f"Bearer {API_KEY}"},
            timeout=10,
        )
        data = r.json()["data"]
        for msg in data["items"]:
            handle(msg)                      # seq 升序
            cursors[conv_id] = msg["seq"]
        # 有更多就立即继续，不要睡
        while data["has_more"]:
            r = httpx.get(..., params={"since_seq": cursors[conv_id]})
            data = r.json()["data"]
            for msg in data["items"]:
                handle(msg)
                cursors[conv_id] = msg["seq"]

    time.sleep(2)   # 轮询间隔
```

**代价对比：**

| | 长连接 | REST 轮询 |
|---|---|---|
| 实时性 | 毫秒级 | 轮询间隔（如 2 秒） |
| 服务端压力 | 低（推送时才消耗） | 高（空轮询也消耗） |
| 实现复杂度 | 中（需 protobuf） | **低（只需 HTTP+JSON）** |
| 适用 | 高并发、实时聊天 | 验证、低频、Serverless |

> **建议**：先跑通 REST，确认业务逻辑正确，再按需升级到长连接。
> 两者的**语义完全一致**（同样的 `seq`、同样的幂等），所以升级不会破坏已有代码。
`,L=`# 03 · REST API 参考

> 所有接口遵循统一约定。人类客户端与 Agent 调用**完全相同的接口**，只是凭证不同。

---

## 1. 通用约定

### 1.1 基址

```
https://<host>:8080/v1
```

### 1.2 请求头

```http
Authorization: Bearer <jwt 或接管密钥>
Content-Type: application/json; charset=utf-8
X-TM-Device-Id: web-chrome-131          # 可选
```

`X-TM-Device-Id` 是客户端自报的设备标识，用于让服务端在日志与账号安全页面里
回答「这个人同时在几个设备上」。它**不参与鉴权**（伪造它不会得到任何权限），
也不需要与长连接 `AUTH` 帧里的 `device_id` 一致——但建议一致，否则两边的日志对不上。

> 长连接有 `AUTH` 帧可以放 `device_id`，REST 没有帧，所以约定一个请求头。

### 1.3 统一响应包络

**成功：**

```json
{
  "code": 0,
  "message": "ok",
  "data": { ... }
}
```

**失败：**

```json
{
  "code": 40003,
  "message": "not friends",
  "data": null
}
```

> **注意**：业务错误也返回 **HTTP 200**，通过 `code` 区分（`code=0` 为成功）。
> 只有认证类错误返回 HTTP 401/403。这是为了让客户端只需判断一个 `code` 字段。

### 1.4 HTTP 状态码与业务码的关系

| HTTP | 何时 |
|---|---|
| 200 | 业务处理完成（**包括业务失败**，看 `code`） |
| 401 | 认证失败（见 02-auth.md） |
| 403 | 已认证但没这个权限：账号被停用（`40301`）、权限不足（`40302`）、不是会话成员（`40303`） |
| 404 | **路由不存在**（不是资源不存在） |
| 429 | 限流 |
| 500 | 服务端异常 |

**资源不存在**返回 `200 + code=404xx`：通用 `40400`，并能细到 **谁** 不存在——`40401` Actor、
`40402` 会话、`40403` 消息、`40404` 动态。客户端对「会话不存在」与「消息不存在」该做的动作不同
（前者清本地会话，后者只是这一条渲染不出来），所以不能合并成一个泛码。

### 1.5 分页

统一用**游标分页**（不用 offset）：

```
GET /v1/conversations/1001/messages?limit=50&cursor=<opaque>
```

响应：

```json
{
  "code": 0,
  "data": {
    "items": [ ... ],
    "next_cursor": "eyJzZXEiOjd9",   // null 表示没有更多
    "has_more": true
  }
}
```

> 消息接口另有 `since_seq` 增量模式（见 §4.3），推荐实时同步使用。

**游标的三个约定**（客户端只需知道前两条）：

1. **不透明**：服务端给什么就回什么，不要解析、不要自己拼、不要跨接口复用。
2. **`next_cursor` 为 `null` 就真的没有更多了**；`has_more` 是精确值（不是「这一页满了吗」的猜测），
   两者永远一致。
3. **游标是「位置」而不是「偏移量」**：它表达「比这一项更旧/更早」，因此
   翻页期间新产生的数据不会把它错位。代价是最坏情况下同一条可能被看到两次
   （客户端按 `conv_id`/`message_id` 去重即可）——「看到两次」比「静默漏掉一条」
   对 IM 而言可接受得多。

服务端会拒绝**坏的与贴错的**游标（`40010`）：两种游标（会话列表按活跃时间、消息按 `seq`）
各自带类型与版本，互不通用。它不签名——伪造它拿不到任何数据，只能让自己看到自己的列表。

也因此，游标**不是可以长期缓存的本地状态**：服务端改游标结构时会让旧游标被判为「不认识」
（同样 `40010`）。收到这个码的正解是**丢掉本地游标从头拉一页**，而不是重试同一个游标——
重试永远得不到别的结果。

### 1.6 时间格式

统一 **ISO 8601 UTC 毫秒**：`2026-01-01T08:00:00.123Z`

### 1.7 「指向一个人」的两种写法（`@handle` 与 `actor_id`）

凡是请求体里要写「一个人」的地方（`peer`、`members`、之后的 `target`），都接受两种写法：

| 写法 | 含义 | 例 |
|---|---|---|
| `@handle` | 按 handle 查（大小写不敏感） | `"@alice"`、`"@Weather_Bot"` |
| 纯数字 | 按 Actor ID 查 | `"1001"` |

**不带 `@` 的字符串一律被拒绝（`40002`）**，而不是猜——因为 handle 本身允许数字
（`^[A-Za-z0-9_]{3,32}$`），`"1001"` 既可能是 handle 也可能是一个 Actor ID，
而两者指向的人不同。猜错的后果是「消息发给了另一个人」，重试也修不回来。
数字形式的 handle 只能用 `"@1001"` 访问。

查不到人回 `40401`；handle 形状不合法（少于 3 位、含非法字符）回 `40004`。
Actor 的 `status` **不参与**这个解析：已停用账号的公开资料仍然看得到（`403` 只留给「用它做事」）。

### 1.8 在线标志（`online`）

`GET /v1/me`、好友列表、会话列表里的 `peer`、会话详情的 `members[]` 都带一个 `online` 布尔值：

```json
{ "online": true }
```

| 值 | 含义 |
|---|---|
| `true` | 该 Actor 的长连接挂在**某个存活节点**上（本节点连接表命中，或 Redis `tm:route` 指向一个心跳未过期的节点） |
| `false` | 没有连接，或它所在的节点已经失联（最坏情况是节点崩溃后 `tm.node.ttl`，默认 45 秒） |

> **它是快照，不是订阅**：长连接协议里没有 presence 命令字，上线/下线不会推送。
> 客户端按自己的节奏重新拉列表（用户端 H5 / 安卓 App 是 30 秒）即可。
>
> **它不参与任何权限判断**：离线的人照样能收消息（落库后等重连 SYNC），
> 「在线」只影响界面上的一个小圆点。Redis 不可用时所有人显示为离线——
> 这是有意的降级，不是「这个人真的不在」。
>
> **群聊没有 `online`**：`conversation.peer` 只有单聊才有；群成员各自的在线状态在
> `GET /v1/conversations/{conv_id}` 的 `members[]` 里。

---

## 2. 身份与账号

### 2.1 获取当前身份

```http
GET /v1/me
```

```json
{
  "code": 0,
  "data": {
    "actor_id": 1001,
    "actor_type": 1,
    "handle": "alice2026",
    "display_name": "Alice",
    "avatar_url": null,
    "bio": "提供全球天气查询",
    "status": 1,
    "created_at": "2026-01-01T08:00:00.000Z",
    "online": true
  }
}
```

> **它不带接管信息**：接管是账号自己的另一份东西，读它走
> `GET /v1/me/agent-takeover`（§7）。`/v1/me` 回答的只有「我是谁」——
> 把两件事塞进一个响应，会让每个只想拿昵称的客户端都顺带拿到一份运维配置。

### 2.2 查询任意 Actor

```http
GET /v1/actors/{actor_id}
GET /v1/actors/by-handle/{handle}
```

```json
{
  "code": 0,
  "data": {
    "actor_id": 1001,
    "actor_type": 1,
    "handle": "alice",
    "display_name": "Alice",
    "avatar_url": "https://.../a.png",
    "bio": null,
    "status": 1,
    "online": false,
    "relation": {                 // 我与他的关系（便于客户端渲染按钮）
      "is_friend": true,
      "friend_status": 2,         // 1=PENDING 2=ACCEPTED 3=BLOCKED
      "initiated_by_me": false
    }
  }
}
```

### 2.3 更新我的资料

```http
PATCH /v1/me
Content-Type: application/json

{
  "display_name": "新名字",
  "avatar_url": "https://.../new.png",
  "bio": "签名"
}
```

### 2.4 搜索 Actor

```http
GET /v1/actors/search?q=weather&limit=20
```

```json
{
  "code": 0,
  "data": {
    "items": [
      {"actor_id": 2002, "actor_type": 2, "handle": "weatherbot2026",
       "display_name": "天气助手", "relation": {"is_friend": false}}
    ],
    "next_cursor": null
  }
}
```

---

## 3. 好友

> **一次「加好友」只有一行记录**：请求的生命周期与关系的状态存在同一行上
> （{@code friendship.status}：`1=PENDING 2=ACCEPTED 3=BLOCKED`）。
> 分开成「好友请求表 + 好友关系表」看起来更规整，但它让「请求被接受了」
> 与「关系存在」变成两次写入——中间任何一次失败或并发交错，都会留下
> 「请求说已接受、关系表说不是好友」这种状态，而它的表现是
> **用户明明同意了，对方却发不出消息**（`40003`）。

### 3.1 发送好友请求

> **不受「非好友不能发消息」限制**——这是新用户建立关系的唯一入口（详见 01-concepts §7）。

```http
POST /v1/friends/requests
Content-Type: application/json

{
  "target": "@alice",              // 或用 {"target_actor_id": 1001}
  "message": "你好，我是天气助手"    // 可选，附言
}
```

```json
{
  "code": 0,
  "data": {
    "request_id": 550000000000000001,
    "from_actor": 2002,
    "to_actor": 1001,
    "status": 1,                    // 1=PENDING
    "expires_at": "2026-01-08T08:00:00.000Z"
  }
}
```

**可能的业务错误：**

| code | 含义 |
|---|---|
| 40904 | 不能加自己为好友 |
| 40901 | 已是好友 |
| 40902 | 已有待处理请求 |
| 40903 | 处于拉黑关系（`tm.friend.allow-request-after-block` 控制能否重试） |
| 40401 | `target` 查不到 |
| 40002 | 附言超 255 字符 |
| 42903 | 超出好友请求日配额（人类 50、Agent 100） |

**`40902` 的两个方向共用一个码**（我发出的、或对方发给我的）：两者的客户端动作
都是**去看请求列表**——如果那条是对方发起的，同意它即可成为好友，不必再发一次。
两者合起来才是「这件事已经有人在做了」。

**过期的 `PENDING` 行按「不存在」处理**（不会挡住重新发起，也不需要清理任务）：
判断过期只需比一次 `expires_at`，而那一行会在下一次请求时被整个覆盖
（换一个新的 `request_id`）。

### 3.2 处理好友请求

```http
POST /v1/friends/requests/{request_id}/accept
POST /v1/friends/requests/{request_id}/reject
```

```json
{
  "code": 0,
  "data": {
    "request_id": 550000000000000001,
    "actor_a": 1001,
    "actor_b": 2002,
    "status": 2,                    // 2=ACCEPTED；拒绝时是 0
    "updated_at": "2026-01-01T08:05:00.000Z",
    "conv_id": 1001                 // ★ 成为好友后自动创建的单聊会话；拒绝时为 null
  }
}
```

> **便利设计**：accept 后直接返回 `conv_id`，客户端可立即开始聊天，无需再调创建会话接口。
>
> **`status=0` 不是一个状态码**，它的含义是「这段关系已不存在」：拒绝即删除
> （DESIGN §11.4），留着那一行就必须回答「这行是待处理还是被拒过」，
> 而后者会让被拒的一方在重新发起时被区别对待。删除之后双方都能干净地重来。
>
> **同意是幂等的**（可安全重试，见 07-errors-limits §3.5）：重复同意返回**同一个**
> `conv_id`，而不是一个「已经同意了」的错误。拒绝不是幂等的（第二次回 `40400`）。

| code | 含义 |
|---|---|
| 40400 | 请求不存在，或已过期 |
| 40302 | 这条请求不是发给我的（含「自己同意自己发起的」） |

### 3.3 待处理请求列表

```http
GET /v1/friends/requests?direction=incoming&status=pending
```

`direction`: `incoming`（收到的，**默认**）| `outgoing`（发出的）
`status`: `pending`（**默认**，只看待处理，且滤掉已过期的）| `all`（含已接受/已拉黑的历史）

> 两个默认值都写在服务端：客户端的首页动作是「有没有人加我」，
> 而让客户端自己决定默认值的话，两种客户端会在同一个 URL 上得到相反的列表。
> 取值写错（如 `direction=sideways`）回 `40002`，不静默按默认值处理。

```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "request_id": 550000000000000001,
        "from_actor": {"actor_id": 2002, "handle": "weatherbot2026",
                       "display_name": "天气助手", "actor_type": 2},
        "to_actor": {"actor_id": 1001, "handle": "alice"},
        "message": "你好，我是天气助手",
        "status": 1,
        "created_at": "2026-01-01T08:00:00.000Z",
        "expires_at": "2026-01-08T08:00:00.000Z"
      }
    ],
    "next_cursor": null
  }
}
```

### 3.4 好友列表

```http
GET /v1/friends?limit=50&cursor=...
```

按**成为好友的时间**倒序（`friends_since`），同毫秒内按请求 id 定序。

```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "actor_id": 1001, "actor_type": 1, "handle": "alice",
        "display_name": "Alice", "avatar_url": null,
        "friends_since": "2026-01-01T08:05:00.000Z",
        "online": true
      }
    ],
    "next_cursor": null,
    "has_more": false
  }
}
```

### 3.5 删除好友

```http
DELETE /v1/friends/{actor_id}
```

```json
{ "code": 0, "data": { "actor_id": 1001, "target_id": 1002, "removed": true } }
```

**副作用**：删除好友后，双方单聊**无法再发消息**（返回 `40003`），但**历史消息仍可见**。

> **幂等**：本来就不是好友时也返回成功（`removed=false`）。这里与「踢群成员」刻意不同
> （那里目标不在群里回 `40908`）——因为两者的客户端目标状态不同：踢人是「让这个人不在群里」，
> 而删好友的目标（我们不再是好友）已经成立。而且这个接口只能删自己的好友，
> 所以不存在「把别人的 id 拼错却以为删成功」的风险。
>
> **不动会话**：删好友不会删掉单聊会话（否则历史记录会凭空消失），
> 会话里双方此后发消息得到 `40003`。

### 3.6 拉黑 / 解除拉黑

```http
POST   /v1/friends/{actor_id}/block
DELETE /v1/friends/{actor_id}/block
```

```json
{ "code": 0, "data": { "actor_id": 1001, "target_id": 1002, "blocked": true } }
```

拉黑后：对方无法给你发消息（`40304`，不是 `40003`——客户端该停止重试而不是去加好友）、
无法发好友请求（`40903`）、看不到你的非公开动态。

> 拉黑**复用同一行**并把状态改成 `BLOCKED`：它同时表达了「我们不再是好友」与
> 「不许再加我」。分两张表的话，「他是好友但被拉黑了」这种组合就得在每个读取点各自处理。
>
> **解除拉黑只删 `BLOCKED` 的行**：当前是 `ACCEPTED` 时它什么都不做，
> 否则一次「解除拉黑」会悄悄删掉一段真实的好友关系。
> 反过来说，**解除拉黑不等于恢复好友**——那只意味着可以重新加一遍。

---

## 4. 会话与消息

### 4.1 获取或创建单聊会话

```http
POST /v1/conversations/direct
Content-Type: application/json

{ "peer": "@alice" }
```

```json
{
  "code": 0,
  "data": {
    "conv_id": 1001,
    "conv_type": 1,
    "peer": {"actor_id": 1001, "handle": "alice", "display_name": "Alice", "online": true},
    "created": false,               // false 表示复用已存在的会话
    "last_seq": 7
  }
}
```

> **幂等**：重复调用返回同一条会话（`created: false`）。
>
> **不要求双方是好友**：建一个空会话不会把任何内容送给对方，所以 §4.1 里没有 40003。
> 「非好友不能发消息」是**发送**那条接口的规则（见 §4.5）——
> 在这里就拦的话，「先点开会话、再决定说什么」这个正常交互会变成必须先加好友，
> 而加好友本身也要先找到这个人。

| code | 含义 |
|---|---|
| 40001 | `peer` 缺失 |
| 40002 | `peer` 写法不合法（不带 `@` 又不是纯数字，见 §1.7） |
| 40004 | `handle` 形状非法 |
| 40401 | `peer` 查不到 |
| 40904 | 想和自己建会话 |

### 4.2 创建群聊

```http
POST /v1/conversations/group
Content-Type: application/json

{
  "title": "天气讨论组",
  "members": ["@alice", "@bob", "@weatherbot2026"]    // 不含自己
}
```

```json
{
  "code": 0,
  "data": {
    "conv_id": 1002,
    "conv_type": 2,
    "title": "天气讨论组",
    "owner_actor": 1001,
    "member_count": 4,
    "created_at": "2026-01-01T08:10:00.000Z"
  }
}
```

> **群聊不要求成员互为好友**（否则 3 人群要求 3 对好友关系，不可行）。

**可能的业务错误：**

| code | 含义 |
|---|---|
| 40001 | `title` 或 `members` 缺失 / 为空 |
| 40002 | `title` 超 128 字符，或成员列表里除了自己没别人 |
| 40004 | 某个成员写法不合法（见 §1.7） |
| 40401 | 某个成员查不到 |
| 40906 | 成员数超过单群上限（默认 500） |

成员列表会**按请求顺序去重**：同一个 handle 写两遍不报错，也只算一个人；把自己写进去同样不报错
（建群者必然是成员）。这些都不是错误，只是客户端复制粘贴的常见结果，报错也修不好。

### 4.3 我的会话列表

```http
GET /v1/conversations?limit=50&cursor=...
```

```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "conv_id": 1001,
        "conv_type": 1,
        "peer": {"actor_id": 1001, "handle": "alice", "display_name": "Alice", "online": true},
        "title": null,                       // 单聊为 null，群聊为群名
        "last_seq": 7,
        "last_read_seq": 5,
        "unread_count": 2,                   // = last_seq - last_read_seq
        "member_count": 2,                   // 单聊恒为 2
        "last_message": {
          "message_id": 730000000000000001,
          "seq": 7,
          "sender_id": 2002,
          "msg_type": 1,
          "content": {"text": "你好，Agent"},
          "created_at": "2026-01-01T08:00:00.123Z"
        },
        "muted": false,
        "updated_at": "2026-01-01T08:00:00.123Z"
      }
    ],
    "next_cursor": null
  }
}
```

> **未读数 = `last_seq - last_read_seq`**，服务端已算好。

### 4.4 会话详情

```http
GET /v1/conversations/{conv_id}
```

包含成员列表：

```json
{
  "code": 0,
  "data": {
    "conv_id": 1002,
    "conv_type": 2,
    "title": "天气讨论组",
    "owner_actor": 1001,
    "member_count": 4,
    "last_seq": 23,
    "my_last_read_seq": 20,
    "members": [
      {"actor_id": 1001, "handle": "alice", "role": 1, "joined_at": "...", "online": true},
      {"actor_id": 2002, "handle": "weatherbot2026", "role": 3, "joined_at": "...", "online": false}
    ]
  }
}
```

### 4.5 发消息 ★ 最核心的接口

```http
POST /v1/conversations/{conv_id}/messages
Content-Type: application/json
```

**请求体：**

```json
{
  "msg_type": "TEXT",
  "client_msg_id": "c-7f3a9b21",
  "content": { "text": "你好，Agent" },
  "reply_to": null
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `msg_type` | ✅ | `TEXT` / `IMAGE` / `SYSTEM` |
| `client_msg_id` | ✅ | **幂等键**，客户端生成 |
| `content` | ✅ | 见下方内容格式 |
| `reply_to` | ❌ | 引用的 `message_id` |

> **文本消息的渲染约定**（DESIGN §4.1）：`content.text` 就是作者写下的那串字符，
> **服务端不解析、不转义**，只做长度上限（`tm.message.max-text-length`，默认 5000）。
> 用户端 H5 把它按 Markdown 渲染（段落/标题/围栏代码/引用/列表/粗斜删/行内代码/链接），
> 并把**原始 HTML 当普通文字**；地址只认 `http`/`https`/`mailto`，其余原样显示。
> 接入方可以放心用 Markdown 写正文（Agent 回 Markdown 会渲染），
> 但不要依赖它渲染 HTML——那条路在客户端是刻意不存在的。

**`content` 按 `msg_type` 的结构：**

```json
// TEXT
{ "text": "你好" }

// IMAGE（先上传拿 media_id，见 §5）
{
  "media_id": 660000000000000001,
  "width": 1280,
  "height": 720,
  "thumb_media_id": 660000000000000002
}

// SYSTEM（由服务端产生，客户端发会被 40302 拒；取值见 §4.9 的 action 表）
{ "action": "member_joined", "actor_id": 1001, "handle": "bob", "display_name": "Bob" }
```

**成功响应：**

```json
{
  "code": 0,
  "data": {
    "message_id": 730000000000000001,
    "conv_id": 1001,
    "seq": 7,
    "client_msg_id": "c-7f3a9b21",
    "sender_id": 2002,
    "msg_type": "TEXT",
    "content": { "text": "你好，Agent" },
    "created_at": "2026-01-01T08:00:00.123Z"
  }
}
```

**幂等重放**：用同一 `client_msg_id` 再发 → 返回**完全相同**的响应（`seq` 也是 7），不产生新消息。

**业务错误：**

| code | 含义 | 处理 |
|---|---|---|
| 40003 | **非好友，不能发消息**（单聊） | 先走加好友流程 |
| 40402 | 会话不存在 | 清掉本地会话，检查 conv_id |
| 40303 | 不是该会话成员 | 退出这个会话 |
| 40304 | 已被对方拉黑 | **停止重试**：加好友也没用 |
| 40007 | `msg_type` 不认识 | 检查 `TEXT`/`IMAGE`/`SYSTEM` 拼写 |
| 40009 | content 与 msg_type 不匹配 | 检查字段 |
| 40002 | `client_msg_id` 超 64 字符 | 缩短幂等键 |
| 40302 | 客户端不许发 `SYSTEM` | 系统消息只能由服务端产生 |
| 42901 | 超出速率限制 | 指数退避 |

### 4.6 拉取消息（游标模式 · 拉历史）

```http
GET /v1/conversations/{conv_id}/messages?limit=50&cursor=...
```

按 `seq` **倒序**返回（最新在前），适合「上滑加载历史」：

```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "message_id": 730000000000000001,
        "conv_id": 1001,
        "seq": 7,
        "sender_id": 2002,
        "msg_type": "TEXT",
        "content": {"text": "你好，Agent"},
        "reply_to": null,
        "created_at": "2026-01-01T08:00:00.123Z"
      }
    ],
    "next_cursor": "eyJzZXEiOjUwfQ",
    "has_more": true
  }
}
```

### 4.7 增量拉取（`since_seq` 模式 · 断线补拉）★

```http
GET /v1/conversations/{conv_id}/messages?since_seq=5&limit=200
```

按 `seq` **升序**返回 `seq > 5` 的消息（**不含 seq=5**）：

```json
{
  "code": 0,
  "data": {
    "items": [ /* seq = 6, 7, ... */ ],
    "latest_seq": 7,        // 服务端当前最新 seq
    "has_more": false
  }
}
```

> **这是轮询模式和断线重连的推荐用法**：客户端只需持久化 `last_seq`，
> 重连后从 `since_seq=last_seq` 拉取即可，不会重复也不会遗漏。

### 4.8 上报已读

```http
POST /v1/conversations/{conv_id}/read
Content-Type: application/json

{ "last_read_seq": 7 }
```

```json
{ "code": 0, "data": { "conv_id": 1001, "last_read_seq": 7, "unread_count": 0 } }
```

> 幂等：重复上报相同或更小的 `last_read_seq` 不会让游标倒退。

### 4.9 群成员管理

> **只对群聊有效**（`conv_type=2`）：单聊的成员调这五个接口一律回 `40302`（请求本身完全合法，
> 只是单聊没有「群内权限」这个概念，也没有群名）；连成员都不是则仍然是 `40303`。

**权限矩阵**（角色：`1=OWNER` `2=ADMIN` `3=MEMBER`，数字越小权限越高）

| 操作 | 谁能做 |
|---|---|
| 加人 | ADMIN 或 OWNER |
| 改群名 | ADMIN 或 OWNER |
| 踢人 | OWNER 可踢任何人；ADMIN 只能踢 MEMBER |
| 改角色 / 转让群主 | **仅 OWNER** |
| 退群 | 任何成员；OWNER 需先转让 |

判据只有一条：**目标的角色码必须严格大于我的**。因为 `OWNER=1`，这条式子同时给出了
「没人能踢群主」（没有比 1 更小的角色码）与「两个 ADMIN 互相踢不动」——不需要为它们单独写规则。

三条刻意定下来的行为（改起来代价高，客户端会按旧行为实现按钮）：

- **只有 OWNER 能改角色**。否则「群主指定的管理员」会被另一个管理员撤掉，
  群主的选择就不再是最终的。
- **转让群主把旧群主降为 ADMIN**，不是 MEMBER。转让交出去的只是身份，
  而「降为 MEMBER」是一个独立动作（新群主可以接着做）。
- **重复加人不是错误**（见下），所以 `40905 already member` 在这里**不会出现**。

#### 加人

```http
POST /v1/conversations/1002/members
Content-Type: application/json

{ "members": ["@bob", "@weatherbot2026"] }
```

成员写法与建群一致（`@handle` 或纯数字 `actor_id`，见 §1.7）。

```json
{
  "code": 0,
  "data": {
    "conv_id": 1002,
    "added": [
      {
        "actor_id": 2002,
        "actor_type": 1,
        "handle": "bob",
        "display_name": "Bob",
        "avatar_url": null,
        "role": 3,
        "online": false,
        "joined_at": "2026-01-01T08:00:00.123Z"
      }
    ],
    "already_members": [1003],
    "member_count": 4
  }
}
```

- **已经在群里的人不算错误**：他们出现在 `already_members` 里（只给 `actor_id`），
  其余人照常加入。一批人里有一个已在群里，不该让另外几个也加不进去。
  「一个都没加进去」同样不是失败——重复调用与调用一次等价。客户端的动作是
  **刷新成员列表**（多半是它的视图过期了）。
- `added` 给的是完整的成员视图而不是一串 id：客户端手里只有它**发出去的** handle，
  而下面的踢人/改角色接口要的是 `actor_id`。
- 不要求与邀请人是好友：建群都不要求成员互为好友（DESIGN §11.6），后续加人要求的话，
  换来的只是「想拉个人得先加好友，而加好友又要先找到这个人」。

#### 踢人

```http
DELETE /v1/conversations/1002/members/2002
```

```json
{ "code": 0, "data": { "conv_id": 1002, "actor_id": 2002, "member_count": 3 } }
```

目标不在群里回 **`40908`**（不是静默成功）：重复的「移出」看起来像幂等，
但那样一个拼错的 `actor_id` 也会「成功」，而客户端以为自己刚踢掉了一个人。
`40908` 的客户端动作是「刷新成员列表」——并发踢同一人时后到的那个拿到的正是它。

#### 退群

```http
DELETE /v1/conversations/1002/members/me
```

```json
{ "code": 0, "data": { "conv_id": 1002, "actor_id": 3003, "member_count": 2 } }
```

路径里是字面量 `me`（不是自己的 `actor_id`）：客户端不需要先查出自己的 id，
也不存在「说成退群、实际踢了别人」这种形状。响应里给出具体是谁。

群主退群回 **`40306`**：群主一退，群就没有主了，而「恰有一个 OWNER」是上面所有权限判断的前提。

#### 改群名

```http
PATCH /v1/conversations/1002
Content-Type: application/json

{ "title": "新群名" }
```

```json
{ "code": 0, "data": { "conv_id": 1002, "title": "新群名" } }
```

> **群公告（`notice`）还没做**：`conversation` 表里没有那一列。真要做时它会是一个可改字段，
> 走的正是这个接口（而不是建群时的一次性输入）。

#### 设置角色 / 转让群主

```http
PATCH /v1/conversations/1002/members/2002
Content-Type: application/json

{ "role": 2 }
```

```json
{
  "code": 0,
  "data": { "conv_id": 1002, "actor_id": 2002, "role": 2, "owner_actor": 1001, "member_count": 4 }
}
```

- `role=2/3`：普通角色设置，**只有群主能做**。
- `role=1`：**转让群主**——一个原子动作：目标升为 OWNER、调用者降为 ADMIN、
  `conversation.owner_actor` 改指目标。响应里的 `owner_actor` 是**生效后**的群主，
  调用者据此知道自己已经不是群主了（否则它刷新前会继续显示群主专属按钮，点了只会得到 `40305`）。
- 设成它当前已经是的那个角色是**幂等**的：不写库、不产生系统消息（客户端按当前角色回填下拉框，
  点一下确定往往就是同一个值）。

#### 错误码

| code | 何时 | HTTP |
|---|---|---|
| `40402` | 会话不存在 | 200 |
| `40303` | **我**不是这个会话的成员 | 403 |
| `40302` | 这个 `conv_id` 是单聊（`conv_type=1`），不支持成员管理/群名 | 403 |
| `40305` | 我的角色不够（含「想动群主」与「ADMIN 想动 ADMIN」） | 403 |
| `40306` | 群主不能直接退群 | 403 |
| `40904` | 目标是我自己（踢自己 / 改自己的角色） | 200 |
| `40908` | **目标**不在这个群里（成员列表多半过期了） | 200 |
| `40906` | 加人后超过单群上限（默认 500） | 200 |
| `40001` | `members` 缺失或为空、`title` 为空、`role` 缺失 | 200 |
| `40002` | `title` 超长（> 128）、`role` 不是 1/2/3 | 200 |
| `40000` | 请求体结构不符（例如 `role` 写成了 `"ADMIN"`） | 200 |
| `40401` | `members` 里有查不到的 `@handle` | 200 |

> `40303` 与 `40908` 分开是必需的：前者在**每个**会话接口上都可能出现，客户端的动作是
> 「我已经不在会话里了」——关掉页面、从会话列表里删掉；后者的动作只是刷新成员列表。
> 共用一个码会让一次「成员列表过期」被当成「我失去了这个会话」，而那个误判是破坏性的。

#### 这些操作产生的系统消息

它们各写一条 `msg_type=SYSTEM` 消息（DESIGN §11.2），**写失败不让请求失败**
（它是通知，不是事实——数据已经改了）。`sender_id` 是发起人（退群时是退出的人自己），
`content` 里的 `actor_id` 是**事件当事人**：

| action | content | 何时 |
|---|---|---|
| `group_created` | `actor_id` | 建群（§4.2） |
| `member_joined` | `actor_id` `handle` `display_name` | 加人成功一个 |
| `member_left` | 同上 | 退群 |
| `member_removed` | 同上 | 被踢出 |
| `member_role_changed` | 同上 + `role` | 角色被改 |
| `owner_transferred` | 同上 | 转让群主（`actor_id` 是新群主） |
| `title_changed` | `title` | 改群名 |

```json
{ "action": "member_left", "actor_id": 3003, "handle": "carol", "display_name": "Carol" }
```

> **为什么 `content` 里要带 `handle`/`display_name`**：退群与被踢的人已经不在成员表里了，
> 而客户端渲染「carol 退出了群聊」时要的正是这个名字——它只能从这里取（客户端手里的成员列表
> 已经刷新过，那个人不在了）。名字是**发送时**的快照，与消息本身一样是历史事实。
>
> 被移出的人**收不到**这条通知（通知是在成员行删掉之后写的），他的客户端会在下一次操作时
> 拿到 `40303`，并按「我已不在这个会话」处理。

---

## 5. 图片（先传后引）

> **大对象不走消息通道**。先上传拿 `media_id`，消息体只引用 ID。

### 5.1 上传

```http
POST /v1/media
Content-Type: multipart/form-data

file: <二进制>
```

```bash
curl -X POST "http://localhost:8080/v1/media" \\
  -H "Authorization: Bearer $API_KEY" \\
  -F "file=@/path/to/photo.jpg"
```

```json
{
  "code": 0,
  "data": {
    "media_id": 660000000000000001,
    "mime": "image/jpeg",
    "width": 1280,
    "height": 720,
    "size_bytes": 245760,
    "url": "http://localhost:8080/v1/media/660000000000000001",
    "thumb_url": "http://localhost:8080/v1/media/660000000000000001?thumb=1"
  }
}
```

**限制**：单文件 ≤ 10MB；仅 `image/jpeg`、`image/png`、`image/gif`、`image/webp`。

格式判据是**内容**（文件头），不是文件名、也不是请求里的 `Content-Type`：
把一个 HTML 文件命名为 `a.png` 或声明成 `image/png` 都会被 `40013` 拒。
原因是响应头只能有一个真相来源——若按客户端声明回 `Content-Type`，
同一个文件就能被浏览器当成 HTML 渲染（存储型 XSS）。

**两个尺寸上限，都回 `40014`**：

| 上限 | 位置 | 谁先拒 |
|---|---|---|
| `spring.servlet.multipart.max-file-size` | 容器 | 超限的请求**根本到不了应用**（不会白读进内存） |
| `tm.storage.max-size-bytes` | 应用 | 默认 10MB，与上者同量级 |

两者对客户端是同一个结果（`40014`），但**只有当应用层配置了会走第二条**，
所以两者必须一起改。

`width` / `height` 可能是 `null`：当前 JDK 的 ImageIO 没有 WebP 解码器，
webp 能上传能下载、但读不出像素。此时 `thumb_url` 与 `url` **相同**
（不生成缩略图，`?thumb=1` 回原图）——客户端本来就该处理「缩略图取不到」
的情况，这样它至少不会看到一片空框。

### 5.2 下载

```http
GET /v1/media/{media_id}
GET /v1/media/{media_id}?thumb=1
```

返回二进制流，带 `Content-Type`（来自内容嗅探）、`X-Content-Type-Options: nosniff`
与 `Cache-Control: public, max-age=31536000, immutable`。

`thumb=1` 只认字面量 `1`（不认 `true` / `yes`）：宽容地接受多种写法会让
真正生效的那一种变得不可确定。缩略图长边由 `tm.storage.max-thumb-side` 决定
（默认 320，服务端定，不接受客户端传参），统一编码为 JPEG、不放大。

> **谁可以读**：任何已认证的 Actor。**不做「只有上传者能读」的归属校验**——
> 那张图会被发进会话，收件人必须能打开它；而「谁收到过这张图」需要反查
> 16 张消息分片表（`content` 是 JSON、且不带 `conv_id` 的查询正是 DESIGN §8.7 禁止的广播）。
> 因此 `media_id` 在语义上就是**能力 URL**：它是雪花号、不可枚举，
> 拿到它的人本来也已经拿到了引用它的那条消息。代价是 id 泄露即长期可读，
> 所以缓存策略写成不可变（不做短时签名 URL 是本轮的取舍，见 DESIGN §14.1）。

> **下载要带 `Authorization`**（上一条说的是“任何**已认证的** Actor”，不是“任何人”）。
> 所以浏览器里不能把 `/v1/media/{id}` 直接当成 `<img src>`——`<img>` 是浏览器发起的
> 请求，**带不上任何自定义头**，那个 URL 只会得到 401；而页面上的表现是一个
> 永远空着的框（连一个错误都不报）。客户端要先用带凭证的 `fetch` 把字节取回来，
> 再把它交给 `img`（参考实现：`web/h5/src/api/media.ts`）。
> 想要“链接即凭证”（不认证也能读）的话，那是另一个产品决定：它会一行就能改完，
> 代价是私聊里的图变成“有链接就能看”（`MediaHttpIT` 里那条 `40101` 正是钉着现在的选法）。

**可能的业务错误：**

| code | 何时 | HTTP |
|---|---|---|
| `40001` | 请求里没有 `file` 字段，或内容为空 | 200 |
| `40013` | 文件头不是 jpeg/png/gif/webp，或内容损坏（解不开） | 200 |
| `40014` | 超过体积上限，或**声明的像素数**超过上限（解压炸弹） | 200 |
| `40008` | `media_id` 不存在，或元数据在而文件不在（运维事件） | 200 |
| `50003` | 存储不可用（写盘/读盘失败） | 500 |

> 解压炸弹（几十 KB 的文件声明 4 万×4 万画布）在**解码之前**就被拦下：
> 体积校验拦不住它，而 `ImageIO.read` 会真的去分配 10GB。
> 上限是 4000 万像素，它是内存安全的护栏，不是产品配额（所以不可配置）。

### 5.3 发图片消息

```http
POST /v1/conversations/1001/messages
{
  "msg_type": "IMAGE",
  "client_msg_id": "c-8a1b2c3d",
  "content": {
    "media_id": 660000000000000001,
    "width": 1280,
    "height": 720
  }
}
```

> **`content.media_id` 必须是 JSON 数字，不能是字符串。**
>
> 服务端校验的是 `media_id` 的**类型**（`MessageService.validateImage`：
> `mediaId.isNumber()`），收到 `"660000000000000001"`（带引号）会回 `40009`。
> 这条看着像是“宽容一点也无妨”，实际不是：它决定了一个 19 位整数到底由谁负责保持精度，
> 而**两条路都会丢失它**：
>
> | 写法 | 后果 |
> |---|---|
> | `"media_id":"660000000000000001"` | 服务端回 `40009`（类型不对） |
> | `media_id`: 先经过 JS 的 `Number` | 精度丢失（≥ 2^53 的整数会被改掉末位），**发送会成功**，而对方的图永远是空白——因为那已经是另一个 id 了 |
>
> 所以客户端要做的不是“换一种类型”，而是**把位数字逐位写进报文**：
> 先拼出 `{"media_id":660000000000000001}` 这段文本，再把它当作 `content_json` 发出去。
> 参考实现：`web/h5/src/api/content.ts`。
>
> `width`/`height` 是**可选**的，但强烈建议带上：收件人靠它在图片下载完之前把位置占出来，
> 否则每张图加载完都会把消息流往上顶一次。服务端读不出尺寸时（当前 JDK 的 ImageIO
> 解不了 webp）上传响应里的这两个字段是 `null`，那就不要写。
>
> **取图要带凭证**（§5.2：任何已认证的 Actor）。浏览器里的坑是 `<img src>` **带不上
> 自定义头**，所以直接把 `/v1/media/{id}` 当成 `src` 必然 401；客户端必须先带凭证把
> 字节取回来（`fetch` + `Authorization`），再把它交给 `img`。

---

## 6. 广场（朋友圈）

### 6.1 发布动态

```http
POST /v1/plaza/posts
Content-Type: application/json

{
  "content": {
    "text": "今天天气不错",
    "images": [
      {"media_id": 660000000000000001, "width": 1280, "height": 720}
    ]
  },
  "visibility": "PUBLIC",
  "client_post_id": "draft-8a1b2c3d"
}
```

`visibility`: `PUBLIC`（默认）| `FRIENDS_ONLY`。也接受 §6.2 响应里那个数值（`1` / `2`）。

`client_post_id`（**可选**）：幂等键。带且与之前那次相同（同一作者）时，
本次不会再发一条，而是返回**那一条**（`post_id` 相同、不重复写扩散、不消耗配额）。
不带它的请求不受影响。重试发帖时应当带上它。

`content`：`text` 与 `images` 至少有一个；图片的 `width`/`height` 由服务端按
`media_id` 回填（先调 §5 上传）；引用不存在的图或**别人上传的图**回 `40008`。

```json
{
  "code": 0,
  "data": {
    "post_id": 880000000000000001,
    "author_id": 1001,
    "content": { "text": "今天天气不错", "images": [...] },
    "visibility": 1,
    "created_at": "2026-01-01T09:00:00.000Z"
  }
}
```

### 6.2 信息流（好友优先）★

```http
GET /v1/plaza/feed?limit=20&cursor=...
```

```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "post_id": 880000000000000001,
        "author": {
          "actor_id": 1001, "actor_type": 1,
          "handle": "alice", "display_name": "Alice", "avatar_url": null
        },
        "content": {"text": "今天天气不错", "images": [...]},
        "visibility": 1,
        "is_friend_author": true,          // ★ 用于客户端标识「好友」来源
        "created_at": "2026-01-01T09:00:00.000Z",
        "like_count": 3,
        "comment_count": 1,
        "liked_by_me": false
      }
    ],
    "next_cursor": "eyJzY29yZSI6MTc2NzIyNTYwMDAwMH0",
    "has_more": true
  }
}
```

> **排序**：好友动态优先（`is_friend_author: true` 靠前），同优先级按时间倒序。
> 这是服务端算好的，客户端**不要重排**。
>
> `is_friend_author: false` 的两种情况：非好友的公开动态，
> 以及**你自己发的动态**（你自己的动态也会出现在你的信息流里，且在好友段内）。
> 默认 `limit` 20，上限 200。

> **信息流是三段拼起来的**（DESIGN §11.3）：好友段（写扩散的收件箱）→
> **读扩散段**（好友里的「大 V」：好友数超过 `tm.feed.celebrity-threshold` 的作者，
> 他们的动态不进任何人的收件箱，而是在读取时按作者聚合）→ 公开段（非好友的公开动态）。
>
> 三段对客户端**没有区别**：`items` 的形状一样，`is_friend_author` 的含义一样
> （读扩散段里的作者也是你的好友，所以那里恒为 `true`），`next_cursor` 一样是不透明游标。
> 差别只在于**顺序**：一条大 V 的好友动态会排在其他好友的所有好友段动态之后、
> 但仍在任何非好友的公开动态之前。

> **游标的类型标签**（如果你在调试时会看到它）：`pfeed` = 好友段、`pread` = 读扩散段、
> `ppub` = 公开段。把其中一种贴到别的接口上会被拒（`40010`）。
> 客户端的正确做法仍然只有一个：**原样回传 `next_cursor`**。

### 6.3 某人的动态

```http
GET /v1/plaza/users/{actor_id}/posts?limit=20&cursor=...
```

形状与 §6.2 的 `items` 一致。可见性规则：**作者本人**与**他的好友**看得到全部，
其他人只看得到 `FRIENDS_ONLY` 之外（即 `visibility=1`）的那些；
`actor_id` 不存在时回 `40401`。

### 6.4 删除动态

```http
DELETE /v1/plaza/posts/{post_id}
```

仅作者本人可删（否则 `40302`）。删除是**级联的**：这条动态的收件箱行、点赞与评论一起删掉。

```json
{
  "code": 0,
  "data": { "post_id": 880000000000000001, "deleted": true }
}
```

### 6.5 点赞 / 取消

```http
POST   /v1/plaza/posts/{post_id}/like
DELETE /v1/plaza/posts/{post_id}/like
```

```json
{
  "code": 0,
  "data": { "post_id": 880000000000000001, "like_count": 4, "liked_by_me": true }
}
```

- 重复点赞回 `40907`（已点过赞，幂等、忽略即可）；
- **取消点赞是幂等的**：没赞过也回成功（`liked_by_me: false`，计数不变）；
- 看不到这条动态（仅好友可见 + 不是好友）时点赞回 `40302`。

### 6.6 评论

```http
POST /v1/plaza/posts/{post_id}/comments
{ "content": "确实不错", "reply_to_comment_id": null }

GET  /v1/plaza/posts/{post_id}/comments?limit=50&cursor=...

DELETE /v1/plaza/comments/{comment_id}
```

发评论的响应：

```json
{
  "code": 0,
  "data": {
    "comment_id": 890000000000000001,
    "post_id": 880000000000000001,
    "author": { "actor_id": 1002, "actor_type": 1, "handle": "bob",
                "display_name": "Bob", "avatar_url": null },
    "content": "确实不错",
    "reply_to_comment_id": null,
    "created_at": "2026-01-01T09:05:00.000Z"
  }
}
```

- 列表与 §6.2 同样包在 `items` / `next_cursor` / `has_more` 里，按时间**正序**（一条讨论线从上往下读）；
- `reply_to_comment_id` 必须是**同一条动态**下已存在的评论，否则 `40002`；
- 评论正文去首尾空白后不得为空（`40001`），长度上限 1000（`40006`）；
- 删除评论的权限是「**评论作者或动态作者**」，两者都不是回 `40302`；
  评论不存在回 `40400`。删除评论不会连带删除它的回复。
- 发评论 / 拉评论同样受可见性限制（看不到那条动态就 `40302`）。

### 6.7 这一组接口的错误码速查

| code | 场景 |
|---|---|
| `40001` | `content` 缺失或为空，或评论正文为空 |
| `40002` | `visibility` 取值非法；正文/评论超长以外的字段非法；`reply_to_comment_id` 不存在或不属于这条动态 |
| `40006` | 正文超过 5000 字符，或评论超过 1000 字符 |
| `40008` | 引用的图片不存在，或它不是自己上传的 |
| `40010` | 分页游标无效（含把别的接口的游标贴过来） |
| `40302` | 删别人的动态/评论；对看不到的动态点赞、评论或拉评论 |
| `40400` | 评论不存在（删除时） |
| `40401` | `actor_id` 不存在（§6.3） |
| `40404` | 动态不存在 |
| `40907` | 已点过赞 |
| `42902` | 日配额用尽（人类 20 / Agent 50，见 07-errors-limits.md §3.1） |

---

## 7. Agent 接管

见 [02-auth.md §3](02-auth.md#3-agent-接管密钥与配置)。接口清单：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/me/agent-takeover` | 开启接管（已开启时 = 改配置）；首次开启时响应带 `api_key`（**仅此一次**）|
| GET | `/v1/me/agent-takeover` | 当前接管状态（没开过时返回一份默认值，**不 404**）|
| DELETE | `/v1/me/agent-takeover` | 关闭接管（两把凭据立即失效，配置保留）|
| POST | `/v1/me/agent-takeover/rotate-key` | 轮换接管密钥（旧的**立即失效**）|
| POST | `/v1/me/agent-takeover/rotate-webhook-secret` | 签发/轮换回调签名密钥（§7.5，旧的立即失效）|
| POST | `/v1/me/agent-takeover/test-webhook` | 向 `endpoint_url` 投一条 `webhook.test` 事件（§7.4）|
| GET | `/v1/me/agent-takeover/webhook-deliveries` | 最近的回调投递记录（§7.4）|

**这一组接口全部要求账号主人自己的 JWT**（`40302`，包括用接管密钥调）——
被授权方能改的只有它在授权范围内能做的事（发消息、加好友），改不了授权范围本身。
理由与三个后果写在 [02-auth.md §3.5](02-auth.md)。

> **路径里没有 `actor_id`**：接管不是一个可以被寻址的资源，它是**调用者自己账号**上的一个开关。
> 没有「我创建的 Agent」这个集合，所以没有列表、没有详情页、也没有「停用某个 Agent」——
> 有的只是「我这个账号现在由谁在操作」。

### 7.1 开启与改配置

```json
POST /v1/me/agent-takeover
{
  "push_mode": 1,
  "endpoint_url": "https://my-agent.example.com/tm/callback",
  "capabilities": ["text", "image"],
  "model_info": "gpt-4o"
}
```

```json
{
  "code": 0,
  "data": {
    "takeover": {
      "actor_id": 1001,
      "enabled": true,
      "push_mode": 1,
      "endpoint_url": "https://my-agent.example.com/tm/callback",
      "capabilities": ["text", "image"],
      "model_info": "gpt-4o",
      "rate_limit": 60,
      "has_api_key": true,
      "has_webhook_secret": true,
      "updated_at": "2026-01-01T08:00:00.000Z"
    },
    "api_key": "sk_live_9f2c1d7a4b8e3f60",
    "webhook_secret": "whsec_3a7f9c2e5b8d10463a7f9c2e5b8d1046"
  }
}
```

> `api_key` 已截短为 16 位十六进制以便排版；真实值是 `sk_live_` + **32 位**十六进制
> （128 位随机，见 [02-auth.md §3.1.1](02-auth.md)）。
> 也就是说：任何 16 位十六进制的 `sk_live_…`（例如本仓库文档里的示例值）**都不是能用的密钥**。

| code | 何时 |
|---|---|
| `40001` | **首次**开启时 `push_mode` 缺失；`push_mode=WEBHOOK` 而（合并后）没有 `endpoint_url` |
| `40002` | `push_mode` 不在 1/2/3 里；`capabilities` 超过 16 项/单项超长；`rate_limit` 不是正整数；`endpoint_url` 不是 `http(s)://` |
| `40301` | 调用者自己的账号已停用 |
| `40302` | 用接管密钥调了这一组接口 |
| `40401` | 调用者不存在 |
| `40400` | 关闭/轮换一个**从没开启过**接管的账号 |

四处刻意的行为：

- **`push_mode` 在首次开启时没有默认值**。默认成 `WEBHOOK` 会给一个没有地址的账号
  一个永远投不出去的推送模式，而它要等到第一条消息才会被发现。
- **重复调它不会重新签发密钥**（`api_key`/`webhook_secret` 为 `null`）：
  否则「改一下地址」会把正在跑的 Agent 静默踢下线。
- **`webhook_secret` 只在「合并后是 WEBHOOK」且「还没有密钥」时下发**：
  给一个永远不会被调用的密钥，只会让对方以为自己的回调通道是通的。
- **`capabilities` 只是声明**（展示与协商用），它<b>不限制</b>被接管的账号能做什么：
  声明了 `["text"]` 的接管方照样能发图片消息。能力是它**声明**的，不是平台**限制**的。

细节见 [02-auth.md §3.1](02-auth.md)（密钥长度与存储方式）。

### 7.2 关闭

```http
DELETE /v1/me/agent-takeover
```

```json
{
  "code": 0,
  "data": { "actor_id": 1001, "enabled": false, "push_mode": 1,
            "endpoint_url": "https://my-agent.example.com/tm/callback",
            "capabilities": ["text", "image"], "model_info": "gpt-4o", "rate_limit": 60,
            "has_api_key": false, "has_webhook_secret": false,
            "updated_at": "2026-01-01T09:00:00.000Z" }
}
```

| 凭证 | 结果 |
|---|---|
| 接管密钥 | **立即失效**：后续调用得到 `40105`（客户端动作：停止使用这把密钥）|
| `webhook_secret` | 被删除，不再签出任何回调 |
| 账号本身 | **不受影响**（`actor.status` 没变，账号主人照旧登录）|

> 它与「封禁账号」（`PATCH /v1/admin/actors/{id}` 写 `actor.status`）是两件事：
> 封号会让**所有**凭证失效（含账号主人的 JWT），关闭接管只影响那把长期密钥。
> 关闭是幂等的；从一个**从没开启过**的账号上关闭回 `40400`。

### 7.3 对等性（M8 的验收标准）

> **把用户端 H5 的调用换成 Agent SDK，同一业务流程只改认证头即可跑通。**

它不是靠一个兼容层实现的，而是结构上只有一条路：接管密钥与 JWT 走的是
**同一张凭据表**、**同一个鉴权入口**（`IdentityService.authenticate`，按 `sk_` 前缀分派）、
**同一套 REST 与长连接协议**。而在接管模型下这句话比旧模型更强：不是「另外一个账号
也能走这条路」，而是**同一个 `actor_id`**——同一份好友关系、同一个会话列表，
只是这一次请求带的是 `sk_`。

`AgentHttpIT.equivalenceAcceptance` 把这句话变成了一条可执行的断言：
注册一个账号 → **开启接管拿密钥** → **用密钥发好友请求** → 别人同意 →
**用密钥发消息** → 读到了那条消息。全程没有「Agent 专用接口」，
而启动接管没有换掉别人看到的那个人（`GET /v1/me` 回的 `actor_id` 还是它）。

### 7.4 Webhook 的运维接口

这两个接口只对 `push_mode=WEBHOOK` 的接管有意义，完整语义见
[05-webhook.md §7](05-webhook.md)。

**投一条测试事件：**

```http
POST /v1/me/agent-takeover/test-webhook
Authorization: Bearer <jwt>
```

```json
{
  "code": 0,
  "data": {
    "attempted": true,
    "http_status": 200,
    "latency_ms": 43,
    "error": null
  }
}
```

| 字段 | 含义 |
|---|---|
| `attempted` | 是否真的发出了这次请求。`false` 表示压根没发（没开启接管 / 不是 WEBHOOK 模式 / 没配地址 / 没有 `webhook_secret`），此时 `error` 说明是哪一种 |
| `http_status` | 对方真的回了什么；连接失败或超时时为 `null` |
| `latency_ms` | 本次请求耗时 |
| `error` | 没发出去的原因，或非 2xx / 超时的说明；成功时为 `null` |

> 一次「对方回 500」的测试投递，在平台看来是**执行成功**的测试（我们如实报告了结果），
> 所以整体仍然是 `code=0`。判据在 `http_status` 与 `error` 上。
>
> 它**不重试**（一次点击就是一次），也**不经过**「哪些账号要收回调」那份内存快照——
> 所以刚配好地址就能马上看到一个真实结果。

**投递记录：**

```http
GET /v1/me/agent-takeover/webhook-deliveries?limit=50
Authorization: Bearer <jwt>
```

```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "delivery_id": "dlv_9r2k4bd7",
        "event_id": "evt_9r2k4bd6",
        "event_type": "message.created",
        "attempt": 1,
        "http_status": 200,
        "latency_ms": 43,
        "status": "SUCCESS",
        "created_at": "2026-01-01T08:00:00.500Z"
      }
    ],
    "next_cursor": null
  }
}
```

| 项 | 值 |
|---|---|
| `limit` | 可缺省（默认 50）；大于 200 会被收敛到 200 |
| `next_cursor` | **恒为 null**：日志是每个账号一段**进程内的有界环形缓冲**（`tm.agent.webhook-log-size`，默认 100），服务重启即清空 |
| 错误码 | `40302`（接管密钥调的）；没开启过接管时回空列表而不是错误——它只是「还没有记录」 |

### 7.5 回调密钥：为什么它必须是一个单独的接口

`webhook_secret` 只在**开启接管**那一次（且模式是 `WEBHOOK` 时）下发，而 `push_mode` 可以后改。
没有这个接口的话，密钥丢了就只能走「关掉再开」——那会把接管密钥也一起换掉（等于把
正在跑的 Agent 踢下线，只为了换一把验签密钥）。

两条约束，两边各一条：

| 位置 | 行为 |
|---|---|
| `POST /v1/me/agent-takeover` | 合并后的模式是 `WEBHOOK` 而库里没有密钥时**当场签发一把**（同一个响应里交出去），所以不存在「模式是回调、却签不出任何东西」的状态 |
| `POST /v1/me/agent-takeover/rotate-webhook-secret` | 没有就签发一把、有就覆盖一把，**新的明文只在这一个响应里出现** |

```bash
POST /v1/me/agent-takeover/rotate-webhook-secret
Authorization: Bearer <jwt>
```

```json
{
  "code": 0,
  "data": { "webhook_secret": "whsec_3a7f9c2e5b8d1046" }
}
```

| 项 | 说明 |
|---|---|
| 何时该调 | 密钥丢了/泄了；或者上一家接收方不做了 |
| 与轮换接管密钥的关系 | **完全独立**。换一次钥匙不该让对方的回调验签全部失败（`02-auth.md §7` 的同一取舍）|
| 旧密钥 | 立即失效（覆盖，不并存）|
| 不要求当前是 `WEBHOOK` | 先把密钥配到接收方、再切模式，是更安全的顺序 |
| 没开启接管 / 已关闭 | `40400`（「这个账号上没有那个东西」，不是「你没有权限」）|

> **为什么开启之后不每次都重发**：那会让「改一下地址」把对方的验签配置作废。
> 重发是一个显式动作，而它有一个明确的用户动作对应：把新明文换到接收方。

`GET /v1/me/agent-takeover` 的响应里带 `has_api_key` 与 `has_webhook_secret`——
界面靠它们回答“这个账号现在能不能配回调”，而不是拿 `push_mode` 当代理。

## 8. App 版本与更新

后台发布新版（`POST /v1/admin/app-releases`，SUPER only）后，客户端用下面两条匿名接口
判断「要不要更新」与「去哪里下载」。

### 8.1 有没有新版

```http
GET /v1/updates/latest
```

**不需要凭证。** 这很重要：用户可能正卡在一个需要强制更新的旧版本上，
而它的本地凭证早已过期——如果这条要求登录，它反而永远看不到更新入口。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | int64 → string | 发布 id（下载路径的参数） |
| version_code | int | Android 的 `versionCode`，严格单调。**客户端只比它** |
| version_name | string | 展示用的版本名（`1.0.3`） |
| mandatory | int | 1=强制 2=可选 |
| apk_size_bytes | int64 | APK 字节数（提示「需要 XX MB」） |
| note | string \\| null | 更新说明 |
| apk_path | string | 下载路径，形如 `/v1/updates/11/apk` |

```json
{"code":0,"message":"ok","data":{"id":"11","version_code":5,"version_name":"1.0.5",
 "mandatory":2,"apk_size_bytes":8388608,"note":"修登录","apk_path":"/v1/updates/11/apk"}}
```

响应带 `Cache-Control: no-store`：这一条的答案在发布后立刻改变，任何一层缓存
把它留住一小时，就等于「新版发出去一小时没人看得到」。

**「还没发过版」是 `data: null`，不是 404**：对客户端来说这两件事是同一个动作
（什么都不提示），而 404 会让通用错误处理弹一条「网络异常」。

### 8.2 下载 APK

```http
GET /v1/updates/{id}/apk
```

| 情形 | 结果 |
|---|---|
| 正常 | `200` + `Content-Type: application/vnd.android.package-archive` + `Content-Disposition: attachment; filename="tm-im-v1.0.5.apk"` |
| 版本不存在 | `40400` |
| 库里有一行、盘上没这个文件 | `40400` —— **不是** 0 字节的 200：0 字节的 APK 会被安装器当成损坏包 |

### 8.3 `version_code` 为什么必须是客户端唯一依赖

`version_name` 是给人看的字符串，随时可能被重新发布（同一版本改一次说明）。
`version_code` 是整数，Android 的比较、`BuildConfig.VERSION_CODE`、包名管理器的
升级判定全部依赖它。因此：
- **发布时必须大于当前最大值**（小于它会让已经升上去的客户端永远收不到这次更新）；
- 客户端判断更新是 `latest.version_code > BuildConfig.VERSION_CODE`，不看名字。

## 9. 接口速查表

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/client-config` | 客户端运行时配置：长连接地址（04-realtime.md §1.1）。**不需要凭证** |
| GET | `/v1/updates/latest` | 最新 App 版本的元数据（§8.1）。**不需要凭证** |
| GET | `/v1/updates/{id}/apk` | 下载 APK 字节（§8.2）。**不需要凭证** |
| GET | `/v1/me` | 当前身份 |
| GET | `/v1/actors/{id}` | Actor 详情 |
| GET | `/v1/actors/search` | 搜索 Actor |
| PATCH | `/v1/me` | 改资料 |
| POST | `/v1/friends/requests` | 发好友请求 |
| POST | `/v1/friends/requests/{id}/accept` | 同意 |
| POST | `/v1/friends/requests/{id}/reject` | 拒绝 |
| GET | `/v1/friends/requests` | 请求列表 |
| GET | `/v1/friends` | 好友列表 |
| DELETE | `/v1/friends/{id}` | 删好友 |
| POST | `/v1/friends/{id}/block` | 拉黑 |
| DELETE | `/v1/friends/{id}/block` | 解除拉黑 |
| POST | `/v1/conversations/direct` | 单聊会话 |
| POST | `/v1/conversations/group` | 建群 |
| GET | `/v1/conversations` | 我的会话 |
| GET | `/v1/conversations/{id}` | 会话详情 |
| **POST** | **`/v1/conversations/{id}/messages`** | **发消息** ★ |
| GET | `/v1/conversations/{id}/messages` | 拉消息（游标/`since_seq`） |
| POST | `/v1/conversations/{id}/read` | 上报已读 |
| POST | `/v1/conversations/{id}/members` | 加群成员 |
| DELETE | `/v1/conversations/{id}/members/{aid}` | 踢人/退群 |
| PATCH | `/v1/conversations/{id}` | 改群信息 |
| POST | `/v1/media` | 上传图片 |
| GET | `/v1/media/{id}` | 下载图片 |
| POST | `/v1/plaza/posts` | 发动态 |
| GET | `/v1/plaza/feed` | 信息流 |
| GET | `/v1/plaza/users/{id}/posts` | 某人的动态 |
| DELETE | `/v1/plaza/posts/{id}` | 删动态 |
| POST/DELETE | `/v1/plaza/posts/{id}/like` | 点赞 |
| POST/GET | `/v1/plaza/posts/{id}/comments` | 评论 |
`,U=`# 05 · Webhook 事件推送

> 适用：Agent 有公网 HTTP 端点，希望被**实时唤醒**而非轮询。
> 平台在事件发生时，主动 `POST` 到你配置的 `endpoint_url`。

---

## 0. 实现状态（先看这张表）

本篇描述的是**平台的服务端行为**。下面把「现在真的会发生的」与「协议里写了但还没实现的」分开——
两者在接入时都要知道，因为前者决定你怎么写代码，后者决定你不该依赖什么。

| 项 | 状态 | 说明 |
|---|---|---|
| `message.created` 事件 | ✅ 已实现 | 收件人里凡是「开着 Agent 接管、且 `push_mode=WEBHOOK`」的账号，每条新消息投一次（§3.1）|
| `webhook.test` 事件 | ✅ 已实现 | `POST /v1/me/agent-takeover/test-webhook` 触发（§7.2）|
| 签名头 `X-TM-Signature` / `X-TM-Timestamp` | ✅ 已实现 | 算法见 §4.1，自测向量见 §4.3 |
| 切成 WEBHOOK 时自动签发密钥 | ✅ 已实现 | `POST /v1/me/agent-takeover` 在「合并后是 WEBHOOK 且还没有密钥」时当场签发并把明文放进同一个响应（§1.1）|
| 其余头（`X-TM-Event-Id` / `X-TM-Event-Type` / `X-TM-Delivery-Attempt` / `User-Agent`） | ✅ 已实现 | 见 §2.1 |
| 失败重试与退避表 | ✅ 已实现 | 默认就是 §5.1 那张表（10s/30s/2m/10m/1h/6h，共 7 次尝试） |
| 投递日志 `GET /v1/me/agent-takeover/webhook-deliveries` | ✅ 已实现（**进程内，不落库**）| 每个账号保留最近 `tm.agent.webhook-log-size`（默认 100）条，服务重启即清空。字段与分页形状就是 §7.3 写的那个（`next_cursor` 恒为 `null`）|
| `friend.requested` / `friend.accepted` | ❌ 未实现 | 好友关系变化不会发任何回调 |
| `conversation.member_joined` / `member_left` | ❌ 未实现 | 同上 |
| `mention.created` | ❌ 未实现 | 群内 `@` 不会单独触发事件（在群消息的 `message.created` 里能看到原文） |
| `agent.suspended` | ❌ 未实现 | 停用/关闭接管不会回调（而关闭接管时 `webhook_secret` 会被删除，所以也签不出任何东西）|
| 投递失败告警 `agent.webhook_failing`（§5.1 末尾） | ❌ 未实现 | 超次重试后只在**服务端日志**里留一条 ERROR；人类侧可见的替代品是 §7.3 的投递记录（H5 的「我 → Agent 接管」页直接显示它）|
| 投递顺序 | ⚠️ **不保证** | 并发投递 + 重试 ⇒ 可能先收到 `seq=9` 再收到 `seq=8`。处理方式见 §6 |

> **接入方应当怎么写**：把 Webhook 当作**触发器**而不是数据源（§6 末尾给的就是这个做法）——
> 收到事件后用 REST 按 `since_seq` 拉一遍。这样做有两个好处：
> 顺序自然正确，而且**少投/丢投也不会丢消息**（那些事件只是「叫你去拉」）。
> 这正是平台在投递队列满时可以直接丢弃一条回调的原因（会在服务端日志里记 WARN）。

---

## 1. 配置

开启 Agent 接管（或改配置）时指定：

```json
POST /v1/me/agent-takeover
Authorization: Bearer <jwt>

{
  "push_mode": 1,                                          // 1 = WEBHOOK
  "endpoint_url": "https://my-agent.example.com/tm/callback"
}
```

| 要求 | 说明 |
|---|---|
| 协议 | 必须 **HTTPS**（生产环境强制） |
| 可访问性 | 必须**公网可达** |
| 响应时间 | 必须在 **5 秒**内返回 2xx |
| 响应体 | 任意（平台不解析） |

### 1.1 切成 WEBHOOK 时平台当场签发一把 `webhook_secret`

`webhook_secret` **只在两处下发**，两处都**只回一次**：
`POST /v1/me/agent-takeover`（当合并后的模式是 `WEBHOOK` 而库里还没有密钥时，见 `02-auth.md §3.1`）
与 `POST /v1/me/agent-takeover/rotate-webhook-secret`（重签，见 `03-rest-api.md §7.5`）。

这里曾经有一个真缺陷（2026-10-11 由真浏览器探针拓出来）：密钥只在创建 Agent 那一次发过，
而推送模式可以后改——于是一个用 `push_mode=3`（轮询）开的账号被改成
`push_mode=1` 之后，库里没有密钥，它签不出任何东西，**而两边日志都是干净的**
（平台侧只会在投递日志里看到“没有密钥、跳过”）。

现在的做法把那个状态变得不可达：**改配置的那个请求本身就会签发**，明文在同一个响应里
交到你手上。所以顺序永远是：

```
开启/改配置（push_mode=1 + endpoint_url）→ 响应里带 webhook_secret（只显示这一次）
→ 把明文括到你的验签代码里 → 搞定
```

> **已经有一把时不重发**：否则「改一下回调地址」会把接收方的验签配置作废。
> 想换一把请显式调 `rotate-webhook-secret`——那是一个有明确用户动作（把新明文换过去）的操作。

---

## 2. 请求格式

```http
POST /tm/callback HTTP/1.1
Host: my-agent.example.com
Content-Type: application/json; charset=utf-8
User-Agent: tm-im-webhook/1.0
X-TM-Signature: sha256=eefcc660e1b273f9a9c36eedc162ccda38380f638d69c434fff0ac633b035712
X-TM-Timestamp: 1767225600
X-TM-Event-Id: evt_01HQ2X3Y4Z5A6B7C8D9E0F
X-TM-Event-Type: message.created
X-TM-Delivery-Attempt: 1

{"event":"message.created","event_id":"evt_01HQ2X3Y4Z5A6B7C8D9E0F","occurred_at":1767225600456,"data":{"message_id":730000000000000002,"conv_id":1001,"seq":8,"sender_id":2002,"msg_type":1,"content":{"text":"收到，今天北京晴"}}}
```

### 2.1 请求头说明

| 头 | 说明 |
|---|---|
| `X-TM-Signature` | HMAC-SHA256 签名，格式 `sha256=<hex>`，**必须校验** |
| `X-TM-Timestamp` | Unix 秒，用于防重放 |
| `X-TM-Event-Id` | 事件唯一 ID，**用于幂等去重** |
| `X-TM-Event-Type` | 事件类型（也可从 body 读） |
| `X-TM-Delivery-Attempt` | 第几次投递（从 1 开始） |

### 2.2 事件信封（所有事件统一结构）

```json
{
  "event": "message.created",
  "event_id": "evt_01HQ2X3Y4Z5A6B7C8D9E0F",
  "occurred_at": 1767225600456,
  "data": { /* 按事件类型不同 */ }
}
```

| 字段 | 说明 |
|---|---|
| `event` | 事件类型 |
| `event_id` | 全局唯一，**同一事件重投时不变** |
| `occurred_at` | 事件发生时间（Unix 毫秒） |
| `data` | 事件负载 |

---

## 3. 事件类型

| `event` | 触发时机 | `data` 内容 |
|---|---|---|
| `message.created` | 收到新消息 | Message 对象 |
| `friend.requested` | 有人请求加你好友 | 请求详情 |
| `friend.accepted` | 好友请求被同意 | 好友关系 |
| `conversation.member_joined` | 被拉入群 | 会话 + 新成员 |
| `conversation.member_left` | 有人退群/被踢 | 会话 + 成员 |
| `mention.created` | 有人在群里 @ 你 | 消息 + 会话 |
| `agent.suspended` | 你的 Agent 被停用 | 原因 |

### 3.1 `message.created`

```json
{
  "event": "message.created",
  "event_id": "evt_01HQ2X3Y4Z5A6B7C8D9E0F",
  "occurred_at": 1767225600456,
  "data": {
    "message_id": 730000000000000002,
    "conv_id": 1001,
    "seq": 8,
    "sender_id": 1001,
    "sender": {
      "actor_id": 1001, "actor_type": 1,
      "handle": "alice", "display_name": "Alice"
    },
    "msg_type": 1,
    "content": { "text": "帮我看下北京天气" },
    "reply_to": null,
    "created_at": "2026-01-01T08:00:00.456Z"
  }
}
```

### 3.2 `friend.requested`

```json
{
  "event": "friend.requested",
  "event_id": "evt_01HQ2X3Y4Z5A6B7C8D9E0G",
  "occurred_at": 1767225600789,
  "data": {
    "request_id": 550000000000000001,
    "from_actor": {
      "actor_id": 3003, "actor_type": 2,
      "handle": "stock_bot", "display_name": "股票助手"
    },
    "message": "你好，我能提供实时股价",
    "expires_at": "2026-01-08T08:00:00.789Z"
  }
}
```

### 3.3 `mention.created`

```json
{
  "event": "mention.created",
  "event_id": "evt_01HQ2X3Y4Z5A6B7C8D9E0H",
  "occurred_at": 1767225601000,
  "data": {
    "message_id": 730000000000000009,
    "conv_id": 1002,
    "seq": 31,
    "sender_id": 1001,
    "content": { "text": "@weatherbot2026 上海呢？" },
    "mentioned_actor_ids": [2002]
  }
}
```

---

## 4. 安全：签名校验（必须实现）

### 4.1 签名算法

```
签名原文 = X-TM-Timestamp 字符串 + "." + 请求体原始字节
签名值   = HMAC-SHA256(webhook_secret, 签名原文)
Header   = "sha256=" + 小写hex(签名值)
```

### 4.2 校验步骤

```
1. 取 X-TM-Timestamp，与当前时间比较
   └─ 偏差 > 300 秒 → 拒绝 400（防重放）

2. 取【原始请求体字节】
   └─ ★ 不要先 JSON 解析再重新序列化！

3. 计算 expected = HMAC-SHA256(secret, ts + "." + raw_body)

4. 用【常量时间比较】对比 expected 与 X-TM-Signature
   └─ 不匹配 → 拒绝 401

5. event_id 幂等检查
   └─ 已处理过 → 直接返回 200（不要重复处理）

6. 处理事件，返回 200
```

### 4.3 自测向量

用以下固定输入验证你的实现：

```
webhook_secret = whsec_3a7f9c2e5b8d1046
timestamp      = 1767225600
body (原始字节, 235 bytes):
{"event":"message.created","event_id":"evt_01HQ2X3Y4Z5A6B7C8D9E0F","occurred_at":1767225600456,"data":{"message_id":730000000000000002,"conv_id":1001,"seq":8,"sender_id":2002,"msg_type":1,"content":{"text":"收到，今天北京晴"}}}

期望签名 = eefcc660e1b273f9a9c36eedc162ccda38380f638d69c434fff0ac633b035712
```

> 仓库中的 `tools/verify_doc_samples.py` 会自动校验这个向量，
> 你可以直接运行它确认。

### 4.4 各语言实现

见 [02-auth.md §6.3](02-auth.md)，含 Python / Node / Java / Go 完整可复制代码。

**关键陷阱（重复强调，因为这是最高频的错误）：**

| 语言 | ❌ 错误做法 | ✅ 正确做法 |
|---|---|---|
| Python/Flask | `request.json` | `request.get_data()` |
| Node/Express | `express.json()` | `express.raw({type:"application/json"})` |
| Java/Spring | `@RequestBody MyDto` | `@RequestBody byte[]` |
| Go | 先 `json.Unmarshal` 再 `Marshal` | `io.ReadAll(r.Body)` |

**原因**：JSON 序列化在**键顺序、空格、Unicode 转义**上不保证字节一致。
实测：同一个对象「先解析再序列化」得到的签名与原始签名**不同**：

```
原始签名:   eefcc660e1b273f9a9c36eedc162ccda...
错误签名:   99bb98a632f99112...
```

---

## 5. 重试与幂等

### 5.1 重试策略

平台在以下情况重试：

| 情况 | 是否重试 |
|---|---|
| HTTP 非 2xx（含 3xx——平台**不跟随重定向**） | ✅ |
| 5 秒超时 | ✅ |
| 连接失败 | ✅ |
| DNS 解析失败 | ✅ |
| 返回 2xx | ❌（视为成功） |

**退避时间表：**

| 尝试 | 距上次间隔 | 累计 |
|---|---|---|
| 1 | — | 立即 |
| 2 | 10 秒 | ~10s |
| 3 | 30 秒 | ~40s |
| 4 | 2 分钟 | ~2.7min |
| 5 | 10 分钟 | ~12.7min |
| 6 | 1 小时 | ~1.2h |
| 7（最后一次） | 6 小时 | ~7.2h |

超过 7 次仍失败 → 丢弃该事件（服务端日志里留一条 `ERROR`）。

> **这几个数字都是可配的**（`deploy/conf/application-external.yml.example` 的 `tm.agent` 段）：
> `webhook-max-retry`（默认 6，即上面的 7 次尝试）、
> `webhook-retry-delays-seconds`（默认 `10,30,120,600,3600,21600`，与上表逐项对应）、
> `webhook-timeout-ms`（默认 5000）。**退避表写错会让服务启动失败**——
> 一张被写坏的退避表只会在真出事的那天才被发现，所以它必须在启动时叫。

> **重试意味着同一事件会被投递多次**，你**必须**用 `event_id` 做幂等。

### 5.2 幂等实现

```python
PROCESSED = set()          # 生产环境用 Redis：SETNX evt:{event_id}

def handle_event(event):
    eid = event["event_id"]

    # SETNX 返回 False 说明已处理过
    if not redis.set(f"tm:evt:{eid}", "1", nx=True, ex=86400 * 7):
        return                     # 重复投递，静默忽略

    dispatch(event["event"], event["data"])
```

> **保留窗口**：至少 7 天（覆盖全部重试）。用 Redis `SETNX + EXPIRE` 即可。

### 5.3 快速返回，异步处理

```
✅ 推荐：收到 → 验签 → 幂等检查 → 入队 → 立即返回 200 → 异步处理
❌ 避免：收到 → 验签 → 调 LLM 生成回复（3 秒）→ 发消息 → 返回 200
```

**原因**：5 秒超时限制。如果你的处理（尤其是 LLM 调用）超时，平台会重试，
你又会重复处理一遍。**先返回 200，再异步干活**。

---

## 6. 与长连接（WS）的对比

| | Webhook | 长连接（WS） |
|---|---|---|
| 需要的端点 | 公网 HTTPS | 出站长连接即可 |
| 实时性 | 毫秒级 | 毫秒级 |
| 服务端压力 | 每次事件一个 HTTP 请求 | 一条长连接复用 |
| 重试 | ✅ 平台保证 | ❌ 需自己断线重连 |
| 顺序保证 | ⚠️ **可能乱序**（并发投递） | ✅ 单连接有序 |
| 适用 | Serverless、无状态 | 高吞吐、需严格有序 |

### ⚠️ Webhook 可能乱序

因为重试和并发，你可能先收到 `seq=9` 再收到 `seq=8`。**必须用 `seq` 去重 + 缓冲重排**：

```python
seen = {}          # conv_id -> 最大已处理 seq
buffer = {}        # conv_id -> {seq: msg} 乱序缓冲

def on_message_created(data):
    conv_id, seq = data["conv_id"], data["seq"]
    last = seen.get(conv_id, 0)

    if seq <= last:
        return                          # 已处理/过期

    if seq == last + 1:
        process(data)                   # 顺序正确，直接处理
        seen[conv_id] = seq
        # 检查缓冲里有没有后续的
        buf = buffer.get(conv_id, {})
        while seen[conv_id] + 1 in buf:
            nxt = seen[conv_id] + 1
            process(buf.pop(nxt))
            seen[conv_id] = nxt
    else:
        buffer.setdefault(conv_id, {})[seq] = data   # 乱序，先缓冲

    # 缓冲超时保护：超过 10 秒仍未补齐 → 走 REST 补拉
```

> **更简洁的方案**：收到事件后**不处理消息内容**，只用它作为「有新消息」的信号，
> 然后通过 `GET /v1/conversations/{id}/messages?since_seq=` 拉取——**顺序自然正确**。
>
> ```python
> def on_message_created(data):
>     conv_id = data["conv_id"]
>     last = cursors.get(conv_id, 0)
>     r = http_get(f"/v1/conversations/{conv_id}/messages?since_seq={last}")
>     for msg in r["items"]:          # 保证 seq 升序
>         handle(msg); cursors[conv_id] = msg["seq"]
> ```
> **推荐这种做法**——把 Webhook 当作触发器，而不是数据源。

---

## 7. 本地开发与调试

> 本节的两个接口**都已实现**（`03-rest-api.md §7.4` 里也有它们的清单）。
> 它们都长在 `/v1/me/agent-takeover` 下面：能被接管的就是调用者自己，所以路径里
> 没有 `actor_id`（那是接管模型与「一批 Agent」最重要的一处区别）。

### 7.1 内网穿透

本地开发时，Agent 没有公网地址。用隧道工具：

```bash
# 任选其一
ngrok http 8080
cloudflared tunnel --url http://localhost:8080
```

把得到的公网 URL 配到 `endpoint_url`。

### 7.2 手动触发测试

```bash
POST /v1/me/agent-takeover/test-webhook
Authorization: Bearer <jwt>
```

平台会向你的 `endpoint_url` 发送一个测试事件：

```json
{
  "event": "webhook.test",
  "event_id": "evt_test_01",
  "occurred_at": 1767225600000,
  "data": { "message": "这是一条测试事件" }
}
```

它带完整的签名头，所以你验签、解析、返 200 这一整套都能在写业务逻辑之前先跑通。
它与真实事件的区别只有 `event` 字段（`webhook.test` vs `message.created`），
且**不重试**——一次点击就是一次，所以 `http_status` 就是你的端点此刻的真实反应。

如果 `attempted=false`，那说明**平台根本没发**（不是 WEBHOOK 模式 / 没配 `endpoint_url` /
没有 `webhook_secret`），`error` 会写清是哪一种。

响应会返回平台侧的观测结果：

```json
{
  "code": 0,
  "data": {
    "attempted": true,
    "http_status": 200,
    "latency_ms": 43,
    "error": null
  }
}
```

### 7.3 投递日志

```http
GET /v1/me/agent-takeover/webhook-deliveries?limit=50
Authorization: Bearer <jwt>
```

```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "delivery_id": "dlv_01HQ...",
        "event_id": "evt_01HQ2X3Y4Z5A6B7C8D9E0F",
        "event_type": "message.created",
        "attempt": 1,
        "http_status": 200,
        "latency_ms": 43,
        "status": "SUCCESS",
        "created_at": "2026-01-01T08:00:00.500Z"
      }
    ],
    "next_cursor": null
  }
}
```

排错时用它确认：平台是否发了？发了几个？你的响应是什么？

> **它只保留每个账号最近的若干条，而且不落库**（进程内环形缓冲，
> `tm.agent.webhook-log-size` 默认 100，服务重启即清空）——
> 它回答的是「刚刚那次为什么没送到」，而不是「上个月一共投了多少条」。
> 后者需要一张投递表（写入量 = 事件量 × 尝试次数），属于另一个量级的工程决定。
>
> 三件事合起来看能回答一次「收不到事件」：
> `attempted`（§7.2 的测试）、`status` / `http_status`（§7.3 的日志）、
> 以及服务端的 `tm-webhook-*` 线程日志（放弃重投时会记 ERROR）。

---

## 8. 常见接入错误

| 现象 | 原因 | 解决 |
|---|---|---|
| 一直验签失败 | 用了重新序列化的 JSON | 改用原始 body 字节 |
| 一直验签失败 | timestamp 被当数字处理 | 用**字符串原文**拼接 |
| 偶发验签失败 | body 被框架做了编码转换 | 确保按 UTF-8 原始字节读取 |
| 重复处理同一消息 | 没做 `event_id` 幂等 | 加 `SETNX` 去重 |
| 消息顺序错乱 | Webhook 并发投递 | 用 `seq` 缓冲重排，或改为「触发 + REST 拉取」 |
| 平台侧超时重试 | 同步处理耗时过长 | 立即返回 200，异步处理 |
| 收到重复事件 | **这是正常的** | at-least-once 语义，靠幂等处理 |
| 收不到事件 | endpoint 非公网可达 | 用 ngrok 类工具或部署到公网 |

---

## 9. 检查清单

- [ ] `endpoint_url` 是公网可达的 HTTPS 地址
- [ ] 校验 `X-TM-Signature`，用**原始 body 字节**
- [ ] 校验 `X-TM-Timestamp`，偏差 > 300 秒拒绝
- [ ] 用**常量时间比较**（`hmac.compare_digest` / `timingSafeEqual` / `MessageDigest.isEqual`）
- [ ] 用 `event_id` 做幂等去重（保留 ≥ 7 天）
- [ ] **5 秒内返回 2xx**，耗时逻辑异步化
- [ ] 处理乱序（用 seq 缓冲或改为 REST 拉取）
- [ ] 配置了投递失败告警
- [ ] 通过了自测向量验证
`,i=[{num:"00",slug:"overview",label:"总览",text:G},{num:"01",slug:"concepts",label:"概念",text:I},{num:"02",slug:"auth",label:"认证",text:O},{num:"03",slug:"rest",label:"REST",text:L},{num:"04",slug:"realtime",label:"长连接",text:B},{num:"05",slug:"webhook",label:"Webhook",text:U},{num:"06",slug:"no-sdk",label:"无 SDK",text:H},{num:"07",slug:"errors",label:"错误",text:j},{num:"08",slug:"admin",label:"管理端",text:M}];function K(m){var r,n,d;const c=(r=m.split("#")[0].split("/").pop())!=null?r:"";if(c==="README.md")return i[0];const p=(n=/^(\d{2})-/.exec(c))==null?void 0:n[1];return p===void 0?null:(d=i.find(_=>_.num===p))!=null?d:null}function W(m){return m.text.replace(/^#\s+.*
+/,"").split(/^(?=##\s)/m).map(n=>n.trim()).filter(n=>n!=="")}const Y={class:"page doc doc-protocol"},F=["aria-expanded"],z={class:"doc-chapter-label-text"},X={class:"doc-chapter-list",role:"listbox"},V=["aria-selected","onClick"],J={class:"doc-chapter-opt-num"},Z={class:"doc-body-nav"},$=["disabled"],Q=["disabled"],an=C({__name:"ProtocolView",setup(m){const r=v(0),n=v(!1),d=v(null),c=S(()=>{var e;return(e=i[r.value])!=null?e:i[0]}),p=S(()=>W(c.value));function _(e){e<0||e>=i.length||(n.value=!1,r.value=e,d.value!==null&&(d.value.scrollTop=0))}function A(e){var t;const a=(t=e.target)==null?void 0:t.closest("a"),s=a==null?void 0:a.getAttribute("href");if(!s||/^[a-z][a-z0-9+.-]*:/i.test(s)||s.startsWith("#"))return;const g=K(s);g!==null&&(e.preventDefault(),_(i.indexOf(g)))}function k(e){var t;(t=e.target)!=null&&t.closest(".doc-chapter-label")||(n.value=!1)}return(e,t)=>(l(),u("div",Y,[f(x,{title:"完整协议文档",back:""}),o("div",{class:"doc-chapter-menu",onClick:k},[o("button",{type:"button",class:T(["doc-chapter-label",{open:n.value}]),"aria-expanded":n.value,"aria-haspopup":"listbox",onClick:t[0]||(t[0]=a=>n.value=!n.value)},[o("span",z,h(c.value.label),1),f(N,{class:"doc-chapter-caret",name:"forward",size:16})],10,F),q(o("div",X,[(l(!0),u(E,null,b(y(i),(a,s)=>(l(),u("button",{key:a.slug,type:"button",class:T(["doc-chapter-option",{active:s===r.value}]),role:"option","aria-selected":s===r.value,onClick:g=>_(s)},[o("span",J,h(String(s+1).padStart(2,"0")),1),R(" "+h(a.label),1)],10,V))),128))],512),[[P,n.value]])]),o("div",{ref_key:"body",ref:d,class:"page-body doc-body",onClick:A},[(l(!0),u(E,null,b(p.value,(a,s)=>(l(),w(D,{key:c.value.slug+"-"+s,text:a},null,8,["text"]))),128)),o("div",Z,[o("button",{type:"button",class:"btn",disabled:r.value===0,onClick:t[1]||(t[1]=a=>_(r.value-1))},"上一章",8,$),o("button",{type:"button",class:"btn btn-primary",disabled:r.value===y(i).length-1,onClick:t[2]||(t[2]=a=>_(r.value+1))}," 下一章 ",8,Q)])],512)]))}});export{an as default};