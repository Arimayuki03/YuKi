package com.github.catvod.spider;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
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
        if (params != null && "interrupt".equals(params.get("mode"))) {
            int observerPort = Integer.parseInt(params.get("observerPort"));
            Map<String, String> headers = new LinkedHashMap<>();
            headers.put("Accept-Ranges", "bytes");
            headers.put("X-Fixture-Range", String.valueOf(params.getOrDefault("range", "")));
            return new Object[]{206, "application/octet-stream",
                    new InterruptibleInputStream(observerPort), headers};
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

    private static final class InterruptibleInputStream extends InputStream {
        private final int observerPort;
        private boolean closed;

        InterruptibleInputStream(int observerPort) {
            this.observerPort = observerPort;
        }

        @Override
        public int read() throws IOException {
            if (closed) return -1;
            return 'x';
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            if (closed) return -1;
            int count = Math.min(length, 64 * 1024);
            Arrays.fill(buffer, offset, offset + count, (byte) 'x');
            return count;
        }

        @Override
        public synchronized void close() throws IOException {
            if (closed) return;
            closed = true;
            try (Socket observer = new Socket("127.0.0.1", observerPort)) {
                observer.getOutputStream().write("closed\n".getBytes(StandardCharsets.US_ASCII));
                observer.getOutputStream().flush();
            }
        }
    }
}
