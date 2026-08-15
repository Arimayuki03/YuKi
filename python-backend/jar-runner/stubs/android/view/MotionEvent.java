package android.view;

public class MotionEvent {
    public static final int ACTION_DOWN = 0;
    public static final int ACTION_UP = 1;
    public static final int ACTION_MOVE = 2;
    public static final int ACTION_CANCEL = 3;
    public static final int ACTION_OUTSIDE = 4;
    public static final long getEventTime() { return 0; }
    public float getX() { return 0; }
    public float getY() { return 0; }
    public int getAction() { return 0; }
    public int getPointerCount() { return 0; }
    public void recycle() {}
}