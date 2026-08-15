package android.util;

import java.util.HashMap;

public class SparseArray<E> {
    private final HashMap<Integer, E> map = new HashMap<>();

    public SparseArray() {}
    public SparseArray(int initialCapacity) {}

    public E get(int key) { return map.get(key); }
    public E get(int key, E valueIfKeyNotFound) { return map.containsKey(key) ? map.get(key) : valueIfKeyNotFound; }
    public void put(int key, E value) { map.put(key, value); }
    public void append(int key, E value) { map.put(key, value); }
    public int indexOfKey(int key) { return map.containsKey(key) ? key : -1; }
    public int indexOfValue(E value) { return map.containsValue(value) ? 1 : -1; }
    public void delete(int key) { map.remove(key); }
    public void remove(int key) { map.remove(key); }
    public void removeAt(int index) { if (index >= 0 && index < map.size()) map.clear(); }
    public void clear() { map.clear(); }
    public int size() { return map.size(); }
    public int keyAt(int index) { return (int) map.keySet().toArray()[Math.max(0, Math.min(index, map.size()-1))]; }
    public E valueAt(int index) { return map.get(keyAt(index)); }
    public void setValueAt(int index, E value) { map.put(keyAt(index), value); }
    public int hashCode() { return map.hashCode(); }
    public boolean equals(Object o) { return o instanceof SparseArray && map.equals(((SparseArray)o).map); }
}