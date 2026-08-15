package android.os;

public class Message {
    public int what;
    public int arg1;
    public int arg2;
    public Object obj;
    public Bundle data;
    public Handler target;
    private Runnable callback;

    public Message() {}

    public static Message obtain() { return new Message(); }
    public static Message obtain(Handler h) { Message m = new Message(); m.target = h; return m; }
    public static Message obtain(Handler h, int what) { Message m = obtain(h); m.what = what; return m; }
    public static Message obtain(Handler h, Runnable callback) { Message m = obtain(h); m.callback = callback; return m; }
    public static Message obtain(Handler h, int what, Object obj) { Message m = obtain(h); m.what = what; m.obj = obj; return m; }
    public static Message obtain(Handler h, int what, int arg1, int arg2) { Message m = obtain(h); m.what = what; m.arg1 = arg1; m.arg2 = arg2; return m; }
    public static Message obtain(Handler h, int what, int arg1, int arg2, Object obj) { Message m = obtain(h); m.what = what; m.arg1 = arg1; m.arg2 = arg2; m.obj = obj; return m; }
    public static Message obtain(Message orig) { Message m = new Message(); m.what = orig.what; m.arg1 = orig.arg1; m.arg2 = orig.arg2; m.obj = orig.obj; m.target = orig.target; return m; }

    public void sendToTarget() { if (target != null) target.sendMessage(this); }
    public void setTarget(Handler h) { target = h; }
    public Handler getTarget() { return target; }
    public void setData(Bundle d) { data = d; }
    public Bundle getData() { return data; }
    public void recycle() {}
    public long getWhen() { return 0; }
    public void copyFrom(Message o) { what = o.what; arg1 = o.arg1; arg2 = o.arg2; obj = o.obj; }
    public Runnable getCallback() { return callback; }
}