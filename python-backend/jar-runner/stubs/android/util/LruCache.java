package android.util;

import java.util.LinkedHashMap;
import java.util.Map;

public class LruCache<K, V> {
    private final LinkedHashMap<K, V> map = new LinkedHashMap<>(0, 0.75f, true);
    private int maxSize;

    public LruCache(int maxSize) {
        if (maxSize <= 0) throw new IllegalArgumentException("maxSize <= 0");
        this.maxSize = maxSize;
    }

    public synchronized V get(K key) {
        return map.get(key);
    }

    public synchronized V put(K key, V value) {
        if (key == null || value == null) throw new NullPointerException("key == null || value == null");
        V previous = map.put(key, value);
        trimToSize(maxSize);
        return previous;
    }

    public synchronized V remove(K key) {
        return map.remove(key);
    }

    public synchronized void evictAll() {
        trimToSize(-1);
    }

    public synchronized int size() {
        return map.size();
    }

    public synchronized int maxSize() {
        return maxSize;
    }

    public synchronized void resize(int maxSize) {
        if (maxSize <= 0) throw new IllegalArgumentException("maxSize <= 0");
        this.maxSize = maxSize;
        trimToSize(maxSize);
    }

    public synchronized Map<K, V> snapshot() {
        return new LinkedHashMap<>(map);
    }

    protected V create(K key) {
        return null;
    }

    protected void entryRemoved(boolean evicted, K key, V oldValue, V newValue) {}

    protected int sizeOf(K key, V value) {
        return 1;
    }

    public synchronized void trimToSize(int maxSize) {
        while (!map.isEmpty() && (maxSize < 0 || safeSize() > maxSize)) {
            Map.Entry<K, V> eldest = map.entrySet().iterator().next();
            K key = eldest.getKey();
            V value = eldest.getValue();
            map.remove(key);
            entryRemoved(true, key, value, null);
        }
    }

    private int safeSize() {
        int total = 0;
        for (Map.Entry<K, V> entry : map.entrySet()) {
            total += Math.max(0, sizeOf(entry.getKey(), entry.getValue()));
        }
        return total;
    }

    @Override
    public synchronized String toString() {
        return "LruCache[maxSize=" + maxSize + ",size=" + safeSize() + "]";
    }
}