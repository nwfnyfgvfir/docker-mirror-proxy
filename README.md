# Docker Hub 与 GHCR 镜像加速

用一个 HTTPS 域名加速 Docker Hub 和 GHCR 的公开镜像。可以部署在 Linux VPS，也可以使用 Cloudflare Workers + R2。适合中国大陆的开发、CI 和群晖 NAS。

[拉取镜像](#拉取镜像) · [群晖 NAS](#群晖-nas) · [自建部署](#自建部署) · [打包发布](#打包发布)

## 拉取镜像

在原镜像名前加上代理域名即可。将 `mirror.example.com` 换成实际部署的域名，标签或摘要照原样保留。拉取公开镜像无需登录。

```bash
docker pull mirror.example.com/docker.io/alpine:3.22
docker pull mirror.example.com/ghcr.io/astral-sh/uv:0.12.19
```

Docker Hub 官方镜像支持短名。上例中的 `docker.io/alpine` 也可以写成 `docker.io/library/alpine`。

如果希望继续使用 `docker pull alpine:3.22`，可在 Docker Engine 的现有 `daemon.json` 中合并以下设置，再重启 Docker。此方式适用于 Docker Hub。[Docker Hub 镜像源文档](https://docs.docker.com/docker-hub/image-library/mirror/)

```json
{
  "registry-mirrors": ["https://mirror.example.com"]
}
```

## 群晖 NAS

| 想做什么 | 在 Container Manager 中怎么设置 |
| --- | --- |
| 加速 Docker Hub，继续使用原镜像名 | 打开 **注册表 → 设置 → Docker Hub → 编辑 → 启用注册表镜像**，填写根地址 `https://mirror.example.com` |
| 在项目中使用 Docker Hub 或 GHCR | 打开 **项目 → 新增**，在 Compose 文件的 `image:` 字段填写完整代理镜像名 |

DSM 7.2 起使用 Container Manager。较旧版本可在 Docker 套件中设置 Docker Hub 镜像源。也可以通过 SSH 在 NAS 上执行 `sudo docker pull`，使用上面的完整代理镜像名。[群晖镜像源设置](https://kb.synology.com/en-global/DSM/tutorial/What_websites_does_Synology_NAS_connect_to_when_running_services_or_updating_software) · [群晖项目文档](https://kb.synology.com/en-global/DSM/help/ContainerManager/docker_project)

## 自建部署

| 方式 | 需要准备 | 缓存位置 |
| --- | --- | --- |
| [Linux VPS](#linux-vps) | Docker Compose v2、域名、TLS 证书，以及到两个上游和镜像层下载地址的连接 | VPS 上两个独立的目录 |
| [Cloudflare Workers + R2](#cloudflare-workers--r2) | Cloudflare 账号、可管理的域名和私有 R2 桶 | R2 桶，按镜像源、仓库和摘要区分 |

### Linux VPS

1. 将域名指向 VPS，将证书链和私钥放到同一个目录，分别命名为 `fullchain.pem` 和 `privkey.pem`。
2. 为 Docker Hub 和 GHCR 分别准备 Docker 可写的缓存目录。生产环境可以用独立文件系统或项目配额限制磁盘占用。
3. 首次部署时复制配置样例，编辑 `.env`。

   ```bash
   cp .env.example .env
   ```

   | 变量 | 填写内容 |
   | --- | --- |
   | `MIRROR_DOMAIN` | 代理域名，例如 `mirror.example.com` |
   | `MIRROR_TLS_DIR` | 证书目录的绝对路径 |
   | `DOCKERHUB_CACHE_DIR` | Docker Hub 缓存目录的绝对路径 |
   | `GHCR_CACHE_DIR` | GHCR 缓存目录的绝对路径 |

4. 在仓库根目录运行以下命令。Compose 会构建 NGINX 网关并启动两个缓存实例。

   ```bash
   docker compose config --quiet
   docker compose up -d
   docker compose exec gateway nginx -t
   ```

<details>
<summary>使用 GHCR 上的预构建网关</summary>

在 `.env` 中设置发布的镜像版本。另两个服务继续使用 Compose 中固定版本的 Distribution 镜像。

```dotenv
MIRROR_GATEWAY_IMAGE=ghcr.io/nwfnyfgvfir/docker-mirror-proxy:v0.1.0
MIRROR_GATEWAY_PULL_POLICY=missing
```

将示例版本换成已发布的 tag。私有包需要先在部署服务器上运行 `docker login ghcr.io`，使用有该包读取权限的 GitHub 凭据。之后运行 `docker compose up -d`。[GHCR 登录文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

</details>

<details>
<summary>签发证书和日常维护</summary>

- 可在 VPS 上运行 `certbot certonly --standalone -d mirror.example.com` 申请证书。签发和续期时，公网需要能访问 VPS 的 `80` 端口。续期后复制新证书与私钥到配置目录，再运行 `docker compose exec -T gateway nginx -s reload`。这两个操作也可以放进 Certbot 的 deploy hook。[Certbot 文档](https://eff-certbot.readthedocs.io/en/stable/using.html)
- 两个缓存实例各自清理超过 7 天的内容。用 `df -h` 查看缓存所在文件系统的空间，用 `docker compose logs --tail=100 gateway dockerhub ghcr` 查看请求和回源错误。日志会自动轮转。[Distribution 缓存文档](https://distribution.github.io/distribution/recipes/mirror/)
- 默认每 IP 每秒 10 请求、突发 20、并发 8。全站每秒 100 请求、突发 100、并发 32。每个下载响应限速 2 MiB/s。修改 `.env` 中的限流值后，运行 `docker compose up -d` 生效。

</details>

### Cloudflare Workers + R2

1. 使用 Node.js 22.18 或以上版本。安装依赖、登录 Cloudflare，并创建私有 R2 桶。

   ```bash
   cd worker
   npm ci
   npx wrangler login
   npx wrangler r2 bucket create docker-mirror-cache
   npx wrangler r2 bucket lifecycle add docker-mirror-cache expire-cache "" --expire-days 7
   ```

2. 编辑 `worker/wrangler.jsonc`，将自定义域名和桶名换成自己的值。两条限流规则的 `namespace_id` 在该 Cloudflare 账号内应各自唯一。
3. 在 `worker` 目录运行 `npm run deploy`。

<details>
<summary>缓存和限流</summary>

- Worker 会向上游确认标签对应的摘要。完整镜像层经过 SHA-256 校验后写入 R2，已缓存层支持 `Range` 下载。超过 1 GiB 的镜像层和分段回源请求会直接流式转发。
- 默认每个 Cloudflare 节点每 IP 100 请求/10 秒，节点合计 1,000 请求/10 秒。可以在控制台查看请求量、错误和 R2 用量。[Workers 限流](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- 通过自定义域名从实际要使用的大陆网络或 NAS 拉取一次，确认可达性。[Cloudflare China Network](https://developers.cloudflare.com/china-network/)

</details>

### 可选 · 用自己的 Docker Hub 账号回源

默认两家镜像都匿名回源。部署者可给服务配置自己的 Docker Hub 账号，用该账号的额度拉取公开镜像。访客仍可直接拉取。创建令牌时选择 **Repo Public Read-only** 权限。[Docker Hub 令牌权限](https://docs.docker.com/security/access-tokens/reference/) · [Docker Hub 拉取额度](https://docs.docker.com/docker-hub/usage/pulls/)

- **VPS**。把 `registry/dockerhub.yml` 复制到仓库外的文件。在现有 `proxy` 段中添加 `username` 和 `password`，分别填写 Docker ID 和令牌。设置文件权限为 `0600`，并让 `DOCKERHUB_CONFIG_FILE` 指向该文件。修改或轮换令牌后运行 `docker compose up -d --force-recreate dockerhub`。
- **Cloudflare**。把 `DOCKERHUB_USERNAME` 和 `DOCKERHUB_PAT` 设置为 Workers Secrets。也可以保存在仓库外的 JSON 文件中，并在 `worker` 目录通过 `npx wrangler secret bulk /path/to/hub-secrets.json` 批量设置或轮换。

## 验证

```bash
curl -fsS https://mirror.example.com/v2/
docker pull --platform linux/amd64 mirror.example.com/docker.io/alpine:3.22
docker pull --platform linux/arm64 mirror.example.com/ghcr.io/astral-sh/uv:0.12.19
```

`/v2/` 应返回 `200` 和 `{}`。入口拒绝上传，超过限流返回 `429`。可交换上面的架构参数测试另一种平台，并在干净的客户端按已缓存的摘要重试，验证服务端缓存。

Worker 的本地检查在 `worker` 目录运行 `npm run check`、`npm test` 和 `npm run deploy -- --dry-run`。

## 打包发布

向 GitHub 推送 Git tag 后，[发布工作流](.github/workflows/publish-image.yml) 会为 `linux/amd64` 和 `linux/arm64` 构建并发布 VPS 网关镜像。镜像包含 NGINX 及本项目的路由模板，可以通过 Compose 选用。

```bash
git tag v0.1.0
git push origin v0.1.0
```

构建成功后可在仓库的 **Actions** 和 **Packages** 中查看。上面的 tag 对应 `ghcr.io/nwfnyfgvfir/docker-mirror-proxy:v0.1.0`。
