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
- 如果 jar 内已自包含基类（fat jar 如 takagen99/Box 出品），优先使用 jar 内的类
- 如果 jar 引用 `org.json.*` 或其他 Android 特有类，可能需要额外 stubs（待补充）

## 无 JDK 环境

`spider-runner.jar` 是预构建二进制，随包分发。若无 JDK 可在已构建的机器上生成后提交到仓库，或 CI/CD 流程中构建。