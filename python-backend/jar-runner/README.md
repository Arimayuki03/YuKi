# spider-runner.jar — TVBox csp_*.jar PC 端 JVM 宿主

## 用途

在 PC 上运行 TVBox 生态的 Java 爬虫 jar（`csp_*.jar`），通过 JVM 子进程 + JSON-RPC 与 Python 后端通信。

## 构建

```bash
# 需要 JDK 8+（JAVA_HOME 或 PATH 中有 javac）
python python-backend/jar-runner/build.py
```

产物：`vendor/spider-runner.jar`（打包时由 electron-builder 随包分发）

## 运行方式

```bash
java -jar vendor/spider-runner.jar <spider.jar> <className>
```

## 协议

stdin/stdout 换行分隔 JSON：

**请求：**
```json
{"id": 1, "method": "homeContent", "params": {"filter": true}}
```

**响应：**
```json
{"id": 1, "result": "{\"list\":[],\"class\":[]}"}
```

**错误：**
```json
{"id": 1, "error": {"message": "method not found"}}
```

### 静态 JAR Proxy 数据面

FongMi 标准 JAR 可以提供 `com.github.catvod.spider.Proxy.proxy(Map)`。
Python `JarBridge.call_proxy()` 发送带 `__static_proxy=true` 的 `proxy` 请求；
Runner 返回状态、MIME 和 headers 的 JSON 控制帧。若 body 是 `InputStream`，
控制帧只携带一次性回环 socket 的端口和随机 token：

```json
{"id":1,"proxy":{"status":206,"mime":"video/mp4",
 "headers":{"Content-Range":"bytes 0-9/100"},
 "stream":{"host":"127.0.0.1","port":12345,"token":"..."}}}
```

Python 连接该端口并先发送 `<token>\n`，随后按块读取原始媒体字节。JAR 的
`InputStream` 在客户端断开、上游 EOF 或 60 秒无人连接时关闭；媒体主体不
经过 stdout/JSON，也不会被 Python 一次性缓存。小型 `byte[]`/文本 body 才会
在控制帧中以 base64 返回。

## 支持的 Spider 接口

| 方法 | 参数 |
|------|------|
| init | ext(String) |
| homeContent | filter(boolean) |
| homeVideoContent | pg(String) |
| categoryContent | tid, pg, filter, extend |
| detailContent | ids(String[]) |
| searchContent | key, quick, pg |
| playerContent | flag, id, vipFlags(String[]) |
| liveContent | url |
| proxy | param |
| isVideoFormat | url |
| manualVideoCheck | — |
| destroy | — |

## 兼容性

- **Android 内置 stubs**：`android.util.Log`、`android.util.Base64`、`android.content.Context` 等
- **TVBox 基类 stubs**：`com.github.catvod.crawler.Spider`（继承此基类的 spider 可用）
- **FongMi Proxy stub**：`com.github.catvod.Proxy` 使用 `-Dvpc.proxyPort`
  （默认 9978）生成 PC 本地代理 URL；若宿主注入 `-Dvpc.proxyToken`，URL
  会带可选 token
- **CatVod 常用 stub**：`com.github.catvod.Init`、兼容别名
  `com.github.catvod.spider.Init`，以及 `utils.Json`、`utils.Util`、
  `utils.Path`，把 Context/cache/files 映射到 PC 用户目录
- 如果 jar 内已自包含基类（fat jar 如 takagen99/Box 出品），优先使用 jar 内的类
- 如果 jar 引用 `org.json.*` 或其他 Android 特有类，可能需要额外 stubs（待补充）

## 无 JDK 环境

`spider-runner.jar` 是预构建二进制，随包分发。若无 JDK 可在已构建的机器上生成后提交到仓库，或 CI/CD 流程中构建。
