# 鹏经理系统：阿里云部署与运维

本文的实施对象是李大鹏自己的账号矩阵后台，以及同一系统提供的公开个人主页。公开访客只能看到个人介绍和已批准公开的事实；主账号资料、运营记录、草稿、发布回执和互动工作台通过管理员登录访问。外部平台发布仍在已授权的浏览器会话内完成，平台成功回执再回写后台。

## 使用场景与范围

1. 手机或另一台电脑访问个人域名，登录后台，查看账号、内容、互动与任务执行记录。
2. Codex 在本人已登录的平台网页完成已授权发布或回复，读回真实 URL，再通过后台限定接口记录结果；网页加载或本地文件不代表发布成功。
3. 访客打开个人主页，阅读李大鹏的中英文介绍与已核准公开的信息；不能读取运营数据。

P0 包括域名、HTTPS、受认证的后台、持久数据、发布结果回写、停服备份、更新失败回滚。缺少任一项都会导致无法远程使用、私有数据暴露或运营记录无法恢复。P1 是独立异地备份、账号异常通知与发布后复核，降低单机故障或平台失败的影响。P2 是多用户协作和更高并发；当前只有一位管理员，暂不为此购买数据库、负载均衡或容器集群。

本次不在云端保存社交平台 Cookie，不把验证码或登录保护绕过流程做成后台功能，不在这台小机器执行视频渲染，不启用无人值守批量外发。媒体渲染继续在本机处理；云端保存运营记录与回执。

## 需求与容量假设

| 项目 | 本次目标／假设 |
|---|---|
| 使用者 | 一位管理员，公开主页少量访客 |
| 并发 | 管理操作通常 1–2 个并发请求；没有大流量承诺 |
| 数据量 | 起步运营数据小于 1 GiB；素材与长视频不迁入云主机 |
| 系统 | Ubuntu 24.04 LTS 或 Debian 12、systemd、x64/arm64；推荐 2 GiB 内存以上 |
| 资源 | systemd 内存硬上限 512 MiB、Node old-space 256 MiB；媒体渲染关闭；至少 2 GiB 可用磁盘用于安装 |
| 响应 | 普通页面和本地读写以秒内响应为目标；外部模型和平台耗时独立，不作已实测 SLA 声明 |
| 可用性 | 单机，无高可用承诺；异常由 systemd 重启；更新有停机窗口 |
| 数据保护 | JSON＋SQLite＋媒体回执统一停服备份；不修改历史事件链 |
| 安全 | HTTPS、仅回环监听、Host 白名单、管理员登录、受限 Agent 令牌、凭据不入包 |

这属于单用户低流量部署。公开互联网压测、真实服务器负载、跨地域网络质量与灾难恢复耗时必须在资源就绪后实测，不能用本地打包测试代替。

## 两个候选方案与选择

首先检查现有机器、已有域名、可用空间、内存、端口和备案状态。若已有合适的阿里云机器与域名，独立安装本服务的新增固定费用可以为零；这不等于既有机器本身免费。不得为追求复用停止已有服务或覆盖已有站点。

| 方案 | 配置、公开报价与成本 | 优点 | 代价与适用前提 |
|---|---|---|---|
| 大陆 ECS＋`.cn` | 经济型 e：2 核 2 GiB、40 GiB ESSD Entry、3 Mbps 固定带宽不限流量，99 元／年；`.cn` 普通词首年 38、续费 42 元。算术预算首年 **137 元**，之后 **141 元／年** | 续费成本明确；同机持久磁盘直接运行 Node 和 SQLite，改造少 | 要核实账号活动名额与域名可注册性，并先完成适用备案；3 Mbps 不适合云端传输大视频 |
| 香港轻量通用型＋域名 | 通用型可选 2 核 2 GiB、40 GiB、1 IPv4、最高 200 Mbps。购买和续费金额须在本人账号的购买页核实，不能把“低至 68 元／年”广告自动算成香港现价 | 无需 ICP，资源就绪后可较快解析上线；不用迁移 SQLite | 跨境访问可能波动；不能承诺新客价可用或次年同价；避免面向大陆用户选择“国际型”非中国优化线路 |

