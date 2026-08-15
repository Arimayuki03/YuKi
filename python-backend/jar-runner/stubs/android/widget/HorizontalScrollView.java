package android.widget;

import android.widget.FrameLayout;
import android.content.Context;
import android.util.AttributeSet;

/** Minimal android.widget.FrameLayout / others common stub. */
public class HorizontalScrollView extends FrameLayout {
    public HorizontalScrollView(Context context) { super(context); }
    public HorizontalScrollView(Context context, AttributeSet attrs) { super(context, attrs); }
    public HorizontalScrollView(Context context, AttributeSet attrs, int defStyleAttr) { super(context, attrs, defStyleAttr); }
    public void setSmoothScrollingEnabled(boolean smoothScrollingEnabled) {}
    public void setFillViewport(boolean fillViewport) {}
    public void setScrollbarFadingEnabled(boolean fadeScrollbars) {}
    public void setOverScrollMode(int mode) {}
    public boolean isSmoothScrollingEnabled() { return false; }
    public void fullScroll() {}
    public void setHorizontalScrollBarEnabled(boolean horizontalScrollBarEnabled) {}
}