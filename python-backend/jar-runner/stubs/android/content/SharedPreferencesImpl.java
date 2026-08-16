package android.content;

import java.util.HashMap;
import java.util.Map;

/**
 * 内存版 SharedPreferences 实现（PC 端无 Android 存储）。
 *
 * TVBox 蜘蛛（如 ea3f 4K 网盘 jar 的 detailContent → processVodData → saveName）
 * 会读写 SharedPreferences 记录播放历史/收藏；stub 此前返回 null 导致
 * NullPointerException。进程内 HashMap 足够，跨调用保持同一实例即可。
 */
public class SharedPreferencesImpl implements SharedPreferences {

    private final Map<String, Object> data = new HashMap<>();

    @Override
    public String getString(String key, String defValue) {
        Object v = data.get(key);
        return v instanceof String ? (String) v : defValue;
    }

    @Override
    public int getInt(String key, int defValue) {
        Object v = data.get(key);
        return v instanceof Number ? ((Number) v).intValue() : defValue;
    }

    @Override
    public long getLong(String key, long defValue) {
        Object v = data.get(key);
        return v instanceof Number ? ((Number) v).longValue() : defValue;
    }

    @Override
    public boolean getBoolean(String key, boolean defValue) {
        Object v = data.get(key);
        return v instanceof Boolean ? (Boolean) v : defValue;
    }

    @Override
    public Editor edit() {
        return new EditorImpl();
    }

    private class EditorImpl implements SharedPreferences.Editor {
        private final Map<String, Object> pending = new HashMap<>();
        private boolean cleared = false;

        @Override
        public Editor putString(String key, String value) { pending.put(key, value); return this; }
        @Override
        public Editor putInt(String key, int value) { pending.put(key, value); return this; }
        @Override
        public Editor putLong(String key, long value) { pending.put(key, value); return this; }
        @Override
        public Editor putBoolean(String key, boolean value) { pending.put(key, value); return this; }
        @Override
        public Editor remove(String key) { pending.put(key, null); return this; }
        @Override
        public Editor clear() { cleared = true; return this; }

        @Override
        public boolean commit() { apply(); return true; }

        @Override
        public void apply() {
            if (cleared) data.clear();
            for (Map.Entry<String, Object> e : pending.entrySet()) {
                if (e.getValue() == null) data.remove(e.getKey());
                else data.put(e.getKey(), e.getValue());
            }
            pending.clear();
        }
    }
}
