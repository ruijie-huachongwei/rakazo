# Rakazo 服务器源码部署

本方案面向一台专用 Linux 服务器，推荐由宿主机 Nginx 提供域名 HTTPS，反代到 `127.0.0.1:5173`；也保留可信内网 IPv4 HTTP 入口。浏览器、Electron 和移动端连接同一对外地址。**默认从服务器上的当前源码构建并发布**，修改后的 Web、API、Worker、共享包和计算机环境会进入自建镜像。Node.js 和 pnpm 在构建容器内运行，服务器无需另行安装。

服务器实际地址和域名只在初始化或配置宿主机时填入，不写进可提交文件。下文的 `app.example.com` 均需替换为实际域名。运行时配置位于本目录的 `.env`，已通过 `.gitignore` 忽略。不要把它、证书私钥或备份提交到仓库或贴进工单。

## 文件与服务

| 文件 | 用途 |
| --- | --- |
| `docker-compose.yml` | 叠加到官方镜像编排：项目名为 `rakazo-server`，仅向指定 IP 发布 Web 端口，取消宿主机 API 端口 |
| `docker-compose.source.yml` | 默认加载，将应用和计算机切换为自建镜像，复用同一套网络和数据卷 |
| `.env.example` | 无真实凭据的配置模板，包含自建镜像名和备用官方镜像设置 |
| `nginx.conf.example` | 宿主机 Nginx 的 HTTPS 站点示例，使用现有证书，支持流式响应与 WebSocket |
| `deploy.sh` | 初始化、源码构建发布、备用镜像部署、启停、账号创建、日志和备份 |
| `deploy.test.mjs` | 无需 Docker、无需联网的脚本测试 |

完整服务来自 [官方镜像 Compose](../../infra/compose/docker-compose.images.yml)：PostgreSQL、迁移任务、沙箱 supervisor、API、Worker、Web，以及计算机镜像和数据目录初始化任务。脚本按顺序叠加官方编排、内网配置、源码镜像配置；不要单独运行本目录的 Compose 文件。

应用镜像复用 [应用 Dockerfile](../../infra/compose/Dockerfile)，API、Worker、Web、supervisor 和迁移任务共享同一个构建结果；计算机镜像使用 [计算机 Dockerfile](../../infra/sandboxes/computer/Dockerfile)。脚本临时复制应用 Dockerfile 与根目录的 `.dockerignore`，额外排除部署备份和临时构建文件，避免将运行密钥、数据库转储或数据归档打入应用镜像。临时文件在成功或失败后清理，不改动官方 Dockerfile。

数据保存在 `rakazo-server` 项目的 `pgdata` 和 `appdata` 命名卷中。`webassets` 是可重建的前端资源缓存。公开注册默认关闭，账号由服务器操作员创建；账号没有服务器管理权限。

## 1. 准备服务器

- Ubuntu 22.04/24.04 或其他受支持的 Linux，使用专用服务器或虚拟机；supervisor 持有 Docker socket，权限等同于控制宿主机。
- Docker Engine **26+**、Docker Compose 插件 **2.24.4+**、Bash、OpenSSL 和常见 GNU 工具。版本要求分别来自计算机卷子路径与 Compose `!override`。
- 建议从 4 核、8 GB 内存、50 GB 可用磁盘开始；这是容量建议，不是官方最低配置。每个计算机默认上限为 2 核、2 GB；源码构建需要额外时间和磁盘空间。
- 服务器能够下载 Docker Hub 基础镜像、Node.js 包和计算机环境所需系统依赖，并访问所选模型。备用官方镜像模式还需要访问 GHCR。
- HTTPS 方案需要客户端能访问 Nginx 的 TCP `443`，按需开放用于 HTTP 跳转的 `80`，不对外开放 `5173`。只有直接使用内网 HTTP 时才向可信网段开放 `5173`。
- 上传或克隆完整源码仓库，保留锁文件、工作区配置和 Dockerfile，不要只上传本目录。下面命令均在服务器仓库根目录执行，不在 Windows PowerShell 中执行。

