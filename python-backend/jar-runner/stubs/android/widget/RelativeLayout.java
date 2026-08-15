package android.widget;

import android.content.Context;
import android.util.AttributeSet;
import android.view.ViewGroup;

/** Minimal android.widget.RelativeLayout stub. */
public class RelativeLayout extends ViewGroup {
    public static final int TRUE = -1;
    public static final int ALIGN_PARENT_TOP = 1 << 12;
    public static final int ALIGN_PARENT_BOTTOM = 1 << 13;
    public static final int ALIGN_PARENT_LEFT = 1 << 14;
    public static final int ALIGN_PARENT_RIGHT = 1 << 15;
    public static final int ALIGN_PARENT_START = 1 << 16;
    public static final int ALIGN_PARENT_END = 1 << 17;
    public static final int CENTER_HORIZONTAL = 1 << 18;
    public static final int CENTER_VERTICAL = 1 << 19;
    public static final int CENTER_IN_PARENT = (CENTER_HORIZONTAL | CENTER_VERTICAL) >>> 1;
    public static final int ALIGN_RIGHT = 2 << 8;
    public static final int ALIGN_LEFT = 3 << 8;
    public static final int ALIGN_TOP = 5 << 8;
    public static final int ALIGN_BOTTOM = 6 << 8;
    public static final int ALIGN_START = 7 << 8;
    public static final int ALIGN_END = 8 << 8;
    public static final int ALIGN_BASELINE = 4 << 8;
    public static final int BELOW = 1 << 8;
    public static final int ABOVE = 0 << 8;
    public static final int LEFT_OF = 4 << 8;
    public static final int RIGHT_OF = 5 << 8;

    public RelativeLayout(Context context) { super(context); }
    public RelativeLayout(Context context, AttributeSet attrs) { super(context, attrs); }
    public RelativeLayout(Context context, AttributeSet attrs, int defStyleAttr) { super(context, attrs, defStyleAttr); }
    public void setGravity(int gravity) {}
    public int getGravity() { return 0; }
    public void setIgnoreGravity(int viewId) {}
    public void setHorizontalGravity(int gravity) {}
    public void setVerticalGravity(int gravity) {}

    public static class LayoutParams extends ViewGroup.MarginLayoutParams {
        public static final int ABOVE = RelativeLayout.ABOVE;
        public static final int BELOW = RelativeLayout.BELOW;
        public static final int ALIGN_RIGHT = RelativeLayout.ALIGN_RIGHT;
        public static final int ALIGN_LEFT = RelativeLayout.ALIGN_LEFT;
        public static final int ALIGN_TOP = RelativeLayout.ALIGN_TOP;
        public static final int ALIGN_BOTTOM = RelativeLayout.ALIGN_BOTTOM;
        public static final int ALIGN_PARENT_LEFT = RelativeLayout.ALIGN_PARENT_LEFT;
        public static final int ALIGN_PARENT_RIGHT = RelativeLayout.ALIGN_PARENT_RIGHT;
        public static final int ALIGN_PARENT_TOP = RelativeLayout.ALIGN_PARENT_TOP;
        public static final int ALIGN_PARENT_BOTTOM = RelativeLayout.ALIGN_PARENT_BOTTOM;
        public static final int CENTER_IN_PARENT = RelativeLayout.CENTER_IN_PARENT;
        public static final int ALIGN_PARENT_START = RelativeLayout.ALIGN_PARENT_START;
        public static final int ALIGN_PARENT_END = RelativeLayout.ALIGN_PARENT_END;
        public static final int ALIGN_END = RelativeLayout.ALIGN_END;
        public static final int ALIGN_START = RelativeLayout.ALIGN_START;
        public static final int ALIGN_BASELINE = RelativeLayout.ALIGN_BASELINE;
        public static final int LEFT_OF = RelativeLayout.LEFT_OF;
        public static final int RIGHT_OF = RelativeLayout.RIGHT_OF;
        public LayoutParams(int w, int h) { super(w, h); }
        public LayoutParams(int w, int h, int anchor) { super(w, h); }
        public LayoutParams(Context c, AttributeSet attrs) { super(c, attrs); }
        public void addRule(int verb) {}
        public void addRule(int verb, int anchor) {}
        public void removeRule(int verb) {}
    }
}