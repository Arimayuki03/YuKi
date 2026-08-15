package com.github.catvod.crawler;

import android.content.Context;

/**
 * TVBox Spider 基类 stubs（兼容原始 jar 中继承此基类的 spider）。
 * 仅提供方法签名，方法体为空（由子类覆盖）。
 */
public class Spider {
    public void init(Context context, String extend) throws Exception {}

    public void init(Context context) throws Exception { init(context, ""); }

    public String homeContent(boolean filter) throws Exception { return ""; }

    public String homeVideoContent() throws Exception { return ""; }

    public String categoryContent(String tid, String pg, boolean filter, String extend) throws Exception { return ""; }

    /** 部分 jar 蜘蛛以 HashMap 形式传递 extend（与 String 版签名并存）。 */
    public String categoryContent(String tid, String pg, boolean filter, java.util.HashMap<String, String> extend)
            throws Exception {
        return "";
    }

    public String detailContent(String[] ids) throws Exception { return ""; }

    public String searchContent(String key, boolean quick, String pg) throws Exception { return ""; }

    public String playerContent(String flag, String id, String[] vipFlags) throws Exception { return ""; }

    public String liveContent(String url) throws Exception { return ""; }

    public String proxy(String param) throws Exception { return ""; }

    public boolean isVideoFormat(String url) { return false; }

    public boolean manualVideoCheck() { return false; }

    public void destroy() {}

    /**
     * 真实 CatVod SDK 的共享 OkHttpClient（jar 内 merge/AC/G.E() 优先调用）。
     * 带 20s 连接/读写超时：慢站点快速失败，避免蜘蛛网络请求无限挂起
     * 导致整个 JVM 桥超时重启。（编译依赖 vendor/dexdeps/okhttp3.jar）
     */
    public static okhttp3.OkHttpClient client() {
        return new okhttp3.OkHttpClient.Builder()
                .connectTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
                .writeTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
                .build();
    }

    /** 部分 jar 蜘蛛调用 Spider.safeDns() 获取 DNS；系统默认即可。 */
    public static okhttp3.Dns safeDns() {
        return okhttp3.Dns.SYSTEM;
    }
}