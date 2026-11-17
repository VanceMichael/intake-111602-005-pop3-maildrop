# 合作邮箱取件查看器

用于检查授权来源的一份原始资料并留存接收凭据。当前提供资料预览、原件接收、凭据列表与摘要回读，资料源可以在本地独立运行。

## 环境与运行

使用 Node.js 22.23.4，无第三方运行包。安装、检查与测试：

```sh
npm ci --ignore-scripts --offline
npm run build
npm test
npm run demo
```

`demo` 临时启动来源和查看服务，展示当前资料并核对保存后的原件，随后演示正式收件、DELE/QUIT 清理与新会话核对的完整交接；结束时关闭所有监听并移除临时目录。不会连接外部来源。`test` 校验已有预览、资料控制、原件持久化以及清理交接的状态机与断连处理；测试通过只说明当前版本已有能力正常。

需要交互时分别运行 `npm run source` 与 `npm start`。来源默认监听本机 4310 端口，应用默认监听 4320；可用 `PORT`、`SOURCE_URL`、`DATA_DIR` 配置。`GET /preview` 获取预览，`POST /receipts` 接收当前资料，`GET /receipts` 查询凭据，`GET /objects/<摘要>` 回读原件。应用只允许配置到本机的资料服务。

## 正式收件与清理

清理合作方邮箱的接口（编号均为来源端会话内编号，需显式指定会话）：

- `POST /maildrop/sessions` 打开/确认会话并返回 UIDL 能力；`GET /maildrop/scan?sessionId=<编号>` 扫描当前邮箱
- `POST /maildrop/receive` 凭 RETR 完整应答正式收件并留存原件（TOP 预览不算收妥）
- `POST /maildrop/mark-deletion` 对已留存邮件发 DELE；未留存、已确认删除等情况会被拒绝
- `POST /maildrop/commit` 发 QUIT 提交本会话删除；应答缺失时返回 `ambiguous` 并把邮件置为未知状态
- `POST /maildrop/reconcile` 用新会话的邮箱实际状态核对，只有核对确认不存在才是 `deleted-confirmed`
- `GET /maildrop/handoff` 交班摘要：只列待办，结论依据最新核对而非历史命令；`GET /maildrop/messages` 查台账明细

核心安全规则：没有本地完整原件不得 DELE；DELE/QUIT 命令记录不直接等于删除结论；无 UIDL 时身份降级为完整原件摘要并显式记录不确定性，主题、日期、Message-ID 不参与合并。状态机与身份规则见 `docs/资料接口.md`。

## 目录

`source/` 负责资料源的发布日期和传输状态；`src/decode.mjs` 解释一份来源资料并抽取完整邮件字节；`src/identity.mjs` 管理可确认的身份依据与不确定性；`src/pop3.mjs` 是 POP3 网关会话客户端，区分协议拒绝与应答缺失；`src/catalog.mjs` 管理不可变原件及接收凭据；`src/ledger.mjs` 持久化清理状态机与核对记录；`src/maildrop.mjs` 编排收件、清理与交接；`src/app.mjs` 提供查看服务。资料含义及来源控制见 `docs/资料接口.md`。

## 容器

```sh
docker build -t pop3-maildrop .
docker run --rm --network none pop3-maildrop
```

镜像固定 Node.js 版本，构建期间不下载 npm 运行依赖。运行产生的原件保存在 `DATA_DIR`，不应写回来源文件。
