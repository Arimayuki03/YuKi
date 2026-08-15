package android.view;

import android.content.Context;
import android.graphics.Outline;
import android.graphics.PorterDuff;
import android.util.AttributeSet;
import android.content.res.ColorStateList;

/** Minimal android.view.View stub — 仅提供签名，供 TVBox spider 类加载时引用解析。 */
public class View {
    public static final int VISIBLE = 0;
    public static final int INVISIBLE = 4;
    public static final int GONE = 8;
    public static final int NO_ID = -1;
    public static final int[] EMPTY_STATE_SET = {};
    public static final int MEASURED_STATE_MASK = 0xff000000;
    public static final int MEASURED_HEIGHT_STATE_SHIFT = 16;
    public static final int SCROLLBARS_INSIDE_OVERLAY = 0;
    public static final int SCROLLBARS_INSIDE_INSET = 1;
    public static final int SCROLLBARS_OUTSIDE_OVERLAY = 2;
    public static final int SCROLLBARS_OUTSIDE_INSET = 3;
    public static final int KEEP_SCREEN_ON = 4194304;
    public static final int LAYER_TYPE_NONE = 0;
    public static final int LAYER_TYPE_SOFTWARE = 1;
    public static final int LAYER_TYPE_HARDWARE = 2;

    protected View() {}

    public View(android.content.Context context) {}
    public View(android.content.Context context, android.util.AttributeSet attrs) {}
    public View(android.content.Context context, android.util.AttributeSet attrs, int defStyleAttr) {}

    public int getId() { return NO_ID; }
    public void setId(int id) {}
    public Context getContext() { return null; }
    public void setVisibility(int visibility) {}
    public int getVisibility() { return VISIBLE; }
    public void setTag(Object tag) {}
    public Object getTag() { return null; }
    public void setTag(int key, Object tag) {}
    public Object getTag(int key) { return null; }
    public void setOnClickListener(OnClickListener l) {}
    public void setOnLongClickListener(OnLongClickListener l) {}
    public void setOnTouchListener(OnTouchListener l) {}
    public void setOnKeyListener(OnKeyListener l) {}
    public void setOnFocusChangeListener(OnFocusChangeListener l) {}
    public void setBackgroundColor(int color) {}
    public void setBackgroundDrawable(android.graphics.drawable.Drawable d) {}
    public void setPadding(int left, int top, int right, int bottom) {}
    public void layout(int l, int t, int r, int b) {}
    public void measure(int widthMeasureSpec, int heightMeasureSpec) {}
    public int getMeasuredWidth() { return 0; }
    public int getMeasuredHeight() { return 0; }
    public void invalidate() {}
    public void post(Runnable action) { action.run(); }
    public boolean postDelayed(Runnable action, long delayMillis) { return true; }
    public void removeCallbacks(Runnable action) {}
    public void setLayoutParams(android.view.ViewGroup.LayoutParams params) {}
    public android.view.ViewGroup.LayoutParams getLayoutParams() { return null; }
    public void requestLayout() {}
    public void setEnabled(boolean enabled) {}
    public boolean isEnabled() { return true; }
    public boolean isClickable() { return false; }
    public boolean isLongClickable() { return false; }
    public boolean isFocusable() { return false; }
    public boolean performClick() { return false; }
    public boolean performLongClick() { return false; }
    public void setSelected(boolean selected) {}
    public boolean isSelected() { return false; }
    public void bringToFront() {}
    public void setElevation(float elevation) {}
    public float getElevation() { return 0; }
    public void setTranslationX(float x) {}
    public void setTranslationY(float y) {}
    public void setAlpha(float alpha) {}
    public float getAlpha() { return 1; }
    public void setScaleX(float x) {}
    public void setScaleY(float y) {}
    public void setRotation(float r) {}
    public void setPivotX(float x) {}
    public void setPivotY(float y) {}
    public void scrollTo(int x, int y) {}
    public void scrollBy(int x, int y) {}
    public int getScrollX() { return 0; }
    public int getScrollY() { return 0; }
    public void setMinimumWidth(int w) {}
    public void setMinimumHeight(int h) {}
    public int getWidth() { return 0; }
    public int getHeight() { return 0; }
    public int getLeft() { return 0; }
    public int getRight() { return 0; }
    public int getTop() { return 0; }
    public int getBottom() { return 0; }
    public float getX() { return 0; }
    public float getY() { return 0; }
    public void setOnScrollChangeListener(OnScrollChangeListener l) {}
    public void setOnSystemUiVisibilityChangeListener(OnSystemUiVisibilityChangeListener l) {}
    public void setOnApplyWindowInsetsListener(OnApplyWindowInsetsListener l) {}
    public void setClipToOutline(boolean clip) {}
    public void setOutlineProvider(OutlineProvider provider) {}
    public void setZ(float z) {}
    public float getZ() { return 0; }
    public void setForeground(android.graphics.drawable.Drawable d) {}
    public void setForegroundGravity(int gravity) {}
    public void setBackgroundTintList(android.content.res.ColorStateList tint) {}
    public void setBackgroundTintMode(android.graphics.PorterDuff.Mode mode) {}

    public interface OnClickListener { void onClick(View v); }
    public interface OnLongClickListener { boolean onLongClick(View v); }
    public interface OnTouchListener { boolean onTouch(View v, MotionEvent event); }
    public interface OnKeyListener { boolean onKey(View v, int keyCode, KeyEvent event); }
    public interface OnFocusChangeListener { void onFocusChange(View v, boolean hasFocus); }
    public interface OnScrollChangeListener { void onScrollChange(View v, int scrollX, int scrollY, int oldScrollX, int oldScrollY); }
    public interface OnSystemUiVisibilityChangeListener { void onSystemUiVisibilityChange(int visibility); }
    public interface OnApplyWindowInsetsListener { WindowInsets onApplyWindowInsets(View v, WindowInsets insets); }
    public static class OutlineProvider {
        public void getOutline(View view, Outline outline) {}
    }
}