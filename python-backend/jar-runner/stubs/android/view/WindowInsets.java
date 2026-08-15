package android.view;

public class WindowInsets {
    public static final int TYPE_TOP = 1;
    public static final int TYPE_BOTTOM = 2;
    public static final int TYPE_LEFT = 4;
    public static final int TYPE_RIGHT = 8;
    public static final int TYPE_IME = 16;
    public static final int TYPE_SYSTEM_BARS = 32;
    public static final int TYPE_MANDATORY_SYSTEM_GESTURES = 64;
    public static final int TYPE_TAPPABLE_ELEMENT = 128;
    public static final int TYPE_CAPTION_BAR = 256;
    public WindowInsets(WindowInsets src) {}
    public WindowInsets getInsets(int typeMask) { return this; }
    public WindowInsets getInsetsIgnoringVisibility(int typeMask) { return this; }
    public boolean isVisible(int typeMask) { return false; }
    public boolean show(int typeMask) { return false; }
    public boolean hide(int typeMask) { return false; }
    public int getSystemWindowInsetLeft() { return 0; }
    public int getSystemWindowInsetTop() { return 0; }
    public int getSystemWindowInsetRight() { return 0; }
    public int getSystemWindowInsetBottom() { return 0; }
    public WindowInsets consumeSystemWindowInsets() { return this; }
    public WindowInsets replaceSystemWindowInsets(int left, int top, int right, int bottom) { return this; }
    public WindowInsets consumeStableInsets() { return this; }
    public int getStableInsetTop() { return 0; }
    public int getStableInsetLeft() { return 0; }
    public int getStableInsetRight() { return 0; }
    public int getStableInsetBottom() { return 0; }
    public boolean hasInsets() { return false; }
    public boolean hasSystemWindowInsets() { return false; }
    public boolean hasStableInsets() { return false; }
    public boolean isConsumed() { return false; }
    public boolean isRound() { return false; }
    public int getDisplayCutout() { return 0; }
}