推荐将完整源码放在 `/data/rakazo/app`，然后 `cd /data/rakazo/app`。本目录的脚本和配置需要一并同步；上游仓库不一定包含你的本地部署文件。命名数据卷仍由 Docker 管理，通常位于 `/var/lib/docker`，不会因为源码在 `/data` 就自动迁移过去。

先检查 Docker：

```bash
docker version
docker compose version
```

## 2. 生成配置

此命令只用于全新部署。已有数据库或数据卷时，必须恢复匹配的原始 `.env`，不能重新生成密钥或数据库密码。

### 推荐：已有域名和本机 Nginx

将域名替换为实际值，不要在域名后面加页面路径。`--host` 是后端监听 IP，`--origin` 才是用户访问的 HTTPS 地址，两者不是同一项：

```bash
bash docs/deploy/deploy.sh init \
	--host 127.0.0.1 \
	--origin https://app.example.com \
	--from-template
```

不用先复制 `.env.example`。如果已经原样复制为 `.env`，`--from-template` 会在确认六项凭据均为空且配置内容与模板一致后补齐，并将原文件备份为 `.env.before-init.*`。支持 Windows CRLF 换行，注释和空行差异不影响比较；配置改动、已有密钥或符号链接都会被拒绝，原文件保持不变。不要删除已有配置来强行重试。

初始化会生成六项独立随机凭据，不需要手填。生成配置与模板备份的权限均为 `0600`，脚本不打印密钥。访问地址会自动设成下面的对应关系：

```dotenv
RAKAZO_HOST=app.example.com
RAKAZO_BIND_ADDRESS=127.0.0.1
RAKAZO_WEB_PORT=5173
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
```

如果 `.env` 已经生成过，只手动修改这六项访问设置，保留所有原有密码和密钥，再执行 `up`。不要对已有数据运行模板初始化。

### 备选：仅可信内网 HTTP

将 `SERVER_IP` 替换为服务器实际内网 IPv4，不传 `--origin`：

```bash
bash docs/deploy/deploy.sh init --host SERVER_IP
```

若已原样复制模板，可追加 `--from-template`；非默认后端端口可追加 `--port 55173`。HTTP 模式的三个 origin 均为 `http://SERVER_IP:端口`。HTTPS 模式修改后端端口时还需同步调整 Nginx 的上游端口，域名 origin 不需要加上 `5173`。

### 每个参数怎么填

下面覆盖模板中的全部参数。多数保持默认，访问设置由初始化命令填写，六项密码和密钥由脚本生成。实际修改只在服务器的 `docs/deploy/.env` 中进行。

| 访问参数 | 作用与填写方式 |
| --- | --- |
| `RAKAZO_HOST` | Web 接受访问的主机名；HTTPS 填 `app.example.com`，不带协议、路径或端口。HTTP 填服务器 IP |
| `RAKAZO_BIND_ADDRESS` | 宿主机暴露 Web 端口的监听 IP；本机 Nginx 填 `127.0.0.1`，不是域名。远端网关需改用服务器内网 IP 并限制来源 |
| `RAKAZO_WEB_PORT` | Nginx 转发到的后端 HTTP 端口，保持 `5173`，不是 HTTPS 的 `443` |
| `BETTER_AUTH_URL` | 登录服务的对外地址，HTTPS 填 `https://app.example.com` |
| `WEB_ORIGIN` | 浏览器来源校验地址，与 `BETTER_AUTH_URL` 完全相同 |
| `API_URL` | API 的对外地址，与上面两项相同，不填容器内部的 `3100` 端口 |

