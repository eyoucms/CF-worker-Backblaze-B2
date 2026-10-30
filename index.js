//
// 通过 Cloudflare Workers 反代（代理）一个私有的 Backblaze B2（S3 兼容）存储桶，
// 使存储桶内容只经由 Cloudflare 的免费 CDN 对外输出，避免 B2 流量超额产生费用。
//
// 适配自 https://github.com/obezuk/worker-signed-s3-template
//
import { AwsClient } from 'aws4fetch'

const UNSIGNABLE_HEADERS = [
    // 这些请求头会出现在请求中，但永远不会被转发到上游
    'x-forwarded-proto',
    'x-real-ip',
    // 不能把 accept-encoding 纳入签名，因为 Cloudflare 会把入站的 accept-encoding
    // 设为 "gzip, br"，再修改发出的请求，将其设为 "gzip"。这点不太友好！
    'accept-encoding',
    // 条件请求头不一定会被稳定转发到上游
    'if-match',
    'if-modified-since',
    'if-none-match',
    'if-range',
    'if-unmodified-since',
];

// URL 的协议需要带冒号后缀，端口以字符串形式提供
const HTTPS_PROTOCOL = "https:";
const HTTPS_PORT = "443";

// 当 range 请求返回的响应缺少 content-range 头时，重试次数
const RANGE_RETRY_ATTEMPTS = 3;

// 过滤掉 cf-* 以及其它我们不希望纳入签名的请求头
function filterHeaders(headers, env) {
    // 屏蔽无关的 IntelliJ 警告
    // noinspection JSCheckFunctionSignatures
    return new Headers(Array.from(headers.entries())
        .filter(pair => !(
            UNSIGNABLE_HEADERS.includes(pair[0])
            || pair[0].startsWith('cf-')
            || ('ALLOWED_HEADERS' in env && !env['ALLOWED_HEADERS'].includes(pair[0]))
        ))
    );
}

function createHeadResponse(response) {
    return new Response(null, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText
    });
}

// 可选地强制在响应上设置 Cache-Control 头，让 Cloudflare 边缘节点按配置的秒数缓存对象。
// 设置 CACHE_MAX_AGE（单位：秒），例如 31536000 表示缓存一年（365 天）。
//
// 注意：只对成功响应（2xx / 206）强制缓存。若不判断状态码，404/403 等错误也会被
// 缓存一年，导致文件暂时缺失或拼写错误后长期无法恢复。
function applyCacheControl(response, env) {
    const maxAge = env['CACHE_MAX_AGE'];
    if (maxAge === undefined || maxAge === null || String(maxAge).trim() === '') {
        return response;
    }
    // 只对成功响应强制缓存，错误响应原样返回（沿用源站的 no-cache 等策略）
    if (response.status >= 400) {
        return response;
    }
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Cache-Control', `public, max-age=${String(maxAge).trim()}, immutable, stale-while-revalidate=86400`);
    // 防止下载链接被搜索引擎收录
    newHeaders.set('X-Robots-Tag', 'noindex');
    return new Response(response.body, {
        headers: newHeaders,
        status: response.status,
        statusText: response.statusText
    });
}

function isListBucketRequest(env, path) {
    const pathSegments = path.split('/');

    return (env['BUCKET_NAME'] === "$path" && pathSegments.length < 2) // https://endpoint/bucket-name/
        || (env['BUCKET_NAME'] !== "$path" && path.length === 0); // https://bucket-name.endpoint/ 或 https://endpoint/
}

