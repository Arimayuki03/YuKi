package android.content;

/** Minimal android.content.Context stub — 仅提供 spider init 可能用到的极少方法。 */
public class Context {
    public Context getApplicationContext() { return this; }
    public String getPackageName() { return "video-pc"; }
    public android.content.pm.PackageManager getPackageManager() { return null; }
    public android.content.SharedPreferences getSharedPreferences(String name, int mode) { return null; }
    public String getFilesDir() { return null; }
    public String getCacheDir() { return null; }
}