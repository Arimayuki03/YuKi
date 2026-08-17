import java.io.*;
import java.lang.reflect.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * TVBox JAR spider 的 PC 端 JVM 宿主。
 *
 * 命令行：java -jar spider-runner.jar <spider.jar> <className>
 *
 * 协议：stdin/stdout 换行分隔 JSON 行
 *   请求: {"id":1,"method":"homeContent","params":{"filter":true}}
 *   响应: {"id":1,"result":"<json string from spider>"}
 *   错误: {"id":1,"error":{"message":"..."}}
 *
 * 加载策略：child-first URLClassLoader，优先 jar 内类，基类回退到 runner 内置的
 * com.github.catvod.crawler.Spider 等 stubs。
 */
public class SpiderRunner {

    // ---- 缓存已加载的 spider 实例 ----
    static final Map<String, Object> spiders = new ConcurrentHashMap<>();
    static URLClassLoader loader = null;
    static String jarPath = "";
    /**
     * FongMi 的 JAR Proxy 是每个 jar 一个静态类，不属于具体 Spider 实例。
     * 旧桥只会反射实例的 proxy(String)，因此无法处理 Object[]{status,mime,
     * InputStream,headers}。启动时缓存静态方法，普通内容请求仍走实例路径。
     */
    static Method staticProxyMethod = null;

