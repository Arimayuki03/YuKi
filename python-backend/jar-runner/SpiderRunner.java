import java.io.*;
import java.lang.reflect.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

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

    public static void main(String[] argv) throws Exception {
        if (argv.length < 2) {
            System.err.println("usage: java -jar spider-runner.jar <spider.jar> <defaultClassName>");
            System.exit(1);
        }
        jarPath = argv[0];
        String defaultClass = argv[1];
        loader = new ChildFirstLoader(new URL[]{new File(jarPath).toURI().toURL()},
                                      SpiderRunner.class.getClassLoader());

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
                resp = handle(line.trim());
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
            // destroy 是终态：应答后退出进程（Python 侧 destroy 语义）
            if (line.indexOf("\"destroy\"") >= 0) {
                break;
            }
        }
        System.exit(0);
    }

    // ---- 请求处理 ----

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

    static Object getSpiderInstance(String className) throws Exception {
        if (className.isEmpty()) {
            throw new IllegalArgumentException("className is required in params");
        }
        Object cached = spiders.get(className);
        if (cached != null) {
            seedPanState(cached);
            return cached;
        }
        Class<?> cls = Class.forName(className, true, loader);
        Object inst = cls.getDeclaredConstructor().newInstance();
        spiders.put(className, inst);
        seedPanState(inst);
        return inst;
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
        // init 重载复杂（String / JSONObject / Context,String / 无参），按参数类型逐个试调
        if (method.equals("init")) {
            return invokeInit(spider, cls, params);
        }
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

    /**
     * init 专用反射调用：对同名重载按参数类型逐个试调。
     * 优先带参重载（String / JSONObject / Context,String），无参 init() 最后兜底。
     * IllegalArgumentException（形参类型不匹配）捕获后继续试下一个重载。
     */
    static Object invokeInit(Object spider, Class<?> cls, Map<String,Object> params) throws Exception {
        String ext = (params.containsKey("ext") && params.get("ext") != null)
                ? String.valueOf(params.get("ext")) : "";
        List<Method> withArgs = new ArrayList<>();
        List<Method> noArg = new ArrayList<>();
        for (Method m : cls.getMethods()) {
            if (!m.getName().equals("init")) continue;
            if (m.getParameterCount() == 0) noArg.add(m);
            else withArgs.add(m);
        }
        if (withArgs.isEmpty() && noArg.isEmpty()) {
            throw new NoSuchMethodException("init not found on " + cls.getName());
        }
        // 顺序：带参重载在前，无参兜底在后
        List<Method> ordered = new ArrayList<>(withArgs);
        ordered.addAll(noArg);
        for (Method m : ordered) {
            Object[] args = initArgs(m, ext);
            if (args == null) {
                // 存在无法安全构造的形参类型 → 跳该重载，试下一个
                continue;
            }
            try {
                return m.invoke(spider, args);
            } catch (IllegalArgumentException | IllegalAccessException e) {
                // 参数类型不匹配 → 试下一个重载
            }
        }
        throw new NoSuchMethodException("no invokable init overload on " + cls.getName());
    }

    /**
     * 为 init 的某个重载按形参类型构造实参。无法安全构造的类型返回 null（跳过该重载）。
     * 特别地，init(org.json.JSONObject) 形参：把 ext 字符串解析为 JSONObject
     * （空串/非 JSON → 空对象）；org.json 不在运行时类路径时也返回 null（跳过重载）。
     */
    static Object[] initArgs(Method m, String ext) {
        Class<?>[] types = m.getParameterTypes();
        Object[] args = new Object[types.length];
        for (int i = 0; i < types.length; i++) {
            Class<?> t = types[i];
            String tname = t.getName();
            if (tname.equals("org.json.JSONObject")) {
                Object jo = jsonObjectOf(ext);
                if (jo == null) return null;  // org.json 不可用 → 无法构造实参，跳过该重载
                args[i] = jo;
            } else if (t == String.class) {
                args[i] = ext;
            } else if (t == boolean.class || t == Boolean.class) {
                args[i] = Boolean.FALSE;
            } else if (t == int.class || t == Integer.class) {
                args[i] = 0;
            } else if (t == Map.class || t == HashMap.class
                    || t == LinkedHashMap.class || t == AbstractMap.class) {
                args[i] = new LinkedHashMap<>();
            } else if (t == List.class) {
                args[i] = new ArrayList<>();
            } else if ("android.content.Context".equals(t.getCanonicalName())) {
                // headless PC 无 Context → null 注入
                args[i] = null;
            } else {
                return null;  // 不认识的形参类型，跳过该重载
            }
        }
        return args;
    }

    /**
     * 反射构造 org.json.JSONObject，避免编译期依赖 org.json（普通 .jar 启动时
     * 运行时类路径不含 dexdeps/org-json.jar）。ext 为合法 JSON → 解析；空串/
     * 非 JSON 内容 → 空对象（不抛异常）；org.json 不可加载 → 返回 null。
     */
    static Object jsonObjectOf(String s) {
        try {
            Class<?> cls = Class.forName("org.json.JSONObject");
            if (s != null && !s.trim().isEmpty()) {
                try {
                    java.lang.reflect.Constructor<?> ctor = cls.getConstructor(String.class);
                    return ctor.newInstance(s);
                } catch (Exception ignore) {
                    // 非 JSON 内容 → 空对象
                }
            }
            return cls.getConstructor().newInstance();
        } catch (Throwable t) {
            return null;  // org.json 不可用
        }
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
        if (t.getName().equals("org.json.JSONObject")) {
            // 反射构造；org.json 不可用时返回 null（避免 TypeError）
            return jsonObjectOf(String.valueOf(val));
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
                default: sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
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