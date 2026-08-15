package android.os;

public class Looper {
    static final ThreadLocal<Looper> sThreadLocal = new ThreadLocal<>();
    private static Looper sMainLooper;

    public static void prepare() {
        if (sThreadLocal.get() != null) throw new RuntimeException("Only one Looper may be created per thread");
        sThreadLocal.set(new Looper());
    }

    public static void prepareMainLooper() {
        prepare();
        sMainLooper = myLooper();
    }

    public static Looper getMainLooper() {
        if (sMainLooper == null) prepareMainLooper();
        return sMainLooper;
    }

    public static Looper myLooper() {
        return sThreadLocal.get();
    }

    public static void loop() {}

    public void quit() {}
    public void quitSafely() {}
    public Thread getThread() { return Thread.currentThread(); }
    public boolean isCurrentThread() { return true; }
}