package android.view;

public class KeyEvent {
    public static final int ACTION_DOWN = 0;
    public static final int ACTION_UP = 1;
    public static final int KEYCODE_BACK = 4;
    public static final int KEYCODE_DPAD_LEFT = 21;
    public static final int KEYCODE_DPAD_RIGHT = 22;
    public static final int KEYCODE_DPAD_UP = 19;
    public static final int KEYCODE_DPAD_DOWN = 20;
    public static final int KEYCODE_ENTER = 66;
    public static final int KEYCODE_MENU = 82;
    public static final int KEYCODE_HOME = 3;
    public static final int KEYCODE_VOLUME_UP = 24;
    public static final int KEYCODE_VOLUME_DOWN = 25;
    public static final int META_SHIFT_ON = 1;
    public KeyEvent(int action, int code) {}
    public KeyEvent(long downTime, long eventTime, int action, int code, int repeat) {}
    public int getAction() { return 0; }
    public int getKeyCode() { return 0; }
    public boolean isLongPress() { return false; }
    public boolean isCanceled() { return false; }
    public int getRepeatCount() { return 0; }
    public long getEventTime() { return 0; }
    public long getDownTime() { return 0; }
    public static KeyEvent changeTimeRepeat(KeyEvent event, long eventTime, int newRepeat) { return event; }
    public static KeyEvent obtain(long downTime, long eventTime, int action, int code, int repeat) { return new KeyEvent(downTime, eventTime, action, code, repeat); }
    public void recycle() {}
}