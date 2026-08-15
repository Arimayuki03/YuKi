package android.content.pm;

/** Minimal PackageManager stub — 必要的类型引用。 */
public class PackageManager {
    public static final int GET_META_DATA = 0x00008000;
    public static final int GET_SIGNATURES = 0x00000040;
    public static final int GET_PERMISSIONS = 0x00001000;
    public static final int MATCH_UNINSTALLED_PACKAGES = 0x00002000;
    public static final int MATCH_DEFAULT_ONLY = 0x00010000;

    /** Stub 返回 null；jar 内爬虫很少使用。 */
    public android.content.pm.PackageInfo getPackageInfo(String packageName, int flags)
            throws android.content.pm.PackageManager.NameNotFoundException {
        return null;
    }

    public static class NameNotFoundException extends Exception {
        public NameNotFoundException() { super(); }
        public NameNotFoundException(String name) { super(name); }
    }
}