package android.os;

import java.util.HashMap;
import java.util.Set;

public class Bundle {
    private final HashMap<String, Object> map = new HashMap<>();

    public Bundle() {}
    public Bundle(int capacity) {}

    public void putString(String key, String value) { map.put(key, value); }
    public String getString(String key) { return (String) map.get(key); }
    public String getString(String key, String defaultValue) {
        String v = getString(key);
        return v != null ? v : defaultValue;
    }
    public void putInt(String key, int value) { map.put(key, value); }
    public int getInt(String key) { Object v = map.get(key); return v instanceof Number ? ((Number)v).intValue() : 0; }
    public int getInt(String key, int defaultValue) { return map.containsKey(key) ? getInt(key) : defaultValue; }
    public void putBoolean(String key, boolean value) { map.put(key, value); }
    public boolean getBoolean(String key) { return Boolean.TRUE.equals(map.get(key)); }
    public boolean getBoolean(String key, boolean defaultValue) { return map.containsKey(key) ? getBoolean(key) : defaultValue; }
    public void putLong(String key, long value) { map.put(key, value); }
    public long getLong(String key) { Object v = map.get(key); return v instanceof Number ? ((Number)v).longValue() : 0; }
    public long getLong(String key, long defaultValue) { return map.containsKey(key) ? getLong(key) : defaultValue; }
    public void putDouble(String key, double value) { map.put(key, value); }
    public double getDouble(String key) { Object v = map.get(key); return v instanceof Number ? ((Number)v).doubleValue() : 0; }
    public Set<String> keySet() { return map.keySet(); }
    public boolean containsKey(String key) { return map.containsKey(key); }
    public void putAll(Bundle b) { if (b != null) map.putAll(b.map); }
    public int size() { return map.size(); }
    public boolean isEmpty() { return map.isEmpty(); }
    public void clear() { map.clear(); }
    public Object clone() { Bundle b = new Bundle(); b.map.putAll(map); return b; }
}