| 自动生成参数 | 作用与注意事项 |
| --- | --- |
| `POSTGRES_PASSWORD` | 数据库所有者密码，用于数据库初始化、迁移和备份，不是网页登录密码 |
| `POSTGRES_APP_PASSWORD` | API/Worker 使用的受限数据库角色密码，与所有者密码独立生成 |
| `BETTER_AUTH_SECRET` | 登录、会话等认证数据使用的服务端密钥，更新和重启时保留 |
| `ENCRYPTION_KEY` | 加密保存的凭据与内容所用密钥；必须随数据备份，丢失后无法解密 |
| `SCREEN_PROXY_SECRET` | 智能体计算机屏幕代理的签名密钥 |
| `SANDBOX_SUPERVISOR_TOKEN` | API/Worker 调用高权限 Docker supervisor 的认证令牌，不能公开 |

两项数据库密码为独立的 32 位十六进制字符串，其余四项为独立的 64 位十六进制字符串。不要把这六项改成示例文字或复制成同一个值；不要仅修改 `.env` 来轮换已有数据库密码或加密密钥。

| 默认参数 | 作用与建议 |
| --- | --- |
| `SIGNUPS_ENABLED` | 是否允许公开自助注册；保持 `false`，由 `owner` 命令创建账号 |
| `SIGNUP_ALLOWLIST` | 注册允许名单；当前关闭公开注册，保持空，需要改变注册策略时再配置 |
| `AUTH_PASSWORD_ENABLED` | 是否启用密码登录；保持 `true`，没有 OIDC 配置时不能设为 `false` |
| `EMAIL_PROVIDER` | 邮件发送方式；`none` 表示不发送邮件，也没有邮件找回密码能力，接入邮件见官方指南 |
| `SANDBOX_PROVIDER` | 计算机运行后端；保持 `docker`，使用本机 Docker，不需要云沙箱账号 |
| `SANDBOX_COMPUTER_EGRESS` | 计算机出站网络策略；保持 `restricted` 并安装下一节规则，不应为方便而直接开放内网 |
| `SANDBOX_COMPUTER_DNS` | 计算机使用的 DNS，默认 `1.1.1.1,1.0.0.1`；restricted 模式不能直接使用被隔离的内网 DNS |
| `RAKAZO_COMPUTER_MEMORY` | 每台智能体计算机的内存上限，保持 `2g`，不是整台服务器的限制 |
| `RAKAZO_COMPUTER_CPUS` | 每台智能体计算机的 CPU 上限，保持 `2` |
| `RAKAZO_COMPUTER_PIDS_LIMIT` | 每台智能体计算机的进程数上限，保持 `2048` |
| `CONTENT_ENCRYPTION` | 新内容是否加密存储；保持 `on`，修改它不会自动重写旧内容 |
| `POSTGRES_USER` | 数据库所有者角色名，保持 `rakazo`，不是产品登录账号 |
| `POSTGRES_DB` | 数据库名，保持 `rakazo`，已有数据后不要随意改名 |
| `LOG_LEVEL` | 日志级别，保持 `info`；排障临时改为 `debug` 时注意日志可能包含敏感上下文 |

| 镜像与可选模型参数 | 作用与建议 |
| --- | --- |
| `RAKAZO_SOURCE_IMAGE` | 源码构建的应用镜像名，保持 `rakazo-server/app:local`；Web、API、Worker、supervisor 和迁移共用它 |
| `RAKAZO_SOURCE_COMPUTER_IMAGE` | 源码构建的计算机镜像名，保持 `rakazo-server/computer:local` |
| `RAKAZO_IMAGE` | 仅备用官方镜像模式使用的应用仓库，源码模式不以此选择应用镜像 |
| `RAKAZO_IMAGE_TAG` | 官方应用镜像版本，默认 `edge`；备用模式可固定为兼容的已发布版本 |
| `RAKAZO_COMPUTER_IMAGE` | 仅备用官方镜像模式使用的计算机镜像仓库 |
| `RAKAZO_COMPUTER_IMAGE_TAG` | 官方计算机镜像版本，默认 `edge`，备用模式应与应用选择兼容版本 |
| `OPENROUTER_API_KEY` | 可选模型密钥，可以留空；登录后在共享连接设置中配置模型即可，不要求使用此供应商 |

