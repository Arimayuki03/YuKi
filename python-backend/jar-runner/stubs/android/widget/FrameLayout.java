package android.widget;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewGroup;

/** Minimal android.widget.FrameLayout stub. */
public class FrameLayout extends ViewGroup {
    public static final int GRAVITY_TOP = 0x30;
    public static final int GRAVITY_BOTTOM = 0x50;
    public static final int GRAVITY_LEFT = 0x03;
    public static final int GRAVITY_RIGHT = 0x05;
    public static final int GRAVITY_CENTER_VERTICAL = 0x10;
    public static final int GRAVITY_CENTER_HORIZONTAL = 0x01;
    public static final int GRAVITY_CENTER = 0x11;

    public FrameLayout(Context context) { super(context); }
    public FrameLayout(Context context, AttributeSet attrs) { super(context, attrs); }
    public FrameLayout(Context context, AttributeSet attrs, int defStyleAttr) { super(context, attrs, defStyleAttr); }
    public void setForegroundGravity(int gravity) {}
    public void setMeasureAllChildren(boolean measureAll) {}
    public boolean getConsiderGoneChildrenWhenMeasuring() { return false; }
    public void setPaddingRelative(int start, int top, int end, int bottom) {}
    public static class LayoutParams extends ViewGroup.MarginLayoutParams {
        public int gravity = -1;
        public LayoutParams(int w, int h) { super(w, h); }
        public LayoutParams(int w, int h, int gravity) { super(w, h); this.gravity = gravity; }
        public LayoutParams(Context c, AttributeSet attrs) { super(c, attrs); }
    }
}