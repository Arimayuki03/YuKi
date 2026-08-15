package android.os;

public class Handler {
    private Looper mLooper;

    public Handler() { mLooper = Looper.myLooper(); }
    public Handler(Looper looper) { mLooper = looper; }
    public Handler(Looper looper, Callback callback) { mLooper = looper; }

    public interface Callback {
        boolean handleMessage(Message msg);
    }

    public void handleMessage(Message msg) {}
    public void dispatchMessage(Message msg) { handleMessage(msg); }

    public boolean sendMessage(Message msg) { return sendMessageDelayed(msg, 0); }
    public boolean sendEmptyMessage(int what) { return sendEmptyMessageDelayed(what, 0); }
    public boolean sendEmptyMessageDelayed(int what, long delayMillis) {
        Message m = new Message();
        m.what = what;
        return sendMessageDelayed(m, delayMillis);
    }
    public boolean sendMessageDelayed(Message msg, long delayMillis) {
        msg.setTarget(this);
        return true;
    }
    public boolean sendMessageAtFrontOfQueue(Message msg) {
        msg.setTarget(this);
        return true;
    }
    public boolean post(Runnable r) { if (r != null) r.run(); return true; }
    public boolean postDelayed(Runnable r, long delayMillis) { if (r != null) r.run(); return true; }
    public boolean postAtFrontOfQueue(Runnable r) { if (r != null) r.run(); return true; }
    public void removeCallbacks(Runnable r) {}
    public void removeMessages(int what) {}
    public void removeCallbacksAndMessages(Object token) {}
    public Looper getLooper() { return mLooper; }
    public static Handler createAsync(Looper looper) { return new Handler(looper); }
}