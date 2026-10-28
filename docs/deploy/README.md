# Rakazo 内网服务器部署

本方案面向一台专用 Linux 服务器，通过内网 IPv4 和 HTTP 提供 Rakazo，默认端口为 `5173`。浏览器、Electron 和移动端连接同一地址。**默认从服务器上的当前源码构建并发布**，修改后的 Web、API、Worker、共享包和计算机环境会进入自建镜像。Node.js 和 pnpm 在构建容器内运行，服务器无需另行安装。

服务器实际地址只在初始化时传入，不写进可提交文件。运行时配置位于本目录的 `.env`，已通过 `.gitignore` 忽略。不要把它提交到仓库或贴进工单。

## 文件与服务

| 文件 | 用途 |
| --- | --- |
| `docker-compose.yml` | 叠加到官方镜像编排：项目名为 `rakazo-server`，仅向指定 IP 发布 Web 端口，取消宿主机 API 端口 |
| `docker-compose.source.yml` | 默认加载，将应用和计算机切换为自建镜像，复用同一套网络和数据卷 |
| `.env.example` | 无真实凭据的配置模板，包含自建镜像名和备用官方镜像设置 |
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
- 局域网客户端能够访问服务器的 TCP `5173`；防火墙只允许可信网段，不要开放到公网。
- 上传或克隆完整源码仓库，保留锁文件、工作区配置和 Dockerfile，不要只上传本目录。下面命令均在服务器仓库根目录执行，不在 Windows PowerShell 中执行。

先检查 Docker：

```bash
docker version
docker compose version
```

## 2. 生成配置

将 `SERVER_IP` 替换为服务器实际内网 IPv4：

```bash
bash docs/deploy/deploy.sh init --host SERVER_IP
```

非默认端口可追加 `--port 55173`。初始化会写入主机 IP、监听地址、端口、三个相同的访问 origin，以及六项独立随机凭据。生成文件权限为 `0600`，脚本不打印密钥；重复初始化会报错并保留原文件。

此命令只用于全新部署。已有数据库或数据卷时，必须恢复匹配的原始 `.env`，不能重新生成密钥或数据库密码。

需要时在服务器本地编辑 `docs/deploy/.env`：

- 源码模式默认构建 `rakazo-server/app:local` 和 `rakazo-server/computer:local`。可通过 `RAKAZO_SOURCE_IMAGE`、`RAKAZO_SOURCE_COMPUTER_IMAGE` 设置自有镜像名与版本标签。已有 `.env` 缺少这两项时也会使用上述默认值，不需要重新初始化。
- `RAKAZO_IMAGE_TAG` 和 `RAKAZO_COMPUTER_IMAGE_TAG` 仅用于备用官方镜像模式，默认均为 `edge`；按需固定到同一已发布版本，不假定 `latest` 存在。
- 模型可以登录后在连接设置中添加，不必预填 `OPENROUTER_API_KEY`。语音、应用集成和云沙箱都不是最小部署依赖。
- 修改端口或地址时，同时更新 `RAKAZO_HOST`、`RAKAZO_BIND_ADDRESS`、`RAKAZO_WEB_PORT`、`BETTER_AUTH_URL`、`WEB_ORIGIN`、`API_URL` 中相关值。
- 计算机资源上限由 `RAKAZO_COMPUTER_MEMORY`、`RAKAZO_COMPUTER_CPUS`、`RAKAZO_COMPUTER_PIDS_LIMIT` 控制。

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

`owner` 交互读取邮箱和至少 16 位的密码，密码不回显、不放在命令参数中。它创建普通的已验证账号与个人空间，没有服务器管理权限。未配置邮件时仅在可信内网使用；密码找回需要另行配置邮件。

浏览器打开 `http://SERVER_IP:5173`，使用刚创建的账号登录，连接模型，发送消息并打开智能体计算机，确认浏览器、终端和文件能力可用。Electron 选择 **Existing instance**；移动端使用同一个地址。客户端设备必须能够路由到服务器所在内网。

