package android.view;

import android.content.Context;
import android.util.AttributeSet;

public class ViewGroup extends View {
    public static class LayoutParams {
        public static final int MATCH_PARENT = -1;
        public static final int WRAP_CONTENT = -2;
        public int width;
        public int height;
        public LayoutParams() { this(MATCH_PARENT, MATCH_PARENT); }
        public LayoutParams(int w, int h) { width = w; height = h; }
        public LayoutParams(LayoutParams source) { width = source.width; height = source.height; }
        public LayoutParams(android.content.Context c, android.util.AttributeSet attrs) {}
    }
    public static class MarginLayoutParams extends LayoutParams {
        public int leftMargin;
        public int topMargin;
        public int rightMargin;
        public int bottomMargin;
        public MarginLayoutParams(int w, int h) { super(w, h); }
        public MarginLayoutParams(LayoutParams source) { super(source); }
        public MarginLayoutParams(android.content.Context c, android.util.AttributeSet attrs) { super(c, attrs); }
        public void setMargins(int l, int t, int r, int b) { leftMargin = l; topMargin = t; rightMargin = r; bottomMargin = b; }
    }
    public ViewGroup(Context context) {}
    public ViewGroup(Context context, android.util.AttributeSet attrs) {}
    public ViewGroup(Context context, android.util.AttributeSet attrs, int defStyleAttr) {}
    public void addView(View child) {}
    public void addView(View child, int index) {}
    public void addView(View child, LayoutParams params) {}
    public void removeView(View child) {}
    public void removeAllViews() {}
    public int getChildCount() { return 0; }
    public View getChildAt(int index) { return null; }
    public void setClipChildren(boolean clip) {}
    public void setClipToPadding(boolean clip) {}
    public void setDescendantFocusability(int f) {}
    public static final int FOCUS_BEFORE_DESCENDANTS = 0;
    public static final int FOCUS_AFTER_DESCENDANTS = 1;
    public static final int FOCUS_BLOCK_DESCENDANTS = 2;
    public int getDescendantFocusability() { return FOCUS_BEFORE_DESCENDANTS; }
    public void setMotionEventSplittingEnabled(boolean split) {}
    public void setChildrenDrawingOrderEnabled(boolean enabled) {}
    public void setChildDrawingOrderCallback(ChildDrawingOrderCallback c) {}
    public interface ChildDrawingOrderCallback { int onGetChildDrawingOrder(int childCount, int i); }
    public void bringChildToFront(View child) {}
    public boolean shouldDelayChildPressedState() { return false; }
    public int indexOfChild(View child) { return -1; }
    public void dispatchSetSelected(boolean selected) {}
}