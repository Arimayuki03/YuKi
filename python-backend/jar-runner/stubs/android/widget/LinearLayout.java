package android.widget;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import android.view.ViewGroup;

/** Minimal android.widget.LinearLayout stub. */
public class LinearLayout extends ViewGroup {
    public static final int HORIZONTAL = 0;
    public static final int VERTICAL = 1;
    public static final int SHOW_DIVIDER_NONE = 0;
    public static final int SHOW_DIVIDER_MIDDLE = 1;
    public static final int SHOW_DIVIDER_START = 2;
    public static final int SHOW_DIVIDER_END = 4;

    private int orientation = HORIZONTAL;

    public LinearLayout(Context context) { super(context); }
    public LinearLayout(Context context, AttributeSet attrs) { super(context, attrs); }
    public LinearLayout(Context context, AttributeSet attrs, int defStyleAttr) { super(context, attrs, defStyleAttr); }

    public void setOrientation(int orientation) { this.orientation = orientation; }
    public int getOrientation() { return orientation; }
    public void setGravity(int gravity) {}
    public int getGravity() { return 0; }
    public void setBaselineAligned(boolean aligned) {}
    public void setWeightSum(float weightSum) {}
    public float getWeightSum() { return 0; }
    public void setDividerDrawable(android.graphics.drawable.Drawable d) {}
    public void setShowDividers(int showDividers) {}
    public int getShowDividers() { return 0; }
    public void setDividerPadding(int padding) {}
    public void setHorizontalGravity(int gravity) {}
    public void setVerticalGravity(int gravity) {}
    public static int getOrientation(Context context, AttributeSet attrs) { return HORIZONTAL; }
}