HTTP 不加密密码、会话或消息，仅适用于可信内网。普通内网 HTTP 不是浏览器安全上下文，麦克风和通行密钥等功能可能不可用；需要这些能力或公网访问时应配置 HTTPS。

## 5. 日常运维与更新

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

## 6. 备份与恢复

先在界面停止所有智能体计算机，再执行：

```bash
bash docs/deploy/deploy.sh backup --computers-stopped
bash docs/deploy/deploy.sh start
```

备份会停止 Web、Worker、API 和 supervisor，PostgreSQL 保持运行；脚本不会替你停止独立的计算机容器。只有确认计算机已停止，文件备份才具备所需的静止条件。成功和失败时应用都保持停止，操作员确认后通过 `start` 恢复服务。

快照位于 `docs/deploy/backups/UTC时间/`，包含 PostgreSQL 自定义格式转储 `postgres.dump`、完整 `appdata.tgz`、原始 `.env` 和 `SHA256SUMS`。脚本以 root 辅助容器读取数据卷，避免遗漏普通 API 用户无法读取的文件，检查转储目录与归档并生成校验和。只有出现成功提示且所有检查通过才算完成；失败的快照不可用于恢复。

备份目录仅当前操作员可读，但**未额外加密，且包含全部运行密钥**。必须加密后异机保存，安排周期备份并演练恢复；数据卷持久化不等于备份。`ENCRYPTION_KEY` 丢失或直接重置会使加密内容和凭据不可恢复。使用外部对象存储时还需要独立备份对应 bucket，本脚本不会复制它。

恢复应在空数据库和空 `appdata` 卷上进行，先校验快照，恢复匹配的 `.env`，准备数据库所需角色，再以数据库所有者运行 `pg_restore`，解压应用数据到 `appdata`，最后运行 `start` 使迁移和应用启动。不要直接向已有实例导入或覆盖数据；跨主机时同步修改监听 IP 和访问 origin。本快照格式不适用于根目录的 `scripts/restore.sh`，也不能直接套用生产备份脚本的文件名。

## HTTPS 与网络受限环境

升级为 HTTPS 时，使用受信任证书和域名，在宿主机的 Caddy/Nginx 上反代到 `127.0.0.1:5173`，将 `RAKAZO_BIND_ADDRESS` 改为 `127.0.0.1`，`RAKAZO_HOST` 改为域名，三个 origin 均改为同一个 `https://` 地址，然后运行 `up`。数据库、API、supervisor 均不需要对外发布。配置示例见 [官方自托管指南](../self-host.md)。

镜像下载失败时先看 [受限网络指南](../self-host-restricted-network.md)。`POSTGRES_IMAGE`、`BUSYBOX_IMAGE` 可指向可信基础镜像仓库；备用官方镜像模式还可设置 `RAKAZO_IMAGE`、`RAKAZO_COMPUTER_IMAGE`。源码构建需要基础镜像、Node.js 包和系统包的网络访问，不能只解决 GHCR 下载就认为能离线构建。Shell 的代理设置不一定被 Docker daemon 或构建步骤使用。源码镜像已经构建好、基础服务镜像也已导入时，可用 `start` 跳过构建和拉取。

## 本地离线测试

在有 Node.js 24 和 Bash 的开发机运行，不需要部署服务器或 Docker。Windows 可使用 Git Bash，通过 `BASH_PATH` 指定非默认位置：

```bash
node --test docs/deploy/deploy.test.mjs
```

测试覆盖配置生成、凭据保护、参数校验、最低 Compose 版本、源码构建顺序、临时构建排除规则、失败保护和备用镜像入口。设置 `COMPOSE_PATH` 为独立 Compose 工具路径时还会验证真实配置合并；实际镜像构建、容器健康、网络隔离、模型连接与恢复流程仍须在目标 Linux 服务器验证。