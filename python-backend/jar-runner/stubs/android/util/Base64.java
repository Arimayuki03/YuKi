package android.util;

/** Stubs for android.util.Base64 — 委托 java.util.Base64（JDK8+）。 */
public class Base64 {
    public static final int DEFAULT = 0;
    public static final int NO_WRAP = 2;
    public static final int CRLF = 4;
    public static final int URL_SAFE = 8;
    public static final int NO_PADDING = 16;

    public static byte[] decode(String str, int flags) {
        if (str == null) return new byte[0];
        return java.util.Base64.getDecoder().decode(str);
    }

    public static byte[] encode(byte[] input, int flags) {
        if (input == null) return new byte[0];
        boolean urlSafe = (flags & URL_SAFE) != 0;
        boolean noPadding = (flags & NO_PADDING) != 0;
        java.util.Base64.Encoder enc = urlSafe
                ? java.util.Base64.getUrlEncoder()
                : java.util.Base64.getEncoder();
        if (noPadding) enc = enc.withoutPadding();
        return enc.encode(input);
    }

    public static String encodeToString(byte[] input, int flags) {
        return new String(encode(input, flags), java.nio.charset.StandardCharsets.UTF_8);
    }
}