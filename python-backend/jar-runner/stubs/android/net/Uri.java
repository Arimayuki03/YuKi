package android.net;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.regex.Pattern;

/**
 * Minimal android.net.Uri stub — 提供 TVBox spider 常用的 URI 解析方法。
 */
public class Uri implements Comparable<Uri> {

    private final String scheme;
    private final String host;
    private final String path;
    private final String query;
    private final String fragment;
    private final String toString;

    private Uri(String scheme, String host, String path, String query, String fragment, String toString) {
        this.scheme = scheme;
        this.host = host;
        this.path = path;
        this.query = query;
        this.fragment = fragment;
        this.toString = toString;
    }

    public static Uri parse(String uriString) {
        if (uriString == null) return null;
        String s = uriString;
        String scheme = "";
        String host = "";
        String path = "";
        String query = "";
        String fragment = "";

        int frag = s.indexOf('#');
        if (frag >= 0) { fragment = s.substring(frag + 1); s = s.substring(0, frag); }

        int q = s.indexOf('?');
        if (q >= 0) { query = s.substring(q + 1); s = s.substring(0, q); }

        String authority = "";
        if (s.contains("://")) {
            int col = s.indexOf("://");
            scheme = s.substring(0, col);
            s = s.substring(col + 3);
            int slash = s.indexOf('/');
            if (slash >= 0) { authority = s.substring(0, slash); path = s.substring(slash); }
            else { authority = s; path = ""; }
        } else {
            path = s;
        }

        int at = authority.indexOf('@');
        if (at >= 0) authority = authority.substring(at + 1);
        int col = authority.indexOf(':');
        if (col >= 0) authority = authority.substring(0, col);
        host = authority;

        return new Uri(scheme, host, path, query, fragment, uriString);
    }

    public static Uri fromParts(String scheme, String ssp, String fragment) {
        return new Uri(scheme, "", ssp, "", fragment, scheme + ":" + ssp);
    }

    public String getScheme() { return scheme; }
    public String getHost() { return host; }
    public String getPath() { return path; }
    public String getQuery() { return query; }
    public String getFragment() { return fragment; }
    public String getLastPathSegment() {
        if (path == null || path.isEmpty()) return "";
        String[] parts = path.split("/");
        return parts.length > 0 ? parts[parts.length - 1] : "";
    }
    public boolean isAbsolute() { return !scheme.isEmpty(); }
    public boolean isHierarchical() { return true; }
    public String getEncodedQuery() { return query; }

    public String getQueryParameter(String key) {
        if (query == null || key == null) return null;
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq >= 0 && pair.substring(0, eq).equals(key)) {
                try { return java.net.URLDecoder.decode(pair.substring(eq + 1), "UTF-8"); }
                catch (Exception e) { return pair.substring(eq + 1); }
            }
        }
        return null;
    }

    public String toString() { return toString; }

    public int compareTo(Uri other) {
        return toString.compareTo(other.toString);
    }

    public static String encode(String s) {
        try { return URLEncoder.encode(s, "UTF-8"); }
        catch (UnsupportedEncodingException e) { return s; }
    }
}