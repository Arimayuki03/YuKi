package android.os;

/** Hand-written stub for android.os.SystemClock (real implementations). */
public class SystemClock {
    public static void sleep(long ms) {
        if (ms <= 0) return;
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
    public static long uptimeMillis() {
        return System.currentTimeMillis();
    }
    public static long elapsedRealtime() {
        return System.nanoTime() / 1000000L;
    }
    public static long currentThreadTimeMillis() {
        return System.nanoTime() / 1000000L;
    }
}
