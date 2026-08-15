package android.os;

public class HandlerThread extends Thread {
    private Looper mLooper;
    private final int mPriority;

    public HandlerThread(String name) { this(name, android.os.Process.THREAD_PRIORITY_DEFAULT); }
    public HandlerThread(String name, int priority) { super(name); mPriority = priority; }

    protected void onLooperPrepared() {}

    @Override
    public void run() {
        Looper.prepare();
        synchronized (this) { mLooper = Looper.myLooper(); notifyAll(); }
        onLooperPrepared();
        Looper.loop();
    }

    public Looper getLooper() {
        if (!isAlive()) return null;
        synchronized (this) {
            while (isAlive() && mLooper == null) { try { wait(); } catch (InterruptedException e) {} }
        }
        return mLooper;
    }

    public boolean quit() {
        Looper l = getLooper();
        if (l != null) l.quit();
        return true;
    }

    public boolean quitSafely() { return quit(); }
    public int getThreadId() { return (int) getId(); }
}