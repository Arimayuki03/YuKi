package com.github.catvod.utils;

import android.text.TextUtils;
import android.util.Base64;
import java.io.File;
import java.io.FileInputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** PC-safe utility subset; Android-only network/device helpers are omitted. */
public final class Util {
    public static final String OKHTTP = "okhttp/pc";
    public static final String CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";
    public static final int URL_SAFE = Base64.DEFAULT | Base64.URL_SAFE | Base64.NO_WRAP;

    private Util() {}

    public static String base64(String value) { return base64(value.getBytes(StandardCharsets.UTF_8)); }
    public static String base64(byte[] value) { return Base64.encodeToString(value, Base64.DEFAULT | Base64.NO_WRAP); }
    public static String base64(String value, int flags) { return Base64.encodeToString(value.getBytes(StandardCharsets.UTF_8), flags); }
    public static String base64(byte[] value, int flags) { return Base64.encodeToString(value, flags); }
    public static byte[] decode(String value) { return Base64.decode(value, Base64.DEFAULT | Base64.NO_WRAP); }
    public static byte[] decode(String value, int flags) { return Base64.decode(value, flags); }

    public static String md5(String value) {
        if (TextUtils.isEmpty(value)) return "";
        try {
            byte[] digest = MessageDigest.getInstance("MD5").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(new BigInteger(1, digest).toString(16));
            while (out.length() < 32) out.insert(0, '0');
            return out.toString().toLowerCase();
        } catch (Throwable ignored) { return ""; }
    }

    public static String md5(File file) {
        try (FileInputStream in = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("MD5");
            byte[] buffer = new byte[16384];
            int n;
            while ((n = in.read(buffer)) >= 0) if (n > 0) digest.update(buffer, 0, n);
            StringBuilder out = new StringBuilder();
            for (byte b : digest.digest()) out.append(String.format("%02x", b & 0xff));
            return out.toString();
        } catch (Throwable ignored) { return ""; }
    }

    public static boolean equals(String name, String md5) {
        return md5(Path.jar(name)).equalsIgnoreCase(md5);
    }

    public static boolean containOrMatch(String text, String regex) {
        try { return text.contains(regex) || text.matches(regex); }
        catch (Throwable ignored) { return false; }
    }

    public static String substring(String text) { return substring(text, 1); }
    public static String substring(String text, int count) {
        return text != null && text.length() > count ? text.substring(0, text.length() - count) : text;
    }

    public static String getIp() { return "127.0.0.1"; }
}
