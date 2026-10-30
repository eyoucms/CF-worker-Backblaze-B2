# 通过 Cloudflare Workers 反代 Backblaze B2 私有桶

本项目是一个部署在 [Cloudflare Workers](https://developers.cloudflare.com/workers/) 上的脚本，
用于把**私有**的 [Backblaze B2](https://www.backblaze.com/b2/cloud-storage.html) 存储桶内容，
只经由 Cloudflare 的免费 CDN 对外输出。

这样做的好处是：文件流量全部走 Cloudflare，不会直接打到 Backblaze，
从而避免 B2 流量超出免费额度后产生费用；同时还能利用 Cloudflare 的全球边缘节点加速。

> 适用场景：存放“更新包 / 安装包”等**一旦上传就不会改变**的静态文件。
> 本指南全部操作都在 Cloudflare 网页控制台完成，**不需要在本地安装 Node、Wrangler 等任何环境**。

---

## 一、最终效果（短链接）

配置完成后，你的访问地址将变为：

```
https://你的域名/文件夹名称/文件名称
```

例如桶里有一个对象 `release/v1.2.3/app.zip`，访问地址就是：

```
https://dl.example.com/release/v1.2.3/app.zip
```

不再需要在 URL 里写 `file/` 前缀，也不再需要写存储桶名称。

---

## 二、Backblaze 端设置

### 1. 创建私有存储桶

1. 登录 [Backblaze 控制台](https://secure.backblaze.com/b2_buckets.htm)。
2. 左侧 **B2 Cloud Storage → Buckets**，点击 **Create a Bucket**。
3. 填写桶名（例如 `my-updates`），**Bucket Type 必须选择 `Private`**（私有）。
4. 记录下方该桶对应的 **S3 Endpoint**，格式类似：
   ```
   s3.us-west-001.backblazeb2.com
   ```
   （后面在 Cloudflare 里要用，注意只填 `s3.xxx.backblazeb2.com` 这一段，不要带 `https://` 和桶名。）

### 2. 创建专用应用密钥（只给这个桶、只读）

> 不要把主账号密钥（Master Application Key）直接填到 Worker 里，应创建一个最小权限的密钥。

1. 左侧 **B2 Cloud Storage → Application Keys**，点击 **Add a New Application Key**。
2. 填写名称（例如 `cf-worker-readonly`）。
3. **Allow Access to Bucket(s)** 选择你刚才创建的那个桶。
4. **Type of Access** 选择 `Read Only`。
5. 其它保持默认，点击 **Create New Key**。
6. 会显示 `keyID`（即应用密钥 ID）和 `applicationKey`（应用密钥本身）。
   **applicationKey 只显示这一次，请立即复制保存。**

### 3. 设置 365 天缓存（关键）

因为更新包上传后不会改变，我们让 Cloudflare 缓存整整一年，进一步避免回源。

1. 在 Buckets 列表里，点你桶右侧的 **Bucket Settings**。
2. 找到 **Bucket Info**，填入：

   ```json
   {"Cache-Control":"public, max-age=31536000, immutable"}
   ```

   - `max-age=31536000` 表示 365 天（86400 × 365）。
   - `immutable` 告诉浏览器/中间节点该文件永不变，不要再发校验请求。
3. 点击 **Update Bucket** 保存。

> 说明：即使不在这里设置，Worker 里也有 `CACHE_MAX_AGE` 变量可以强制下发缓存头（见下文）。
> 两者只要有一个生效即可；建议两个都配，双保险。

---

## 三、Cloudflare 端设置（纯网页操作，无需本地环境）

### 1. 选择部署方式

#### 方式一：在仪表盘创建并粘贴代码（适合一次性手动部署）

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)。
2. 左侧 **Workers 和 Pages → 概述**，点击 **创建应用程序 → 创建 Worker**。
3. 给 Worker 起个名字（例如 `b2-proxy`），点击 **部署**（先部署一个默认脚本）。
4. 部署完成后，进入该 Worker，点击 **编辑代码**。
5. 把本项目 `index.js` 的**全部内容**复制粘贴进去，覆盖默认代码，点击 **保存并部署**。

#### 方式二：Git 连接部署（推荐，推送即自动部署）

把本仓库推送到 **GitHub 或 GitLab**，然后在 Cloudflare 控制台连接仓库，后续每次 `git push` 都会自动构建并部署：

1. 将本仓库推送到 GitHub / GitLab（**千万不要把 `B2_APPLICATION_KEY` 等密钥提交进仓库**）。
2. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，左侧 **Workers 和 Pages → 概述**，
   点击 **创建应用程序 → 连接到 Git**。
3. 授权并选择你的仓库与分支，框架预设选 **None / 其它**：
   - 构建命令通常**留空**即可，Cloudflare 会按仓库里的 `wrangler.toml`（已指定 `main = "index.js"`）
     自动打包 `aws4fetch` 等依赖并完成部署；
   - 若平台要求填写部署命令，可填 `wrangler deploy`。
4. 点击 **部署 / Save and Deploy**，首次会自动拉取代码完成部署。

> 说明：采用 Git 部署时，**所有变量都在 Cloudflare 控制台添加**（见第 2 步），
> `wrangler.toml` 中不再写任何变量值，因此不会把敏感信息提交到 Git。

### 2. 配置环境变量和密钥（两种方式通用，均在控制台添加）

进入该 Worker 的 **设置 → 变量和机密**，分别添加：

**(1) 环境变量（明文，可直接填）**

| 变量名 | 示例值 | 说明 |
| --- | --- | --- |
| `BUCKET_NAME` | `my-updates` | **直接写死你的桶名**（不要用 `$path` / `$host`），这样 URL 里就不必再写桶名，实现短链接。 |
| `B2_ENDPOINT` | `s3.us-west-001.backblazeb2.com` | 第二节第 1 步拿到的 S3 Endpoint，**只填域名部分，不要带 `https://`**。 |
| `B2_APPLICATION_KEY_ID` | 你的 `keyID` | 第二节第 2 步创建的密钥 ID。 |
| `CACHE_MAX_AGE` | `31536000` | 边缘缓存秒数，365 天 = `31536000`。设为该值即强制缓存一年。 |

> 添加方式：在“环境变量”区域点击 **添加变量**，逐个添加上面 4 项（修改后记得点 **保存**）。

**(2) 机密（加密，不会明文显示）**

| 变量名 | 值 |
| --- | --- |
| `B2_APPLICATION_KEY` | 第二节第 2 步拿到的 `applicationKey` |

> 添加方式：在“机密”区域点击 **添加机密**，名称填 `B2_APPLICATION_KEY`，值粘贴你的 `applicationKey`，保存。

### 3. 绑定域名（让 Worker 用你自己的域名对外提供服务）

要得到 `https://你的域名/文件夹/文件` 这样的地址，需要把域名指向这个 Worker：

- **方式 A（推荐）：自定义域**
  在该 Worker 的 **触发器 → 自定义域** 中，添加你的一个子域（例如 `dl.example.com`）。
  该子域的 DNS 会自动由 Cloudflare 接管，稍等片刻即可生效。
- **方式 B：路由**
  在 **触发器 → 路由** 中添加路由，例如 `dl.example.com/*`，并选择你的域名 zone。

> 建议用一个**专用的子域**（如 `dl.example.com`）来跑这个 Worker，
> 避免影响主站点的其它流量。你的主域名必须已经托管（DNS）在 Cloudflare 上。

---

## 四、如何使用

假设你的桶 `my-updates` 里上传了对象：

```
release/v1.0/app.zip
release/v1.0/notes.txt
```

配置完成后直接访问：

```
https://dl.example.com/release/v1.0/app.zip
https://dl.example.com/release/v1.0/notes.txt
```

- 支持的请求方法：仅 `GET` / `HEAD`。
- 路径就是“桶内对象路径”去掉桶名后的部分。
- 旧式的 `https://域名/file/桶名/文件夹/文件` 链接依然兼容，不会失效。

---

## 五、缓存说明（365 天）

有两层缓存保障，确保回源次数降到最低：

1. **Backblaze 桶级 `Bucket Info`**（第二节第 3 步）下发
   `Cache-Control: public, max-age=31536000, immutable`。
2. **Worker 的 `CACHE_MAX_AGE` 变量**（第三节第 2 步）强制下发
   `Cache-Control: public, max-age=31536000, immutable`。

只要任一生效，Cloudflare 边缘节点就会把文件缓存一年。由于文件内容不变，
这能在几乎不回源的情况下长期对外提供下载，最大化节省 B2 流量。

> 注意：浏览器端也会按 `max-age` 缓存一年；如果你更新了同名文件，
> 请在 URL 上加版本号或查询参数（例如 `?v=2`）来强制刷新缓存。

**额外优化建议：**
- **错误响应不会被缓存**：Worker 只对成功响应（2xx/206）强制下发缓存头，
  404/403 等错误会沿用 Backblaze 的策略（不缓存），避免“文件缺失被缓存一年”的坑。
- **开启 Tiered Cache（免费）**：在 Cloudflare 控制台 **缓存 → Tiered Cache** 中启用，
  可提升跨数据中心的缓存命中率，进一步节省回源。
- **防收录**：成功响应会附带 `X-Robots-Tag: noindex`，下载链接不会被搜索引擎收录；
  如不需要可删除 `index.js` 中对应一行。

---

## 六、常见问题

- **访问返回 403**：多半是 `B2_APPLICATION_KEY` / `B2_APPLICATION_KEY_ID` 填错，
  或密钥没有该桶的只读权限。请核对第二节的应用密钥。
- **访问返回 404**：检查 `BUCKET_NAME` 是否写成了你的真实桶名；
  以及对象路径是否正确（URL 里不需要再写桶名和 `file/`）。
- **改了文件但下载到的还是旧的**：缓存未过期。改用带版本号的新 URL，
  或等待缓存自然过期（最长一年）。
- **想绑定多个桶**：把 `BUCKET_NAME` 改为 `$path`，
  访问时写成 `https://域名/桶名/文件夹/文件` 即可（此时不是最短链接形式）。
- **需要本地用命令行部署（可选）**：仓库保留了 `wrangler.toml`（其中不含任何变量值）。
  在本地安装 Wrangler 后，先在控制台或用 `wrangler secret put` 配好变量/机密，再执行 `npx wrangler deploy` 即可。
  但本指南主推的“Git 连接部署 / 网页控制台”方式不需要本地环境。

---

## 七、原项目说明（英文）

本项目改编自 Backblaze 官方的
[cloudflare-b2](https://github.com/backblaze-b2-samples/cloudflare-b2) 示例，
原版基于 [worker-signed-s3-template](https://github.com/obezuk/worker-signed-s3-template)。
相比原版，本版本做了以下增强：

- 自动去除 `file/`（及 `file/<桶名>/`）前缀，支持 `域名/文件夹/文件` 短链接，同时兼容旧的 rclone 风格链接；
- 移除了对 `RCLONE_DOWNLOAD` 开关的依赖；
- 新增 `CACHE_MAX_AGE` 变量，可强制下发长达一年的边缘缓存头。
