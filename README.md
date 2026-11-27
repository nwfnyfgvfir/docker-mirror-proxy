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
| [Linux VPS](#linux-vps) | Docker Compose v2、宿主机上的 NGINX，以及到两个上游的连接 | VPS 上两个独立的目录 |
| [Cloudflare Workers + R2](#cloudflare-workers--r2) | Cloudflare 账号、可管理的域名和私有 R2 桶 | R2 桶，按镜像源、仓库和摘要区分 |

### Linux VPS

Compose 运行两个镜像缓存。公网 HTTPS 由宿主机 NGINX 提供，证书沿用你自己的 ACME 流程。

**1. 启动缓存。** 首次部署时将 `.env.example` 复制成 `.env`，填好 `DOCKERHUB_CACHE_DIR` 和 `GHCR_CACHE_DIR`。先在 VPS 上创建这两个目录，再运行以下命令。生产环境可用独立文件系统或项目配额限制磁盘占用。

```bash
docker compose config --quiet
docker compose up -d
```

Docker Hub 绑定 `127.0.0.1:5001`，GHCR 绑定 `127.0.0.1:5002`，都供宿主机 NGINX 使用。从 `v0.1.0` 升级时复用原缓存目录，在同一项目目录执行 `docker compose up -d --remove-orphans`，让旧网关释放 `443`。

**2. 接入 NGINX。** 将仓库的两个 NGINX 配置片段安装到 VPS 上。

```bash
sudo install -D -m 644 nginx/http.conf /etc/nginx/docker-mirror/http.conf
sudo install -D -m 644 nginx/server.conf /etc/nginx/docker-mirror/server.conf
```

在 NGINX 的 `http {}` 中加入这一行。

```nginx
include /etc/nginx/docker-mirror/http.conf;
```

在你现有的 HTTPS `server {}` 中加入这一行。它只处理镜像拉取用的 `/v2/`。

```nginx
include /etc/nginx/docker-mirror/server.conf;
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

<details>
<summary>使用 GHCR 上的预构建缓存镜像</summary>

默认使用官方 Distribution 镜像。也可以在 `.env` 中选用本项目发布的缓存镜像。

```dotenv
MIRROR_CACHE_IMAGE=ghcr.io/nwfnyfgvfir/docker-mirror-proxy:<新版缓存镜像tag>
```

选择 `v0.1.0` 之后发布的缓存镜像 tag。私有包需要先在 VPS 上运行 `docker login ghcr.io`，使用有该包读取权限的 GitHub 凭据。之后运行 `docker compose up -d`。[GHCR 登录文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

</details>

<details>
<summary>缓存和限流</summary>

- 两个缓存实例各自清理超过 7 天的内容。用 `df -h` 查看缓存所在文件系统的空间，用 `docker compose logs --tail=100 dockerhub ghcr` 查看回源日志。[Distribution 缓存文档](https://distribution.github.io/distribution/recipes/mirror/)
- 默认每 IP 每秒 10 请求、突发 20、并发 8。入口总计每秒 100 请求、突发 100、并发 32。每个下载响应限速 2 MiB/s。限流可在宿主机的两个 NGINX 配置片段中调整。

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

向 GitHub 推送 Git tag 后，工作流为 `linux/amd64` 和 `linux/arm64` 构建并发布包含两份 Registry 缓存配置的镜像。[发布工作流](.github/workflows/publish-image.yml)

```bash
git tag v0.1.1
git push origin v0.1.1
```

构建成功后可在仓库的 **Actions** 和 **Packages** 中查看。上面的 tag 对应 `ghcr.io/nwfnyfgvfir/docker-mirror-proxy:v0.1.1`。
