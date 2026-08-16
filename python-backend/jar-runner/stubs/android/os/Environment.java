package android.os;

import java.io.File;

/** Minimal android.os.Environment stub — 真实返回 File 而非 String。 */
public class Environment {
    /** 固定可写根目录：FongMi 蜘蛛把 cookie/临时文件写到 <extStorage>/TVBox/ 下。 */
    public static File getExternalStorageDirectory() {
        return new File(System.getProperty("java.io.tmpdir"), "vpc-jar-cache");
    }
    public static File getDataDirectory() { return new File(System.getProperty("java.io.tmpdir")); }
    public static File getDownloadCacheDirectory() { return new File(System.getProperty("java.io.tmpdir")); }
}