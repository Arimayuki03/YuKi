package android.content;

import java.io.File;

/** Minimal android.content.Context stub — 仅提供 spider init 可能用到的极少方法。 */
public class Context {
    public Context getApplicationContext() { return this; }
    public String getPackageName() { return "video-pc"; }
    public android.content.pm.PackageManager getPackageManager() { return null; }

    private static final java.util.concurrent.ConcurrentHashMap<String, SharedPreferences> PREFS =
            new java.util.concurrent.ConcurrentHashMap<>();

    /** 内存版 SharedPreferences（按 name 单例；蜘蛛读写播放历史/收藏不丢）。 */
    public android.content.SharedPreferences getSharedPreferences(String name, int mode) {
        return PREFS.computeIfAbsent(name == null ? "" : name, k -> new SharedPreferencesImpl());
    }

    /**
     * 可写缓存目录（TVBox 蜘蛛静态初始化常调用，如 DexNative → getCacheDir()）。
     * PC 端返回系统临时目录下 vpc-jar-cache 并自动创建。
     */
    public File getCacheDir() {
        File f = new File(System.getProperty("java.io.tmpdir"), "vpc-jar-cache");
        if (!f.exists()) {
            f.mkdirs();
        }
        return f;
    }

    /** 可写数据目录（蜘蛛落盘临时资源用），与缓存同语义。 */
    public File getFilesDir() {
        File f = new File(System.getProperty("java.io.tmpdir"), "vpc-jar-files");
        if (!f.exists()) {
            f.mkdirs();
        }
        return f;
    }
}