// 屏蔽 IntelliJ 的 "unused default export" 警告
// noinspection JSUnusedGlobalSymbols
export default {
    async fetch(request, env) {
        // 只允许 GET 和 HEAD 方法
        if (!['GET', 'HEAD'].includes(request.method)){
            return new Response(null, {
                status: 405,
                statusText: "Method Not Allowed"
            });
        }

        const url = new URL(request.url);

        // 入站协议和端口取自 Worker 的运行环境。本地开发模式使用 8787 端口的明文 http，
        // 也有可能把 Worker 部署到明文 http 上。而 B2 只支持 443 端口的 https。
        url.protocol = HTTPS_PROTOCOL;
        url.port = HTTPS_PORT;

        // 去掉路径开头的斜杠
        let path = url.pathname.replace(/^\//, '');
        // 去掉路径末尾的斜杠
        path = path.replace(/\/$/, '');

        // 去掉可选的 "file/"（或 "file/<bucket>/"）前缀，这样像 /文件夹/文件 这样的
        // 短链接可以正常工作，同时 rclone 风格的 /file/<bucket>/文件夹/文件 链接也继续可用。
        //
        // - 使用固定的 BUCKET_NAME（推荐）时，桶名来自配置，因此会去掉开头的 "file/<bucket>/" 段。
        // - 使用 BUCKET_NAME="$path" 时，桶名保留在路径中，因此只去掉开头的 "file/"。
        if (path.startsWith('file/')) {
            if (env['BUCKET_NAME'] === '$path') {
                path = path.replace(/^file\//, '');
            } else {
                path = path.replace(/^file\/[^/]+\//, '');
            }
        }

        // 重建上游请求路径
        url.pathname = '/' + path;

        // 除非配置允许，否则拒绝列出存储桶的请求
        if (isListBucketRequest(env, path) && String(env['ALLOW_LIST_BUCKET']) !== "true") {
            return new Response(null, {
                status: 404,
                statusText: "Not Found"
            });
        }

        // 设置上游目标主机名。
        switch (env['BUCKET_NAME']) {
            case "$path":
                // 桶名是 URL 路径的第一段
                url.hostname = env['B2_ENDPOINT'];
                break;
            case "$host":
                // 桶名是入站主机名的第一个子域
                url.hostname = url.hostname.split('.')[0] + '.' + env['B2_ENDPOINT'];
                break;
            default:
                // 桶名由 BUCKET_NAME 变量指定（推荐：直接写死你的桶名，实现短链接）
                url.hostname = env['BUCKET_NAME'] + "." + env['B2_ENDPOINT'];
                break;
        }

        // 某些请求头（如 x-real-ip）会出现在入站请求中，却会从出站请求里被移除。
        // 如果它们出现在已签名的出站请求头中，B2 将无法校验签名。
        const headers = filterHeaders(request.headers, env);

        // 创建一个能为出站请求签名的 S3 API 客户端
        const client = new AwsClient({
            "accessKeyId": env['B2_APPLICATION_KEY_ID'],
            "secretAccessKey": env['B2_APPLICATION_KEY'],
            "service": "s3",
        });

        // 保存请求方法，以便对 HEAD 请求做恰当的处理
        const requestMethod = request.method;

        // 对出站请求签名
        //
        // 对于 HEAD 请求，Cloudflare 似乎会把出站请求的方法改成 GET（#18），这会破坏签名，
        // 导致 403。因此，把所有 HEAD 都改成 GET。这并不会太影响效率，因为若原始请求是 HEAD，
        // 我们并不会读取响应的正文。
        const signedRequest = await client.sign(url.toString(), {
            method: 'GET',
            headers: headers
        });

        // 对于大文件，Cloudflare 会返回整个文件，而不是所请求的 range 区间。
        // 因此，如果请求带有 range 头，就检查响应是否包含 content-range 头。
        // 若没有，则中止该请求并重试。
        // 参见 https://community.cloudflare.com/t/cloudflare-worker-fetch-ignores-byte-request-range-on-initial-request/395047/4
        if (signedRequest.headers.has("range")) {
            let attempts = RANGE_RETRY_ATTEMPTS;
            let response;
            do {
                let controller = new AbortController();
                response = await fetch(signedRequest.url, {
                    method: signedRequest.method,
                    headers: signedRequest.headers,
                    signal: controller.signal,
                });
                if (response.headers.has("content-range")) {
                    // 只有第一次没成功时才记录日志
                    if (attempts < RANGE_RETRY_ATTEMPTS) {
                        console.log(`Retry for ${signedRequest.url} succeeded - response has content-range header`);
                    }
                    // 跳出循环并返回响应
                    break;
                } else if (response.ok) {
                    attempts -= 1;
                    console.error(`Range header in request for ${signedRequest.url} but no content-range header in response. Will retry ${attempts} more times`);
                    // 最后一次尝试时不要中止，因为我们想返回该响应
                    if (attempts > 0) {
                        controller.abort();
                    }
                } else {
                    // 响应异常，不再重试
                    break;
                }
            } while (attempts > 0);

            if (attempts <= 0) {
                console.error(`Tried range request for ${signedRequest.url} ${RANGE_RETRY_ATTEMPTS} times, but no content-range in response.`);
            }

            if (requestMethod === 'HEAD') {
                // 原始请求是 HEAD，因此返回一个不带正文的响应
                return createHeadResponse(applyCacheControl(response, env));
            }

            // 返回我们拿到的响应，而不是错误响应
            // 这个响应不能被中止，否则会抛出异常
            return applyCacheControl(response, env);
        }

        // 把签名后的请求发往 B2
        const fetchPromise = fetch(signedRequest);

        if (requestMethod === 'HEAD') {
            const response = await fetchPromise;
            // 原始请求是 HEAD，因此返回一个不带正文的响应
            return createHeadResponse(applyCacheControl(response, env));
        }

        // 返回上游响应（可选附带强制设置的 Cache-Control 头）
        return applyCacheControl(await fetchPromise, env);
    },
};
