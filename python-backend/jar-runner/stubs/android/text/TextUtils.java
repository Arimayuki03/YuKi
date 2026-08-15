package android.text;

/**
 * Minimal android.text.TextUtils stub — 提供 TVBox spider 常用的静态方法。
 */
public class TextUtils {
    public static boolean isEmpty(CharSequence s) {
        return s == null || s.length() == 0;
    }
    public static String join(CharSequence delimiter, Iterable<?> tokens) {
        StringBuilder sb = new StringBuilder();
        for (Object t : tokens) {
            if (sb.length() > 0) sb.append(delimiter);
            sb.append(t);
        }
        return sb.toString();
    }
    public static String join(CharSequence delimiter, Object[] tokens) {
        return join(delimiter, java.util.Arrays.asList(tokens));
    }
    public static boolean equals(CharSequence a, CharSequence b) {
        if (a == b) return true;
        if (a == null || b == null) return false;
        return a.toString().equals(b.toString());
    }
    public static int length(CharSequence s) {
        return s == null ? 0 : s.length();
    }
    public static String nullIfEmpty(String s) {
        return isEmpty(s) ? null : s;
    }
    public static String emptyIfNull(String s) {
        return s == null ? "" : s;
    }
    public static int getTrimmedLength(CharSequence s) {
        if (s == null) return 0;
        return s.toString().trim().length();
    }
    public static String substring(CharSequence s, int start, int end) {
        return s == null ? "" : s.toString().substring(start, end);
    }
    public static boolean isDigitsOnly(CharSequence s) {
        if (isEmpty(s)) return false;
        for (int i = 0; i < s.length(); i++) {
            if (!Character.isDigit(s.charAt(i))) return false;
        }
        return true;
    }
    public static String[] split(String text, String expression) {
        return text == null ? new String[0] : text.split(expression);
    }
}