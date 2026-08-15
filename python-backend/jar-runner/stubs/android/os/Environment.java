package android.os;

import java.io.File;

/** Minimal android.os.Environment stub — 真实返回 File 而非 String。 */
public class Environment {
    public static File getExternalStorageDirectory() { return new File(System.getProperty("user.dir")); }
    public static File getDataDirectory() { return new File(System.getProperty("java.io.tmpdir")); }
    public static File getDownloadCacheDirectory() { return new File(System.getProperty("java.io.tmpdir")); }
}