已有 `.env` 缺少两个 `RAKAZO_SOURCE_*` 参数时会使用上述源码镜像默认值，无需重新初始化。语音、应用集成和云沙箱都不是最小部署依赖。

## 3. 安装计算机出站隔离规则

默认 `SANDBOX_COMPUTER_EGRESS=restricted`，让智能体能访问公网，但不能访问宿主机、内网和云元数据。必须由操作员在 Linux Docker 宿主机上安装官方规则：

```bash
sudo bash infra/compose/restrict-computer-egress.sh
```

规则需要 Linux Docker Engine、iptables 后端及管理员权限，不支持 Docker Desktop、rootless Docker 或 Docker 的 nftables 后端。脚本会修改宿主机防火墙，请先审阅；部署脚本不会自行提权或修改防火墙。

默认计算机 DNS 为 `1.1.1.1,1.0.0.1`。若所在网络屏蔽公共 DNS，需要调整网络策略或按官方文档选择可行方案，不能直接把被 restricted 模式阻止的内网 DNS 填进去。

如确实需要计算机访问内网服务，需明确接受风险，将 `.env` 的 `SANDBOX_COMPUTER_EGRESS` 改为 `open`，并执行 `sudo bash infra/compose/restrict-computer-egress.sh --remove`。更改后重新运行 `up`；旧计算机可能需要停止并重新启动。API/Worker 访问内网模型不等同于计算机访问内网，不必仅为内网模型就放开计算机隔离。

## 4. 启动与创建账号

```bash
bash docs/deploy/deploy.sh check
bash docs/deploy/deploy.sh up
bash docs/deploy/deploy.sh status
bash docs/deploy/deploy.sh health
bash docs/deploy/deploy.sh owner
```

`up` 先构建应用和计算机镜像，只拉取 PostgreSQL 与数据目录初始化所需的基础服务镜像，然后启动服务。源码构建失败时不会继续更新容器，也不会因此停止正在运行的旧容器。启动健康检查最多等待 300 秒，构建和下载时间不在此范围内。迁移成功后 API 才会启动；`computer`、`data-init`、`migrate` 等一次性任务显示 `Exited (0)` 是正常现象。`check` 只检查版本与 Compose 模型，不启动服务，也不验证模型凭据或宿主机隔离规则。

`owner` 交互读取邮箱和至少 16 位的密码，密码不回显、不放在命令参数中。它创建普通的已验证账号与个人空间，没有服务器管理权限。当前未配置邮件，请妥善保管登录密码；邮件找回需要另行配置。

HTTPS 方案完成下一节 Nginx 配置后，浏览器打开 `https://app.example.com`。仅内网 HTTP 方案打开 `http://SERVER_IP:5173`。使用刚创建的账号登录，连接模型，发送消息并打开智能体计算机，确认浏览器、终端和文件能力可用。Electron 选择 **Existing instance**；移动端使用同一个对外地址。客户端设备需要能解析域名并访问服务器。

HTTP 不加密密码、会话或消息，仅适用于可信内网。普通内网 HTTP 不是浏览器安全上下文，麦克风和通行密钥等功能可能不可用；需要这些能力或公网访问时应配置 HTTPS。

## 5. 接入已有证书的本机 Nginx

本节假设 Nginx 直接运行在同一宿主机，而不是独立 Docker 容器；容器内的 `127.0.0.1` 不代表宿主机。已有证书只需引用，无需重新签发或复制进应用镜像：

```text
/etc/nginx/tls/fullchain.pem
/etc/nginx/tls/privkey.pem
```

确认域名解析到 Nginx 所在服务器的可达地址，证书覆盖该域名且未过期，Nginx 主进程有权限读取这两个文件。不要降低私钥权限或把私钥放进仓库。

先检查现有站点是否已经使用同一域名。如果有，保留原站点配置与证书设置，将 [Nginx 示例](nginx.conf.example) 的 `location /` 转发设置合并到该站点，并把 `map` 放在 `http {}` 中，只保留一份；不要再新增同名 `server`。原站点其他路径有业务时，先确认这个域名能够整体交给 Rakazo，不能直接覆盖。

