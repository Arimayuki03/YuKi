package android.content;

public class Intent {
    public static final String ACTION_VIEW = "android.intent.action.VIEW";
    public static final String ACTION_MAIN = "android.intent.action.MAIN";
    public static final String ACTION_SEND = "android.intent.action.SEND";
    public static final String ACTION_BOOT_COMPLETED = "android.intent.action.BOOT_COMPLETED";

    private String action;
    private android.net.Uri data;
    private final android.os.Bundle extras = new android.os.Bundle();

    public Intent() {}
    public Intent(String action) { this.action = action; }
    public Intent(String action, android.net.Uri uri) { this.action = action; this.data = uri; }
    public Intent(Intent o) { if (o != null) { action = o.action; data = o.data; } }

    public String getAction() { return action; }
    public void setAction(String action) { this.action = action; }
    public android.net.Uri getData() { return data; }
    public void setData(android.net.Uri data) { this.data = data; }
    public Intent setType(String type) { return this; }
    public Intent setDataAndType(android.net.Uri data, String type) { this.data = data; return this; }
    public String getType() { return null; }

    public Intent putExtra(String name, String value) { extras.putString(name, value); return this; }
    public Intent putExtra(String name, int value) { extras.putInt(name, value); return this; }
    public Intent putExtra(String name, boolean value) { extras.putBoolean(name, value); return this; }
    public Intent putExtra(String name, long value) { extras.putLong(name, value); return this; }
    public String getStringExtra(String name) { return extras.getString(name); }
    public int getIntExtra(String name, int defaultValue) { return extras.getInt(name, defaultValue); }
    public boolean getBooleanExtra(String name, boolean defaultValue) { return extras.getBoolean(name, defaultValue); }
    public long getLongExtra(String name, long defaultValue) { return extras.getLong(name, defaultValue); }
    public android.os.Bundle getExtras() { return extras; }

    public Intent setFlags(int flags) { return this; }
    public Intent addFlags(int flags) { return this; }
    public Intent setPackage(String pkg) { return this; }
    public String getPackage() { return null; }
    public int getFlags() { return 0; }
    public boolean resolveActivity(android.content.pm.PackageManager pm) { return true; }
    public android.content.ComponentName getComponent() { return null; }
    public Intent setClassName(String pkg, String cls) { return this; }
    public Intent setComponent(android.content.ComponentName component) { return this; }
}