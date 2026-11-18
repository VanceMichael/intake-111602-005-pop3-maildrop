# 合作邮箱取件查看器

用于检查授权来源的一份原始资料并留存接收凭据。当前提供资料预览、正式收件、来源端清理、交接核对、凭据列表与摘要回读，资料源可以在本地独立运行。

## 环境与运行

使用 Node.js 22.23.4，无第三方运行包。安装、检查与测试：

```sh
npm ci --ignore-scripts --offline
npm run build
npm test
npm run demo
```

`demo` 临时启动来源和查看服务，演示新会话发现、正式收件、来源端清理与交接核对；结束时关闭所有监听并移除临时目录。不会连接外部来源。`test` 校验已有预览、资料控制、原件持久化，以及收件/清理/断开核对的全部不变量；测试通过只说明当前版本已有能力正常。

需要交互时分别运行 `npm run source` 与 `npm start`。来源默认监听本机 4310 端口，应用默认监听 4320；可用 `PORT`、`SOURCE_URL`、`DATA_DIR` 配置。`GET /preview` 获取预览，`POST /receipts` 接收当前资料，`GET /receipts` 查询凭据，`GET /objects/<摘要>` 回读原件。应用只允许配置到本机的资料服务。

## 正式收件与清理接口

- `POST /mailbox/intake`：开新会话做完整 RETR，校验完整后把 RFC822 原件写入内容摘要目录并登记台账；可传 `{"number":N}` 指定会话内编号。TOP 预览和被截断的 RETR 不会产生任何凭据。
- `POST /mailbox/purge`：先开新会话核对邮箱现状，仅对本地已有完整凭据的邮件发 DELE，再 QUIT；结束后另开新会话复核。无凭据的邮件只跳过、不删除。
- `POST /mailbox/reconcile`：用全新会话的邮箱现状重判每封邮件的真实状态，是换班后唯一可信的核对入口，不读取上一班的命令记忆。
- `GET /mailbox/status`：返回每封邮件的身份依据、身份局限、状态与完整历史链，以及尚未收敛的待核对问题。

编号只在当前会话内有效，DELE 不代表邮箱已更新。QUIT 静默断开时状态记为 `quit-ambiguous`，由下一次新会话证据决定翻成 `deleted-confirmed` 还是回到 `received`。无 UIDL 邮箱改用 LIST 列编号、逐封 RETR 摘要比对，身份仅由完整原件的 SHA-256 确认，并保留“同摘要多信无法区分”等局限说明；主题、日期、Message-ID 相同也不会被合并。

## 目录

`source/` 负责资料源的发布日期和传输状态；`src/decode.mjs` 解释一份来源资料并抽取完整原件；`src/pop3.mjs` 是区分成功、-ERR 与传输中断的 POP3 会话客户端；`src/catalog.mjs` 管理不可变原件及接收凭据；`src/ledger.mjs` 持久化带证据的收件与清理台账；`src/mailbox.mjs` 编排收件、清理与核对；`src/app.mjs` 提供查看服务。资料含义及来源控制见 `docs/资料接口.md`。

## 容器

```sh
docker build -t pop3-maildrop .
docker run --rm --network none pop3-maildrop
```

镜像固定 Node.js 版本，构建期间不下载 npm 运行依赖。运行产生的原件保存在 `DATA_DIR`，不应写回来源文件。