只有没有同域名站点时，才在确认 `/etc/nginx/conf.d/*.conf` 被 `http {}` 加载后新增配置：

```bash
sudo install -m 0644 docs/deploy/nginx.conf.example /etc/nginx/conf.d/rakazo.conf
sudoedit /etc/nginx/conf.d/rakazo.conf
```

将新文件中全部 `app.example.com` 替换为实际域名，保留证书路径。`map` 不能放在 `server {}` 或 `location {}` 中。修改前保留原配置的私有备份，不要覆盖已经存在的 `rakazo.conf`；其他 Nginx 目录结构按实际 include 位置调整。

配置保留 Host 和 HTTPS 来源，关闭代理响应缓冲与缓存以支持流式消息，并转发 WebSocket 升级头以支持智能体屏幕等长连接。代理请求体上限为 `100m`，应用仍执行自身上传限制。若后端不是 `5173`，同时修改 `proxy_pass`。

验证成功后才重载，失败时不要重载：

```bash
sudo nginx -t
```

```bash
sudo systemctl reload nginx
```

不要为了启用 Rakazo 停止整台服务器的 Nginx，也不需要新增 TLS 容器占用已有的 `80/443`。不要将 Docker socket、数据库、API 或 supervisor 对外开放。更换证书后也应先 `nginx -t` 再重载。

应用启动后，在服务器上检查两段链路：

```bash
curl --fail --silent --show-error -o /dev/null http://127.0.0.1:5173/
curl --fail --silent --show-error -o /dev/null https://app.example.com/
```

第一条通过而第二条失败时，检查 DNS、证书、Nginx 和防火墙。不要用 `curl -k` 掩盖证书错误；企业内部 CA 需要先正确加入服务器和客户端信任库。最终还需在浏览器检查登录、流式消息及计算机屏幕，页面能打开并不代表 WebSocket 已连通。

## 6. 日常运维与更新

本地二次开发时，可用 [源码开发流程](../../README.zh-CN.md) 的 `pnpm dev` 验证改动。准备发布时，先备份服务器数据，将修改提交并同步到服务器，再在服务器执行：

```bash
git pull --ff-only
bash docs/deploy/deploy.sh up
bash docs/deploy/deploy.sh health
```

没有使用 Git 时，上传完整更新后的源码再执行 `up`。构建读取服务器当前工作区，而不是远程分支或官方应用镜像；未提交但未被 `.dockerignore` 排除的改动也会进入构建。存在 Git 提交时会将其 SHA 传入应用镜像，便于追踪，但 SHA 不代表工作区没有未提交修改。

只构建验证、不更新运行容器时使用：

```bash
bash docs/deploy/deploy.sh build
```

其他常用命令：

```bash
bash docs/deploy/deploy.sh logs api
bash docs/deploy/deploy.sh logs worker
bash docs/deploy/deploy.sh logs supervisor
bash docs/deploy/deploy.sh stop
bash docs/deploy/deploy.sh start
```

`stop` 不删除数据；`start` 使用已构建的源码镜像恢复服务，不重新构建、不拉取更新。源码修改必须执行 `up` 才会构建并发布，仅重启容器不会生效。替换计算机镜像后，已运行的计算机不会热更新，请先保存工作，并在需要时停止、重新启动计算机。

默认 `local` 标签会在构建时被覆盖。需要保留回退版本时，每次发布为两个 `RAKAZO_SOURCE_*` 镜像设置不同标签，并保留旧镜像。发布可能短暂停机，不会自动回滚；回退前必须确认旧代码与当前数据库及内容加密格式兼容。选择已有旧镜像后用 `start`，不要用会重新构建该标签的 `up`。

不要运行根目录的 `pnpm compose:down` 或任何 `docker compose down -v` 来日常停机，它们会删除数据卷。也不要混用根目录的 `.env` 和本目录配置，或使用其他项目名操作这套服务。

