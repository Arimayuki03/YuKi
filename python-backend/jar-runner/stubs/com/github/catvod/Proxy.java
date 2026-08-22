package com.github.catvod;

/**
 * PC 端的 CatVod Proxy 地址 stub。
 *
 * FongMi JAR 会调用该类拼出 ``http://127.0.0.1:<port>/proxy`` 播放地址。
 * Android 端的端口由 NanoHTTPD 分配；桌面端由 JarBridge 通过
 * -Dyuki.proxyHost/-Dyuki.proxyPort 注入，默认兼容 9978。
 */
public final class Proxy {
    private static volatile String host = readHost();
    private static volatile int port = readPort();
    private static volatile String token = readToken();

    private Proxy() {
    }

    private static int readPort() {
        try {
            String value = System.getProperty("yuki.proxyPort", "9978");
            int parsed = Integer.parseInt(value);
            return parsed > 0 && parsed <= 65535 ? parsed : 9978;
        } catch (Throwable ignored) {
            return 9978;
        }
    }

    private static String readHost() {
        try {
            String value = System.getProperty("yuki.proxyHost", "127.0.0.1");
            return value == null || value.trim().isEmpty() ? "127.0.0.1" : value.trim();
        } catch (Throwable ignored) {
            return "127.0.0.1";
        }
    }

    private static String readToken() {
        try { return System.getProperty("yuki.proxyToken", ""); }
        catch (Throwable ignored) { return ""; }
    }

    public static void set(int value) {
        if (value > 0 && value <= 65535) port = value;
    }

    public static void setHost(String value) {
        if (value != null && !value.trim().isEmpty()) host = value.trim();
    }

    public static void setToken(String value) {
        token = value == null ? "" : value.trim();
    }

    public static int getPort() {
        return port;
    }

    public static String getUrl(boolean local) {
        String address = local ? "127.0.0.1" : host;
        String url = "http://" + address + ":" + getPort() + "/proxy";
        // yuki.proxyToken 由宿主生成的 hex token，字符集已是 URL-safe。
        return token.isEmpty() ? url : url + "?token=" + token;
    }
}