    public static void main(String[] argv) throws Exception {
        if (argv.length < 2) {
            System.err.println("usage: java -jar spider-runner.jar <spider.jar> <defaultClassName>");
            System.exit(1);
        }
        jarPath = argv[0];
        String defaultClass = argv[1];
        // L-10：进程退出时清理 cookie 缓存目录（__shutdown 正常退出 / main 结束均触发；
        // 强杀不经过 hook，但目录已移到用户主目录，无共享临时目录暴露面）
        Runtime.getRuntime().addShutdownHook(new Thread(SpiderRunner::deleteCacheDir));
        loader = new ChildFirstLoader(new URL[]{new File(jarPath).toURI().toURL()},
                                      SpiderRunner.class.getClassLoader());

        // 与 FongMi JarLoader.load() 对齐：先注入 Init，再尝试加载 jar 级静态
        // com.github.catvod.spider.Proxy。没有该类的旧/简化 jar 不影响内容 API。
        seedSpiderContext();
        try {
            Class<?> proxyCls = Class.forName("com.github.catvod.spider.Proxy", true, loader);
            staticProxyMethod = proxyCls.getMethod("proxy", Map.class);
        } catch (Throwable e) {
            staticProxyMethod = null;
        }

        // 预加载默认 spider 类（可选：多个 className 在请求时按 params.className 动态加载）
        try {
            Class<?> cls = Class.forName(defaultClass, true, loader);
            Object spider = cls.getDeclaredConstructor().newInstance();
            spiders.put(defaultClass, spider);
        } catch (Exception e) {
            // 默认类可能不是 jar 中的有效蜘蛛（如 "csp_fm" 占位符），静默
        }

        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        BufferedWriter out = new BufferedWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8));
        out.write("\n");  // 空行后 Python 端认为 ready
        out.flush();

        String line;
        while ((line = in.readLine()) != null) {
            if (line.trim().isEmpty()) continue;
            String resp;
            long rid = extractId(line);
            try {
                Map<String,Object> request = (Map<String,Object>) parseValue(line.trim());
                Map<String,Object> requestParams = request == null
                        ? null : (Map<String,Object>) request.get("params");
                String requestMethod = request == null ? "" : String.valueOf(request.getOrDefault("method", ""));
                // __static_proxy 是 Python JarBridge.call_proxy 的内部标记，
                // 避免影响旧的实例 proxy(String) 调用。
                if ("proxy".equals(requestMethod) && requestParams != null
                        && Boolean.TRUE.equals(requestParams.get("__static_proxy"))) {
                    resp = handleStaticProxy(request);
                } else {
                    resp = handle(line.trim());
                }
            } catch (Throwable t) {
                StringWriter sw = new StringWriter();
                t.printStackTrace(new PrintWriter(sw));
                // jsonEscape 已含外层引号，不能再包一层（否则错误响应是非法 JSON，
                // Python 桥解析失败会丢弃响应导致超时）
                resp = "{\"id\":" + rid + ",\"error\":{\"message\":" + jsonEscape(sw.toString()) + "}}";
            }
            out.write(resp);
            out.write("\n");
            out.flush();
            // 请求可能首次触发网盘蜘蛛初始化（AE 等实例在此后才存在），请求后再播种一次
            seedPanState(null);
            // M-15/M-17：按解析后的 method 判断终态——原对原始行做 "destroy"
            // 子串匹配，搜索词恰为 destroy 时整个 JVM 被误杀（同 jar 全部站点
            // 瞬间不可用）。spider 级 destroy 只是普通方法；退出统一走 __shutdown。
            if ("__shutdown".equals(extractMethod(line))) {
                break;
            }
        }
        System.exit(0);
    }

    // ---- 请求处理 ----

    /** 从请求行提取 method（终态判定用）；解析失败回退空串。 */
    static String extractMethod(String line) {
        try {
            Map<String,Object> req = (Map<String,Object>) parseValue(line);
            Object m = req == null ? null : req.get("method");
            return m == null ? "" : m.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** 从请求行提取 id（用于错误响应）；解析失败回退 0。 */
    static long extractId(String line) {
        try {
            Map<String,Object> req = (Map<String,Object>) parseValue(line);
            return ((Number) req.getOrDefault("id", 0)).longValue();
        } catch (Exception e) {
            return 0;
        }
    }

    @SuppressWarnings("unchecked")
    static String handle(String line) throws Exception {
        Map<String,Object> req = (Map<String,Object>) parseValue(line);
        long id = ((Number) req.getOrDefault("id", 0)).longValue();
        String method = String.valueOf(req.getOrDefault("method", ""));
        Map<String,Object> params = (Map<String,Object>) req.getOrDefault("params", new LinkedHashMap<>());

        // 从 params 中提取 className（支持多蜘蛛共享一个 JVM 进程）
        String className = String.valueOf(params.getOrDefault("class_name", ""));
        params.remove("class_name");  // 元数据，不传给 spider 方法
        params.remove("class");       // 兼容字段
        if (className.isEmpty() || className.equals("null")) {
            className = "";
        }
        takePanCookies(params);       // 网盘 Cookie 元数据，不传给 spider 方法

        Object spider = getSpiderInstance(className);
        Class<?> cls = spider.getClass();
        Object result = invoke(spider, cls, method, params);
        String resultStr = (result == null) ? "null" : String.valueOf(result);
        return "{\"id\":" + id + ",\"result\":" + jsonEscape(resultStr) + "}";
    }

    /**
     * 调用 jar 级静态 Proxy.proxy(Map)，并把 InputStream 放到独立回环 socket。
     * 控制帧仍是换行 JSON，媒体主体不进入 stdout，避免二进制污染 JSON-RPC
     * 串或被 String/byte[] 一次性缓存。
     */
    @SuppressWarnings("unchecked")
    static String handleStaticProxy(Map<String,Object> request) throws Exception {
        long id = ((Number) request.getOrDefault("id", 0)).longValue();
        if (staticProxyMethod == null) {
            throw new NoSuchMethodException("com.github.catvod.spider.Proxy.proxy(Map) not found");
        }
        Object rawParams = request.getOrDefault("params", new LinkedHashMap<>());
        Map<String,Object> source = rawParams instanceof Map
                ? (Map<String,Object>) rawParams : new LinkedHashMap<>();
        Map<String,String> params = new LinkedHashMap<>();
        for (Map.Entry<String,Object> entry : source.entrySet()) {
            String key = entry.getKey();
            if (key == null || key.startsWith("__") || "class_name".equals(key)
                    || "class".equals(key) || "pan_cookies".equals(key)) continue;
            Object value = entry.getValue();
            if (value == null) continue;
            if (value instanceof byte[]) {
                value = new String((byte[]) value, StandardCharsets.UTF_8);
            }
            params.put(key, String.valueOf(value));
        }

        Object raw = staticProxyMethod.invoke(null, params);
        ProxyEnvelope envelope = ProxyEnvelope.from(raw);
        return "{\"id\":" + id + ",\"proxy\":" + envelope.toJson() + "}";
    }

    /** 代理响应的控制帧；body 为小数据时 base64，大数据由 socket 描述符表示。 */
    static final class ProxyEnvelope {
        int status = 200;
        String mime = "application/octet-stream";
        Map<String,String> headers = new LinkedHashMap<>();
        String bodyBase64 = null;
        ProxyStream stream = null;

        static ProxyEnvelope from(Object raw) throws Exception {
            ProxyEnvelope out = new ProxyEnvelope();
            if (raw == null) {
                out.status = 404;
                out.mime = "text/plain; charset=utf-8";
                return out;
            }
            if (raw instanceof Object[]) {
                Object[] rs = (Object[]) raw;
                if (rs.length < 3) throw new IllegalArgumentException("invalid proxy response");
                out.status = toStatus(rs[0]);
                out.mime = rs[1] == null ? out.mime : String.valueOf(rs[1]);
                if (rs.length > 3 && rs[3] instanceof Map) {
                    for (Map.Entry<?,?> e : ((Map<?,?>) rs[3]).entrySet()) {
                        if (e.getKey() != null && e.getValue() != null) {
                            out.headers.put(String.valueOf(e.getKey()), String.valueOf(e.getValue()));
                        }
                    }
                }
                out.setBody(rs[2]);
                return out;
            }
            // 少数简化 Proxy 直接返回 URL；按 FongMi 旧行为转成重定向。
            if (raw instanceof String) {
                out.status = 302;
                out.mime = "text/plain; charset=utf-8";
                out.headers.put("Location", (String) raw);
                return out;
            }
            throw new IllegalArgumentException("unsupported proxy response: "
                    + raw.getClass().getName());
        }

        static int toStatus(Object value) {
            if (value instanceof Number) return ((Number) value).intValue();
            try { return Integer.parseInt(String.valueOf(value)); }
            catch (Exception e) { return 502; }
        }

        void setBody(Object body) throws Exception {
            if (body == null) {
                bodyBase64 = "";
            } else if (body instanceof InputStream) {
                stream = ProxyStream.open((InputStream) body);
            } else if (body instanceof byte[]) {
                bodyBase64 = Base64.getEncoder().encodeToString((byte[]) body);
            } else if (body instanceof File) {
                stream = ProxyStream.open(new FileInputStream((File) body));
            } else {
                bodyBase64 = Base64.getEncoder().encodeToString(
                        String.valueOf(body).getBytes(StandardCharsets.UTF_8));
            }
        }

        String toJson() {
            StringBuilder sb = new StringBuilder("{\"status\":").append(status)
                    .append(",\"mime\":").append(jsonEscape(mime))
                    .append(",\"headers\":").append(mapJson(headers));
            if (stream != null) {
                sb.append(",\"stream\":{\"host\":\"127.0.0.1\",\"port\":")
                        .append(stream.port).append(",\"token\":")
                        .append(jsonEscape(stream.token)).append("}");
            } else {
                sb.append(",\"body\":").append(jsonEscape(bodyBase64 == null ? "" : bodyBase64))
                        .append(",\"encoding\":\"base64\"");
            }
            return sb.append('}').toString();
        }
    }

    /** 一个请求一个一次性回环监听器；客户端断开会关闭 JAR 的 InputStream。 */
    static final class ProxyStream {
        final ServerSocket server;
        final InputStream input;
        final int port;
        final String token;

        private ProxyStream(ServerSocket server, InputStream input, String token) {
            this.server = server;
            this.input = input;
            this.port = server.getLocalPort();
            this.token = token;
        }

        static ProxyStream open(InputStream input) throws IOException {
            ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
            server.setReuseAddress(true);
            String token = UUID.randomUUID().toString().replace("-", "");
            ProxyStream result = new ProxyStream(server, input, token);
            Thread thread = new Thread(result::serve, "jar-proxy-stream-" + result.port);
            thread.setDaemon(true);
            thread.start();
            return result;
        }

        void serve() {
            try (ServerSocket ss = server) {
                ss.setSoTimeout((int) TimeUnit.SECONDS.toMillis(60));
                try (Socket socket = ss.accept()) {
                    socket.setTcpNoDelay(true);
                    // 不能用 BufferedReader：readLine() 可能预读 token 后面的
                    // 媒体字节，随后直接从 socket InputStream 读取会丢掉这段
                    // 已进入 Reader buffer 的视频头部。
                    InputStream socketIn = socket.getInputStream();
                    StringBuilder received = new StringBuilder();
                    int ch;
                    while (received.length() <= token.length() + 1
                            && (ch = socketIn.read()) >= 0) {
                        if (ch == '\n') break;
                        if (ch != '\r') received.append((char) ch);
                    }
                    if (!token.equals(received.toString())) return;
                    OutputStream out = new BufferedOutputStream(socket.getOutputStream(), 64 * 1024);
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = input.read(buf)) >= 0) {
                        if (n == 0) continue;
                        out.write(buf, 0, n);
                        out.flush();
                    }
                }
            } catch (Throwable ignored) {
                // 客户端中断/上游断开是正常的媒体生命周期，不污染控制台 JSON。
            } finally {
                try { input.close(); } catch (Throwable ignored) {}
            }
        }
    }

    static Object getSpiderInstance(String className) throws Exception {
        if (className.isEmpty()) {
            throw new IllegalArgumentException("className is required in params");
        }
        Object cached = spiders.get(className);
        if (cached != null) {
            seedPanState(cached);
            return cached;
        }
        // TVBox 蜘蛛静态初始化（BaseSpiderGuard → Init.getSpider → DexNative.<clinit>）
        // 依赖宿主注入的全局 Context（Init.context()），必须先注入再实例化蜘蛛。
        seedSpiderContext();
        Class<?> cls = Class.forName(className, true, loader);
        Object inst = cls.getDeclaredConstructor().newInstance();
        spiders.put(className, inst);
        seedPanState(inst);
        return inst;
    }

    /** 向 jar 内 Init 注入 stub Application 全局 Context（对应 TVBox 宿主启动时的 Init.init(context)）。 */
    static void seedSpiderContext() {
        android.content.Context context = new android.app.Application();
        // 上游 CatVod 使用 com.github.catvod.Init；部分 FongMi 旧 jar 把
        // 相同入口放在 com.github.catvod.spider.Init。两者都尝试，且兼容
        // set(Context)/init(Context) 两种命名。
        for (String name : new String[]{"com.github.catvod.Init", "com.github.catvod.spider.Init"}) {
            try {
                Class<?> initCls = Class.forName(name, true, loader);
                boolean invoked = false;
                for (String method : new String[]{"init", "set"}) {
                    try {
                        initCls.getMethod(method, android.content.Context.class).invoke(null, context);
                        invoked = true;
                        break;
                    } catch (NoSuchMethodException ignored) {
                        // 尝试下一个兼容命名
                    }
                }
                if (invoked) return;
            } catch (Throwable ignore) {
                // 无该 Init 类或其静态初始化失败：继续尝试另一个入口。
            }
        }
    }

    // ---- 网盘 Cookie 注入（用户配置，经 params.pan_cookies 传入）----

    static final Map<String, String> panCookies = new HashMap<>();
    static final Map<String, String> appliedCookies = new HashMap<>();
    static final Set<String> placeholderSeeded = new HashSet<>();
    static final String PLACEHOLDER = "__puus=pc-bridge; __pus=pc-bridge;";
    static final String[] PROVIDER_NAMES = {"Quark", "UC", "TianYi", "Baidu", "P123", "XunLei"};

    /** 从请求 params 提取网盘 Cookie 配置（元数据，不传给蜘蛛方法）。 */
    static void takePanCookies(Map<String, Object> params) {
        Object pc = params.remove("pan_cookies");
        panCookies.clear();
        if (pc instanceof Map) {
            for (Map.Entry<?, ?> e : ((Map<?, ?>) pc).entrySet()) {
                if (e.getKey() != null && e.getValue() != null) {
                    panCookies.put(String.valueOf(e.getKey()), String.valueOf(e.getValue()));
                }
            }
        }
        seedCookieFiles();
    }

    /**
     * 把用户网盘 Cookie 写入 FongMi 蜘蛛约定的 cookie 文件。
     *
     * 部分 FongMi 系网盘蜘蛛（ea3f/4K 网盘 jar 等）不从静态字段读 cookie，
     * 而是从 Environment.getExternalStorageDirectory()/TVBox/ 下的
     * quark_cookie.txt / uc_cookie.txt / bili_cookie.txt / 189_cookie.txt
     * 读取登录态（Android 上即 /sdcard/TVBox/...）。账号对象（merge.i.d）
     * 的登录判定要求 cookie / member_type / nickname 三字段都非空，因此
     * 写入 JSON 格式而非裸 cookie 串；不写文件则蜘蛛永远「未登录」。
     */
    /** 蜘蛛可写根目录（L-10）：用户主目录下私有路径，替代共享 %TMP%/vpc-jar-cache
     *  （明文 cookie 落共享临时目录可被同机其他用户读取）。与 Context/
     *  Environment stub 的映射保持一致。 */
    static File cacheRoot() {
        return new File(System.getProperty("user.home"),
                ".video-pc" + File.separator + "jar-cache");
    }

    /** 递归删除缓存目录（shutdown hook 调用）。 */
    static void deleteCacheDir() {
        deleteTree(cacheRoot());
    }

    static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) {
            for (File c : children) deleteTree(c);
        }
        try { f.delete(); } catch (Throwable ignore) {}
    }

    static void seedCookieFiles() {
        try {
            File root = cacheRoot();
            File tvboxDir = new File(root, "TVBox");
            if (!tvboxDir.exists() && !tvboxDir.mkdirs()) return;
            String[][] files = {
                {"quark", "quark_cookie.txt"},
                {"uc", "uc_cookie.txt"},
                {"bili", "bili_cookie.txt"},
                {"189", "189_cookie.txt"},
                {"diy", "diy_cookie.txt"},
            };
            for (String[] pair : files) {
                String cfg = panCookies.get(pair[0]);
                if (cfg == null || cfg.trim().isEmpty()) continue;
                File f = new File(tvboxDir, pair[1]);
                String json = "{\"cookie\":\"" + jsonEscapeStr(cfg.trim())
                        + "\",\"member_type\":\"1\",\"nickname\":\"PC\"}";
                try (java.io.FileOutputStream fos = new java.io.FileOutputStream(f)) {
                    fos.write(json.getBytes(StandardCharsets.UTF_8));
                }
            }
        } catch (Throwable ignore) {
        }
    }

    /** JSON 字符串值转义（cookie 值含 ; = % + / 等，无引号也兜底转义）。 */
    static String jsonEscapeStr(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder();
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) { sb.append(String.format("\\u%04x", (int) c)); }
                    else { sb.append(c); }
            }
        }
        return sb.toString();
    }

    /**
     * 网盘蜘蛛（FM 系 Pan 基类）无真实 Cookie 时，AE.K()/AR.K() 会无限等待用户登录/验证码
     * （TVBox 弹对话框，headless PC 无法完成）。策略：
     * 1. 用户配置了 Cookie → 通过 provider.init(null, cookie) 注入（真实播放链路）；
     * 2. 未配置 → 跳过 provider.init（注入占位符会让 UC 等以 __pus 判断登录态的蜘蛛
     *    误以为已登录，触发真实 cookieToken 请求 → 接口返回非 JSON → MalformedJsonException
     *    刷屏）。跳过让蜘蛛走"未登录 → 快速失败"自然路径；
     * 3. 蜘蛛已持有真实 Cookie（如站点 ext 注入）时不再覆盖。
     */
    static void seedPanState(Object spider) {
        if (spider != null) {
            seedProviders(spider);
        }
        seedQuarkFallback();
    }

    /** 遍历 Pan 子类实例上的网盘 provider 字段（Quark/UC/TianYi/Baidu/P123/XunLei）逐个注入。 */
    static void seedProviders(Object spider) {
        Class<?> cls = spider.getClass();
        while (cls != null && cls != Object.class) {
            for (java.lang.reflect.Field f : cls.getDeclaredFields()) {
                String simple = f.getType().getSimpleName();
                String key = null;
                for (String n : PROVIDER_NAMES) {
                    if (n.equals(simple)) { key = n.toLowerCase(); break; }
                }
                if (key == null) continue;
                Object prov;
                try {
                    f.setAccessible(true);
                    prov = f.get(spider);
                } catch (Exception e) {
                    continue;
                }
                if (prov == null) continue;
                String cfg = panCookies.get(key);
                if (cfg != null && !cfg.trim().isEmpty()) {
                    // 仅在 Cookie 值变化时重新注入，避免每次请求都触发 jar 内持久化逻辑
                    if (!cfg.trim().equals(appliedCookies.get(key))) {
                        invokeProviderInit(prov, cfg.trim());
                        appliedCookies.put(key, cfg.trim());
                    }
                    placeholderSeeded.add(key);
                } else if (!placeholderSeeded.contains(key) && !providerHasCookie(key)) {
                    // 未配置 Cookie：不再注入占位符（UC 等以 __pus 判断登录态，占位符会触发
                    // 真实的 cookieToken 网络请求，接口返回非 JSON 导致 MalformedJsonException 刷屏）。
                    // 跳过 provider.init，让蜘蛛走"未登录 → 快速失败"自然路径，仅记录已处理标记，
                    // 避免后续每个请求重复判断。
                    placeholderSeeded.add(key);
                }
            }
            cls = cls.getSuperclass();
        }
    }

    static boolean providerHasCookie(String key) {
        try {
            if (key.equals("quark")) {
                Class<?> ad = Class.forName("com.github.catvod.spider.merge.c.AD", true, loader);
                Object ae = ad.getField("A").get(null);
                Object v = ae.getClass().getField("A").get(ae);
                return v instanceof String && !((String) v).isEmpty();
            }
            if (key.equals("uc")) {
                Class<?> aq = Class.forName("com.github.catvod.spider.merge.c.AQ", true, loader);
                Object ar = aq.getField("A").get(null);
                Object v = ar.getClass().getField("A").get(ar);
                return v instanceof String && !((String) v).isEmpty();
            }
        } catch (Throwable ignore) {
        }
        return false;
    }

    static void invokeProviderInit(Object prov, String cookie) {
        try {
            Class<?>[] types = {Class.forName("android.content.Context"), String.class};
            java.lang.reflect.Method m = prov.getClass().getMethod("init", types);
            m.invoke(prov, new Object[]{null, cookie});
        } catch (Throwable ignore) {
        }
    }

    /** 兜底：非 Pan 子类但直接用夸克 AE 的蜘蛛（如 csp_Kwps），无 Cookie 时防挂死。 */
    static void seedQuarkFallback() {
        try {
            Class<?> ad = Class.forName("com.github.catvod.spider.merge.c.AD", true, loader);
            Object ae = ad.getField("A").get(null);
            if (ae == null) return;
            java.lang.reflect.Field f = ae.getClass().getField("A");
            Object cur = f.get(ae);
            String cfg = panCookies.get("quark");
            boolean hasCfg = cfg != null && !cfg.trim().isEmpty();
            // 已持有 cookie 且无新配置，或已播种且配置未变化 → 不动
            if ((cur instanceof String && !((String) cur).isEmpty() && !hasCfg)
                    || (placeholderSeeded.contains("quark")
                        && (!hasCfg || cfg.trim().equals(appliedCookies.get("quark"))))) {
                return;
            }
            if (hasCfg) {
                f.set(ae, cfg.trim());
                appliedCookies.put("quark", cfg.trim());
            } else {
                f.set(ae, PLACEHOLDER);
            }
            placeholderSeeded.add("quark");
            try {
                java.lang.reflect.Field h = ae.getClass().getField("H");
                h.setBoolean(ae, true);
            } catch (NoSuchFieldException ignore) {}
        } catch (Throwable ignore) {
        }
    }

    // ---- 反射调用 ----

    static Object invoke(Object spider, Class<?> cls, String method, Map<String,Object> params) throws Exception {
        for (Method m : cls.getMethods()) {
            if (!m.getName().equals(method)) continue;
            int want = m.getParameterCount();
            if (want == 0) {
                return m.invoke(spider);
            }
            Class<?>[] types = m.getParameterTypes();
            Object[] args = new Object[want];
            // 参数名映射：优先方法签名表，兜底位置序号（pg/pg1...）
            String[] names = paramNames(method, want);
            for (int i = 0; i < want; i++) {
                String pname = (i < names.length) ? names[i] : ("arg" + i);
                Object val = params.containsKey(pname) ? params.get(pname) : null;
                args[i] = convert(types[i], val);
            }
            return m.invoke(spider, args);
        }
        throw new NoSuchMethodException(method + " not found on " + cls.getName());
    }

    /** 按 TVBox 方法签名约定返回参数名序列。 */
    static String[] paramNames(String method, int want) {
        switch (method) {
            case "init":
                // TVBox 真实 spider 签名 init(Context, String) 两参数；
                // 测试 jar 可能有 init(String) 单参数。按 want 返回。
                if (want == 2) return new String[]{"context", "ext"};
                return new String[]{"ext"};
            case "homeContent": return new String[]{"filter"};
            case "homeVideoContent": return new String[]{"pg"};
            case "categoryContent": return new String[]{"tid", "pg", "filter", "extend"};
            case "detailContent": return new String[]{"ids"};
            case "searchContent": return new String[]{"key", "quick", "pg"};
            case "playerContent": return new String[]{"flag", "id", "vipFlags"};
            case "liveContent": return new String[]{"url"};
            case "proxy": return new String[]{"param"};
            case "action": return new String[]{"action"};
            default:
                String[] out = new String[want];
                for (int i = 0; i < want; i++) out[i] = "arg" + i;
                return out;
        }
    }

    static Object convert(Class<?> t, Object val) {
        if (val == null) {
            if (t == boolean.class) return Boolean.FALSE;
            if (t == int.class) return 0;
            return null;
        }
        if (t == String.class) return String.valueOf(val);
        if (t == boolean.class || t == Boolean.class) {
            if (val instanceof Boolean) return val;
            return Boolean.parseBoolean(String.valueOf(val));
        }
        if (t == int.class || t == Integer.class) {
            if (val instanceof Number) return ((Number)val).intValue();
            return Integer.parseInt(String.valueOf(val));
        }
        if (t == String[].class) {
            if (val instanceof List) {
                List<?> list = (List<?>) val;
                String[] arr = new String[list.size()];
                for (int i = 0; i < list.size(); i++) arr[i] = String.valueOf(list.get(i));
                return arr;
            }
            return new String[]{String.valueOf(val)};
        }
        if (t == Map.class || t == HashMap.class) {
            if (val instanceof Map) return val;
            return new LinkedHashMap<>();
        }
        if (t == List.class) {
            if (val instanceof List) return val;
            return new ArrayList<>();
        }
        return val;
    }

    // ---- 极简 JSON 解析器 ----

    /** 解析以当前字符开头的完整值（支持嵌套），pos[0] 更新为值结束后的位置。 */
    static Object parseValueAt(String s, int[] pos) {
        int i = pos[0];
        while (i < s.length() && s.charAt(i) <= ' ') i++;
        pos[0] = i;
        if (i >= s.length()) return null;
        char c = s.charAt(i);
        if (c == '{') {
            return parseObjectAt(s, pos);
        }
        if (c == '[') {
            return parseArrayAt(s, pos);
        }
        if (c == '"') {
            return parseStringAt(s, pos);
        }
        // 字面量/数字：读到分隔符
        int j = i;
        while (j < s.length() && s.charAt(j) > ' ' && s.charAt(j) != ',' && s.charAt(j) != '}' && s.charAt(j) != ']') j++;
        String tok = s.substring(i, j);
        pos[0] = j;
        if (tok.equals("true")) return Boolean.TRUE;
        if (tok.equals("false")) return Boolean.FALSE;
        if (tok.equals("null")) return null;
        try {
            boolean isDouble = tok.contains(".") || tok.contains("e") || tok.contains("E");
            if (isDouble) return Double.parseDouble(tok);
            long n = Long.parseLong(tok);
            return (n >= Integer.MIN_VALUE && n <= Integer.MAX_VALUE) ? (int) n : n;
        } catch (NumberFormatException e) {
            return tok; // 非数字字面量按字符串处理
        }
    }

    static Map<String,Object> parseObjectAt(String s, int[] pos) {
        Map<String,Object> map = new LinkedHashMap<>();
        int i = pos[0];
        if (i < s.length() && s.charAt(i) == '{') i++;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c <= ' ') { i++; continue; }
            if (c == '}') { i++; break; }
            if (c == ',') { i++; continue; }
            if (c == '"') {
                int[] kpos = new int[]{i};
                String key = parseStringAt(s, kpos);
                i = kpos[0];
                while (i < s.length() && s.charAt(i) <= ' ') i++;
                if (i < s.length() && s.charAt(i) == ':') i++;
                while (i < s.length() && s.charAt(i) <= ' ') i++;
                int[] vpos = new int[]{i};
                Object val = parseValueAt(s, vpos);
                map.put(key, val);
                i = vpos[0];
            } else {
                i++;
            }
        }
        pos[0] = i;
        return map;
    }

    static List<Object> parseArrayAt(String s, int[] pos) {
        List<Object> list = new ArrayList<>();
        int i = pos[0];
        if (i < s.length() && s.charAt(i) == '[') i++;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c <= ' ') { i++; continue; }
            if (c == ']') { i++; break; }
            if (c == ',') { i++; continue; }
            int[] vpos = new int[]{i};
            Object val = parseValueAt(s, vpos);
            list.add(val);
            i = vpos[0];
        }
        pos[0] = i;
        return list;
    }

    /** 兼容入口：解析整个字符串（仅用于顶层）。 */
    static Object parseValue(String s) {
        int[] pos = new int[]{0};
        Object v = parseValueAt(s, pos);
        return v;
    }

    static String parseStringAt(String s, int[] pos) {
        StringBuilder sb = new StringBuilder();
        int i = pos[0];
        if (i < s.length() && s.charAt(i) == '"') i++;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c == '\\') {
                if (i + 1 < s.length()) {
                    char next = s.charAt(i + 1);
                    switch (next) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case 'n': sb.append('\n'); break;
                        case 't': sb.append('\t'); break;
                        case 'r': sb.append('\r'); break;
                        case '/': sb.append('/'); break;
                        default: sb.append(next);
                    }
                    i += 2;
                } else { i++; }
            } else if (c == '"') {
                i++;
                break;
            } else {
                sb.append(c);
                i++;
            }
        }
        pos[0] = i;
        return sb.toString();
    }

    static Number parseNumber(String s) {
        boolean isDouble = s.contains(".") || s.contains("e") || s.contains("E");
        if (isDouble) return Double.parseDouble(s);
        long n = Long.parseLong(s);
        if (n >= Integer.MIN_VALUE && n <= Integer.MAX_VALUE) return (int) n;
        return n;
    }

    static int valueLength(String s) {
        // 兼容旧调用：整串解析一个值
        int[] pos = new int[]{0};
        parseValueAt(s, pos);
        return pos[0];
    }

    static String jsonEscape(String s) {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) { sb.append(String.format("\\u%04x", (int) c)); }
                    else { sb.append(c); }
            }
        }
        sb.append('"');
        return sb.toString();
    }

    /** 代理 headers 专用 JSON 编码（值均已归一为字符串）。 */
    static String mapJson(Map<String,String> map) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        if (map != null) {
            for (Map.Entry<String,String> e : map.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append(jsonEscape(e.getKey())).append(':').append(jsonEscape(e.getValue()));
            }
        }
        return sb.append('}').toString();
    }

    // ---- Child-First URLClassLoader ----

    static class ChildFirstLoader extends URLClassLoader {
        ChildFirstLoader(URL[] urls, ClassLoader parent) {
            super(urls, parent);
        }
        @Override
        protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
            synchronized (getClassLoadingLock(name)) {
                Class<?> c = findLoadedClass(name);
                if (c == null) {
                    try {
                        c = findClass(name);  // child first: 从 jar 内找
                    } catch (ClassNotFoundException e) {
                        c = super.loadClass(name, false);  // 回退到 runner 内置 stubs
                    }
                }
                if (resolve) resolveClass(c);
                return c;
            }
        }
    }
}