### 备用官方镜像模式

确实需要运行官方预构建版本时，显式执行：

```bash
bash docs/deploy/deploy.sh up-images
```

该入口跳过源码构建，拉取 `RAKAZO_IMAGE`、`RAKAZO_COMPUTER_IMAGE` 对应镜像；源码修改不会进入官方镜像。恢复运行用 `start-images`，更新官方版本用 `up-images`。`status`、`logs`、`stop`、`owner` 和 `backup` 仍操作同一项目。两种模式使用相同数据库、数据卷和密钥，切换前要备份并确认版本兼容；再次运行默认的 `up` 会切回源码构建发布。

## 7. 备份与恢复

先在界面停止所有智能体计算机，再执行：

```bash
bash docs/deploy/deploy.sh backup --computers-stopped
bash docs/deploy/deploy.sh start
```

备份会停止 Web、Worker、API 和 supervisor，PostgreSQL 保持运行；脚本不会替你停止独立的计算机容器。只有确认计算机已停止，文件备份才具备所需的静止条件。成功和失败时应用都保持停止，操作员确认后通过 `start` 恢复服务。

快照位于 `docs/deploy/backups/UTC时间/`，包含 PostgreSQL 自定义格式转储 `postgres.dump`、完整 `appdata.tgz`、原始 `.env` 和 `SHA256SUMS`。脚本以 root 辅助容器读取数据卷，避免遗漏普通 API 用户无法读取的文件，检查转储目录与归档并生成校验和。只有出现成功提示且所有检查通过才算完成；失败的快照不可用于恢复。

备份目录仅当前操作员可读，但**未额外加密，且包含全部运行密钥**。必须加密后异机保存，安排周期备份并演练恢复；数据卷持久化不等于备份。`ENCRYPTION_KEY` 丢失或直接重置会使加密内容和凭据不可恢复。使用外部对象存储时还需要独立备份对应 bucket，本脚本不会复制它。

恢复应在空数据库和空 `appdata` 卷上进行，先校验快照，恢复匹配的 `.env`，准备数据库所需角色，再以数据库所有者运行 `pg_restore`，解压应用数据到 `appdata`，最后运行 `start` 使迁移和应用启动。不要直接向已有实例导入或覆盖数据；跨主机时同步修改监听 IP 和访问 origin。本快照格式不适用于根目录的 `scripts/restore.sh`，也不能直接套用生产备份脚本的文件名。

## 网络受限环境

镜像下载失败时先看 [受限网络指南](../self-host-restricted-network.md)。`POSTGRES_IMAGE`、`BUSYBOX_IMAGE` 可指向可信基础镜像仓库；备用官方镜像模式还可设置 `RAKAZO_IMAGE`、`RAKAZO_COMPUTER_IMAGE`。源码构建需要基础镜像、Node.js 包和系统包的网络访问，不能只解决 GHCR 下载就认为能离线构建。Shell 的代理设置不一定被 Docker daemon 或构建步骤使用。源码镜像已经构建好、基础服务镜像也已导入时，可用 `start` 跳过构建和拉取。

## 本地离线测试

在有 Node.js 24 和 Bash 的开发机运行，不需要部署服务器或 Docker。Windows 可使用 Git Bash，通过 `BASH_PATH` 指定非默认位置：

```bash
node --test docs/deploy/deploy.test.mjs
```

测试覆盖 HTTP/HTTPS 配置生成、原样模板补全、凭据保护、参数校验、Nginx 转发约束、最低 Compose 版本、源码构建顺序、临时构建排除规则、失败保护和备用镜像入口。设置 `COMPOSE_PATH` 为独立 Compose 工具路径时还会验证真实配置合并；Nginx 的实际语法与证书通过服务器上的 `nginx -t` 检查。实际镜像构建、容器健康、网络隔离、模型连接与恢复流程仍须在目标 Linux 服务器验证。