package com.github.catvod.spider;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/** Fixture for the PC JAR proxy transport tests. */
public final class Proxy {
    private Proxy() {
    }

    public static Object[] proxy(Map<String, String> params) {
        if (params != null && "url".equals(params.get("mode"))) {
            byte[] url = com.github.catvod.Proxy.getUrl(true).getBytes(StandardCharsets.UTF_8);
            return new Object[]{200, "text/plain; charset=utf-8",
                    new ByteArrayInputStream(url), new LinkedHashMap<>()};
        }
        String range = params == null ? "" : String.valueOf(params.getOrDefault("range", ""));
        String text = "proxy-ok" + (range.isEmpty() ? "" : ":" + range);
        byte[] body = text.getBytes(StandardCharsets.UTF_8);
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Length", String.valueOf(body.length));
        headers.put("Accept-Ranges", "bytes");
        return new Object[]{200, "text/plain; charset=utf-8",
                new ByteArrayInputStream(body), headers};
    }
}
