package com.github.catvod.parser;

import java.util.LinkedHashMap;

/** Offline fixture for FongMi parse type=2. */
public final class JsonDemo {
    private JsonDemo() {}

    public static Object parse(LinkedHashMap<String, String> jxs, String url) {
        String escaped = url.replace("\\", "\\\\").replace("\"", "\\\"");
        return "{\"url\":\"http://test/type2.mp4?source=" + escaped
                + "\",\"header\":{\"Referer\":\"https://type2.test/\"},"
                + "\"jxCount\":" + jxs.size() + "}";
    }
}