当前实施优先复用已核验的海外 ECS，新增机器固定费用为零，原机器和流量仍按原账单计费；购买域名只付实际结算价格。没有可复用资源时，大陆 ECS 99 元方案适合可等待备案的场景，需要立即开放时再按海外机器购买页实价决策。以上不包含可选付费快照、付费域名词、外部模型调用或额外存储。

价格于 **2026-10-24** 从原文核验：

- [阿里云 99 计划官网](https://www.aliyun.com/activity/ecs/99program)：新老同享，99 元／年，续费同价锁至 2029-03-31；活动资格和原配置须保持。不是所有 ECS 都是此价格。
- [万网域名注册首页](https://wanwang.aliyun.com/domain/)：`.cn` 注册 38、续费 42 元；`.com` 注册 85、续费 95 元；`.cc` 注册 32、续费 80 元。域名普通词和实际结算价格优先；已有域名可直接使用子域名。RDAP 无注册对象只表示当前注册局未找到对象，不保证可购买，最终以注册商实际结算为准。
- [`.com` 35 元活动规则](https://wanwang.aliyun.com/newactivity/com)：要求同前缀 `.cn/.co` 已注册超过七天等条件，未核资格不套用。
- [轻量计费](https://help.aliyun.com/zh/simple-application-server/product-overview/overview)与[在售规格](https://help.aliyun.com/zh/simple-application-server/product-overview/instance-families/)：实际价格以购买页为准；国际型非中国优化线路不适合面向大陆用户提供服务。
- [备案服务码 FAQ](https://help.aliyun.com/zh/icp-filing/basic-icp-service/support/server-check-faq)：内地网站须 ICP；香港及其他海外实例无需 ICP。符合时长、带宽等要求的年包资源可以检查免费服务码。其他适用备案按主体和网站实际情况办理。

函数计算不是这次的最低改造成本方案：[FC 本地盘随容器回收而消失](https://help.aliyun.com/zh/functioncompute/selection-of-function-storage)，需要另配持久化；SQLite WAL 还有[同机与文件系统限制](https://sqlite.org/wal.html)。轻量容器服务[不支持持久数据卷](https://help.aliyun.com/zh/simple-application-server/user-guide/overview-of-simple-container-service/)，不用于保存当前业务数据库。

## 部署结构与数据

```text
浏览器 → 域名 HTTPS 443 → 既有 nginx／独立 Caddy → 127.0.0.1:4318 → Node 单进程
                                           ├─ 公开主页／公开资料
                                           ├─ 管理员认证／私有 API
                                           └─ JSON 与 SQLite 持久数据
```

| 路径 | 内容、权限与生命周期 |
|---|---|
| `/opt/pengmanager-system/releases/<git-sha>/` | 一个完整源代码与锁定依赖版本，root 拥有；服务不可修改源码 |
| `/opt/pengmanager-system/current` | 原子切换的当前 release 软链；上一代目录保留 |
| `/opt/pengmanager-system/runtimes/` | 独立 Node 官方运行时，不覆盖宿主 `/usr/bin/node` |
| `/opt/pengmanager-system/node-current` | 私有 Node 运行时链接 |
| `/opt/pengmanager-system/tooling/` | 按 `packageManager` 锁定的独立 pnpm |
| `/var/lib/pengmanager-system/` | 专用 `pengmanager-system` 用户所有、0700；完整运行数据 |
| `…/state.json` | 账号、事实、内容、互动、操作任务、回执及事件账本；保留原事件链 |
| `…/geo-engine/personal-geo.sqlite` | GEO 查询、样本、引用和指标；SQLite 数据文件及附属文件一起备份 |
| `…/media/jobs/` | 已有媒体回执；云端禁用新的重型渲染 |
| `<release>/var` | 指向持久数据目录，保障仍使用仓库相对 `var/` 的内部路径 |
| `/etc/pengmanager-system/runtime.env` | root 所有、0600；systemd 读取；仅存密码／Agent 令牌哈希，不存管理员明文密码 |
| `/etc/pengmanager-system/proxy.json` | root 所有、0600；保存代理类型、域名及证书路径，update 自动复用，不保存 ACME 邮箱或账户私钥 |
| `/etc/nginx/sites-available/pengmanager-system.conf` | nginx 模式下只属于本产品的虚拟站点；sites-enabled 只增加同名软链 |
| `/var/lib/pengmanager-system-acme/` | nginx 模式的独立公开 ACME 挑战目录；不包含业务数据 |
| `/etc/letsencrypt/renewal-hooks/deploy/pengmanager-system-nginx.sh` | nginx 模式的续期后 reload 钩子，只响应本产品证书 lineage |
| `/etc/caddy/pengmanager-sites/pengmanager-system.caddy` | Caddy 模式下只属于本产品的域名反向代理配置 |
| `/var/backups/pengmanager-system/` | 0700；停服完整备份＋配置哈希＋release 元数据，归档和校验文件均 0600 |

不增加新业务表或索引；沿用当前 JSON 领域状态及 GEO SQLite 模型。部署 manifest 是发布元数据，不是业务数据库。备份包含完整私有数据，必须存放在受保护位置；建议定期另存到本人加密离线备份，单台机器上的备份无法防止整机丢失。

## HTTP 边界

| 请求 | 用途与访问要求 |
|---|---|
| `GET /` | 公开个人主页，不读取私有运营列表 |
| `GET /public-api/profile` | 只导出当前公开身份和已批准、未过期、非敏感的事实 |
| `GET /healthz` | 不含运营统计的存活检查：`ok`、`service` |
| `GET /login`、`POST /api/auth/login` | 管理员登录；密码由请求体发送，绝不放进 URL |
| `GET /admin` | 管理后台，要求有效登录 Cookie |
| `GET /api/bootstrap` 等私有读取 | 未登录必须返回 401，不能通过公开主页取得 |
| `POST /api/publications/manual` | 已发布内容的真实／导入回执；不发出平台帖子 |
| `POST /api/interactions` | 保存已授权互动记录；高风险内容保留人工处理 |
| `/api/operations/:id/start`、`complete`、`fail` | 浏览器任务状态与完成回执，受认证和有限 Agent 权限约束 |

业务请求／返回字段与错误码以 [API.md](API.md) 和源码为准。生产验证至少覆盖：未认证私有接口 401；不允许的 Host／Origin 403；格式错误 400；登录限速 429；关闭的媒体运行返回相应不可用错误；不存在接口 404。Agent 令牌只用于允许的任务／回执接口，不能代替管理员审批全部业务。

## 构建部署包：本机，不上传私有数据

先完成仓库要求的测试与安全扫描，再提交代码，构建干净 release：

```bash
node scripts/package-deployment.mjs --dry-run
node scripts/package-deployment.mjs --out-dir /absolute/protected/packages
```

也可执行 `bash deploy/aliyun/build.sh --out-dir /absolute/protected/packages`。脚本从当前 Git checkout 的跟踪文件和未被忽略的新文件打包，因此开发中可测试新文件；manifest 会明确 `dirty`。正式安装默认拒绝 dirty 包；`--allow-dirty` 仅用于已审查的临时验证。每次修改后需重新构建，不能拿旧包声称包含新代码。

包排除 `.git`、`var`、`.env*`、`.npmrc`、`node_modules`、`outputs`、`work`、私钥／证书秘密文件和 Python 缓存。所有入包文件执行凭据模式扫描；发现疑似凭据仅报告文件名，不打印值。包内部 `deployment-manifest.json` 包含 Git SHA、dirty 标志、每文件 SHA-256 与总体内容摘要；外部提供归档 SHA-256 和 manifest。归档与侧文件为 0600。该包没有本机运营数据、平台 Cookie、明文管理员密码、GitHub PAT 或模型密钥。

源代码无需前端编译。服务器从锁文件安装依赖并做 Node／SQLite／tsx 导入检查。必须保留现有 devDependencies：当前运行链使用其中的 `tsx`、`yaml`、`zod`；不能加 `--prod` 剪掉它们。

## 服务器预检与首次安装

本节只适用于已经由本人登录、确认费用并取得的 Ubuntu／Debian 机器。阿里云控制台的本人短信、人脸、实名认证和付款必须由本人完成；脚本不试图替代这些验证。新购服务器优先选择上述 Linux 系统，避免临时改造 Alibaba Cloud Linux。

将已校验部署包和脚本通过受信任的传输方式放到服务器受保护目录；不要把 SSH 密码或私钥放进仓库。安全组与主机防火墙只放开网站所需 80／443；22 仅限本人管理来源，4318 不向公网放行。发现已有 nginx 监听 80／443 时，选择下面的 nginx 模式，复用它并保留已有网站；未选择相应代理模式则预检拒绝端口冲突。

首次预检为只读：

```bash
bash deploy/aliyun/preflight.sh --domain admin.example.cn --dry-run
```

它检查 Linux／发行版／systemd、内存、磁盘、依赖、4318和80／443占用、所选代理的配置方式与托管路径。预检缺少工具时，先按清单安装基础工具；Ubuntu／Debian 常用准备如下，保持既有系统配置：

```bash
sudo apt-get update
sudo apt-get install --yes python3 curl ca-certificates tar xz-utils iproute2 util-linux gnupg debian-keyring debian-archive-keyring apt-transport-https
```

管理员密码至少12个字符。先在受保护路径生成配置，只从标准输入传入秘密，输出不含秘密和哈希值：

```bash
systemd-ask-password 'PengManager administrator password' | node deploy/aliyun/configure.mjs --domain admin.example.cn --output /absolute/protected/runtime.env
```

若在 Mac 生成配置，用密码管理器的秘密输出功能或隐藏输入工具接入同一 stdin；不要用含密码字面量的 `echo`、命令行参数或 shell 历史。生成的配置是0600，含 scrypt 哈希；传输后服务器也须保持0600。脚本拒绝覆写已有配置。密码本人保管，Codex不把明文写入聊天、事件或发布回执。

使用构建回执中的真实绝对路径及64位SHA-256替换占位符；以下参数都不包含秘密：

```bash
sudo bash deploy/aliyun/install.sh --dry-run --package /protected/pengmanager.tar.gz --sha256 ARCHIVE_SHA256 --domain admin.example.cn --env-file /protected/runtime.env
sudo bash deploy/aliyun/install.sh --package /protected/pengmanager.tar.gz --sha256 ARCHIVE_SHA256 --domain admin.example.cn --env-file /protected/runtime.env
```

首次安装必须提供独立暂存 `--env-file`；最终配置由安装器写入 `/etc/pengmanager-system/runtime.env`，不可把源码目录当配置目录。安装过程先验证归档SHA、每个文件与路径，拒绝 tar 目录逃逸、软／硬链接和额外文件；再创建专用不可登录用户、下载独立 Node、安装锁定依赖、写入本服务 unit 与所选代理的独立site，最后切换 current 并执行本机健康检查。首次激活失败会撤销本次 current 软链，保留release、数据、配置和已签证书，再次安装同包可重试。

### 复用已有 nginx：当前服务器采用此模式

适用于标准 Ubuntu／Debian `/usr/sbin/nginx`、`nginx.service`、`/etc/nginx/nginx.conf`，且其 `http` 块已包含 `/etc/nginx/sites-enabled/*`。不会安装或启动 Caddy，不停止或重启 nginx，不改 `nginx.conf`、`default`、其他站点或其他证书。服务启动和证书切换都只调用通过 `nginx -t` 的 graceful reload。[nginx 官方参数说明](https://nginx.org/en/docs/switches.html)描述了 `-t`、`-T` 与 reload 的行为。

先选未被旧站点使用的子域名，例如 `pengmanager.example.com`。已有根域名的路由与证书不等于包含子域名：新证书必须匹配精确主机名且未过期。预检读取 `nginx -T` 的内存输出，递归追踪实际生效的 include，检查精确域名、前置／后置通配和 `.example.com` 名称冲突；遇到 PCRE 正则或动态 `server_name` 一律先拒绝，避免用不兼容的正则解释器猜测无冲突。[nginx server_name 规则](https://nginx.org/en/docs/http/server_names.html)是判定依据。完整原配置、私钥和 ACME 账户 JSON 不写入日志或回执。

```bash
sudo bash deploy/aliyun/preflight.sh --proxy nginx --domain pengmanager.example.com --dry-run
```

若已有可用证书，显式提供路径；安装会通过 `openssl x509 -checkhost`、`-checkend 86400` 检查主机名和至少一天的剩余有效期。主机名检查严格比对成功输出，不能只相信 OpenSSL 的退出码；`nginx -t` 继续核验配置与证书／私钥能否加载。脚本不解析或打印私钥内容；证书路径可使用 Certbot 标准 live 软链，但本产品配置目录与站点路径不得有软链祖先。

```bash
sudo bash deploy/aliyun/install.sh --proxy nginx --package /protected/pengmanager.tar.gz --sha256 ARCHIVE_SHA256 --domain pengmanager.example.com --env-file /protected/runtime.env --tls-cert /etc/letsencrypt/live/pengmanager.example.com/fullchain.pem --tls-key /etc/letsencrypt/live/pengmanager.example.com/privkey.pem
```

没有证书时，先显式安装发行版 `certbot`（已有则复用）；不执行 `certbot --nginx` 自动改配置，也不用占用 80 端口的 standalone 模式。脚本先创建只暴露 `/.well-known/acme-challenge/` 的独立 HTTP 站点，其余路径返回503，再走 `certbot certonly --webroot`；签发成功且应用健康后启用独立443代理，80保留挑战目录并跳转HTTPS。[Certbot 官方 webroot 文档](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot)说明此方式使用正在运行的 Web 服务。

若已有本人认可、可复用的 ACME 账户，只通过目录元数据取得32位账户标识，不读取 `private_key.json`／`regr.json` 内容；安装命令显式传入 `--acme-account`，不会加入 `--agree-tos`：

```bash
sudo bash deploy/aliyun/install.sh --proxy nginx --package /protected/pengmanager.tar.gz --sha256 ARCHIVE_SHA256 --domain pengmanager.example.com --env-file /protected/runtime.env --acme-account ACCOUNT_ID_32_HEX
```

只有新注册 ACME 账户需要本人在行动时明确接受条款并选择联系邮箱。脚本默认拒绝此类注册，必须增加 `--accept-acme-terms --acme-email YOUR_CONTACT_EMAIL`；本人明确选择无邮箱时改为 `--accept-acme-terms --acme-no-email`。开关表示操作者本次已作选择，研究、预检与 dry-run 不构成接受条款。邮箱与账户标识不写入 `proxy.json` 或部署回执，Certbot 自身的受保护账户目录由它管理。

nginx 模式证书默认独立存放在 `/etc/letsencrypt/live/pengmanager-system-<domain>/`。只增加本服务专属的续期 deploy hook；它核对 `RENEWED_LINEAGE` 后才执行 `nginx -t` 和 `systemctl reload nginx.service`，其他证书续期不会触发它。不改原有 `certbot.timer`、账户、旧域名续期文件或私钥；证书签发后也不会因应用回滚而删除证书或账户。托管证书已到期或即将在一天内到期时，安装／更新先通过已有 lineage 补签并复核；外部提供的证书无效时直接拒绝。后续 `update.sh` 自动读取 `proxy.json`，无需重复选择代理和证书路径。更改域名、代理类型或外部证书路径属于单独迁移，不能混入普通更新。

### 独立 Caddy 模式与共用运行时

Node 固定版本与 Linux x64／arm64 的校验值在 [`runtime.json`](../deploy/aliyun/runtime.json)，来源为[官方 Node v24.22.1 校验表](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt)。安装会同时比较提交的 pin、官方校验表、下载文件三者，不运行 `curl | sh`。pnpm 版本由 `package.json` 精确锁定；通过私有 prefix 安装，依赖安装使用 `--frozen-lockfile --ignore-scripts --prod=false`，不更改宿主 Node／pnpm。

Caddy 通过[官方 stable 软件源](https://caddyserver.com/docs/install)安装。已有 Caddy 必须使用标准 `caddy.service` 和 `/etc/caddy/Caddyfile`；配置仅增加独立绝对路径 import，保留原文件和其他站点，先 `caddy validate` 后 reload。发现同域名或覆盖该域名的通配符已有路由会拒绝变更；API／自定义配置的 Caddy 需单独审查接入，不能强行覆盖。

域名A记录指向机器公网IPv4；仅在IPv6路由真实可达时配置AAAA。根据[官方 Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)，域名和80／443可达后自动申请并续期证书；[Let's Encrypt](https://letsencrypt.org/about/)证书本身免费。不购买付费证书，也不把阿里云的[个人测试证书](https://help.aliyun.com/zh/ssl-certificate/functions-and-features)用于生产。

## 验收与数据迁移

安装器本机检查只证明进程就绪及私有 API 需要认证，回执明确 `publicHttpsVerified=false`。只有完成以下真实检查才能报网站上线：

1. 外部网络用真实域名访问 HTTPS，无证书警告；HTTP跳到HTTPS。
2. 公开主页包含中英文个人资料，公开接口没有私有事实／草稿／运营统计。
3. 未登录访问后台 API 返回401；登录后可用，退出后失效；错误密码及限速正确。
4. 桌面1440px与手机390px检查主页、登录页、后台，不溢出且无控制台错误。
5. 记录一条测试操作的前后事件变化；真实发布须另外有真实平台回执，不能用测试操作冒充。
6. 重启本服务后数据和事件链仍有效，重新登录后可读；SQLite历史仍在。
7. 完成一次停服备份及在独立目标目录的恢复验证；保留当前线上数据。

迁移本机已有运营数据时，先停本机进程，保护性复制整个 `var/`，包括SQLite附属文件和媒体回执；通过受保护通道迁入新机完整持久目录，恢复所有权。不得用种子数据覆盖真实状态，不把当前私有 `var/` 混入代码包。若本机仍需运营，停止迁移期间写入，最终只保留一个可写主实例，避免两份状态分叉。

## 更新、备份与恢复

更新不重新填写密码，不覆盖 runtime.env 或既有代理选择。上传新归档、核对独立SHA回执后：

```bash
sudo bash deploy/aliyun/update.sh --dry-run --package /protected/new-release.tar.gz --sha256 ARCHIVE_SHA256
sudo bash deploy/aliyun/update.sh --package /protected/new-release.tar.gz --sha256 ARCHIVE_SHA256
```

新依赖先在独立临时release准备；失败不切换。激活前停本服务并备份完整持久数据；成功后切换current、启动并检查。启动或认证检查失败时恢复旧release、私有Node链接、unit和更新前数据；失败后的数据另外保留在 `*.before-restore-*` 或 `*.failed-restore-*` 目录，不删除历史数据。安装／更新／备份／线上恢复使用同一排他锁，已有操作运行时立即拒绝另一变更，不并行修改。发布归档、前一release和备份均保留；磁盘清理由之后明确的保留策略处理。

手动备份是有短暂停机的完整快照，不从运行中的SQLite单独复制主文件：

```bash
sudo bash deploy/aliyun/backup.sh --destination /var/backups/pengmanager-system --dry-run
sudo bash deploy/aliyun/backup.sh --destination /var/backups/pengmanager-system
```

成功后按原状态恢复服务；`--leave-stopped` 供受控迁移使用。归档包括数据、runtime.env中的凭据哈希、存在时的proxy.json与release元数据，文件均0600；默认不输出任何配置值。代理元数据用于整机恢复时重建相同路由，线上 `--restore-config` 仍只恢复 runtime.env，保留当前路由。备份失败也恢复此前运行状态。

恢复必须指定目标与SHA；先恢复到独立目录核验，不覆盖线上：

```bash
sudo bash deploy/aliyun/restore.sh --dry-run --archive /protected/backup.tar.gz --sha256 BACKUP_SHA256 --target /var/lib/pengmanager-system-restore-check
sudo bash deploy/aliyun/restore.sh --archive /protected/backup.tar.gz --sha256 BACKUP_SHA256 --target /var/lib/pengmanager-system-restore-check
```

确需切回真实线上数据时，显式以 `/var/lib/pengmanager-system` 为目标。恢复目标使用 `pengmanager-` 命名空间，并拒绝系统配置、代码和设备目录。当前目录先改名保存，恢复失败回到原目录；仅 `--restore-config` 才同时恢复旧密码／令牌哈希等配置，默认保留现有配置。备份中的域名必须与当前域名一致；更换域名另做显式迁移，不能恢复一份旧配置导致与代理路由冲突。恢复不会替换代码版本；数据与代码版本不兼容时，先选相应release再恢复。

## 失败路径与可见结果

| 情形 | 处理 |
|---|---|
| 购买资格、实名、付款或备案未完成 | 不承诺资源已取得；把具体订单／核验步骤留给本人最终操作，其余准备继续完成 |
| 未选代理的其他服务占端口或同域名路由 | preflight／代理检查拒绝，保留原服务；重新选域名或经过审查接入现有代理 |
| 包／Node校验不符或路径逃逸 | 解包／切换前终止，不执行包内脚本 |
| Node下载、npm／pnpm或锁文件失败 | 丢弃未激活临时release；旧进程和数据不受新依赖影响 |
| runtime.env错误、没有密码哈希或错误Origin | 拒绝部署／启动，不能退回无认证公网模式 |
| Caddy验证或reload失败 | 恢复先前Caddyfile与本产品site；不覆盖其他站点 |
| nginx配置、证书签发或reload失败 | 仅恢复本产品site、启用软链和续期钩子；旧nginx.conf、default、其他证书保持原样 |
| 新ACME账户缺少行动时显式条款选择 | 写入挑战站点前拒绝，不隐式接受条款；已有账户可显式指定复用 |
| 更新启动失败或私有API未要求登录 | 停止候选服务，恢复旧代码和数据，再启动原服务 |
| 备份空间不足或包含异常链接 | 保留现有数据，失败返回，恢复原运行状态；不继续切换 |
| 恢复校验失败或服务不健康 | 保留两代数据并回到原目标；输出失败，不报成功 |
| DNS／证书尚未生效 | 本机健康不当公网成功；核对解析、80／443和代理／Certbot证书日志后继续外部验收 |

日志可以通过 `journalctl -u pengmanager-system.service` 与所选代理的 `nginx.service`／`caddy.service` 查看。不要把含个人数据、请求体、Cookie、令牌或配置值的日志贴进公开报告。

## 本地验证与证据边界

```bash
node --check scripts/package-deployment.mjs
node --check deploy/aliyun/configure.mjs
bash -n deploy/aliyun/build.sh deploy/aliyun/preflight.sh deploy/aliyun/install.sh deploy/aliyun/update.sh deploy/aliyun/backup.sh deploy/aliyun/restore.sh
python3 -B deploy/aliyun/test_deployment.py
node scripts/package-deployment.mjs --dry-run
```

部署测试覆盖真实归档构建／校验、哈希不符、目录逃逸、链接／重复／未列出文件、Host与环境校验、权限、stdin密码不泄漏、只读dry-run、独立目标恢复及旧数据保留；nginx专项覆盖include上下文与路径分段、精确／通配／正则冲突、专属site/link/hook恢复、协议条款门禁、已有账户复用、到期托管证书补签、外部无效证书拒绝、代理选择持久化、更新reload失败回滚及首次失败后重试。它们不调用云端、不创建系统用户、不修改宿主systemd或代理；nginx／certbot外部进程在portable用例中模拟。OpenSSL3另有在系统临时目录生成短期自签证书的真实主机名匹配／不匹配回归；LibreSSL环境明确跳过这一个用例，不能冒充已通过。可通过 `OPENSSL_BINARY` 指定OpenSSL3绝对路径。真实安装、systemd隔离、官方软件下载、TLS签发、服务器重启和云端恢复验证，须等服务器可访问后再执行并记录；未执行时必须写“未验证”，不能把portable测试算作已上线。
