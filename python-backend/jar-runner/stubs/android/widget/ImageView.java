package android.widget;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;

/** Minimal android.widget.ImageView stub. */
public class ImageView extends View {
    public static final int ScaleType_CENTER = 1;
    public static final int ScaleType_CENTER_CROP = 2;
    public static final int ScaleType_CENTER_INSIDE = 3;
    public static final int FIT_CENTER = 4;
    public static final int FIT_XY = 5;
    public static final int FIT_START = 6;
    public static final int FIT_END = 7;
    public enum ScaleType { CENTER, CENTER_CROP, CENTER_INSIDE, FIT_CENTER, FIT_XY, FIT_START, FIT_END, MATRIX }

    public ImageView(Context context) { super(context); }
    public ImageView(Context context, AttributeSet attrs) { super(context, attrs); }
    public ImageView(Context context, AttributeSet attrs, int defStyleAttr) { super(context, attrs, defStyleAttr); }

    public void setImageResource(int resId) {}
    public void setImageDrawable(android.graphics.drawable.Drawable drawable) {}
    public void setImageBitmap(android.graphics.Bitmap bm) {}
    public void setImageURI(android.net.Uri uri) {}
    public void setScaleType(ScaleType scaleType) {}
    public ScaleType getScaleType() { return ScaleType.CENTER; }
    public void setAdjustViewBounds(boolean adjustViewBounds) {}
    public void setCropToPadding(boolean cropToPadding) {}
    public void setColorFilter(int color) {}
    public void setAlpha(int alpha) {}
    public void setImageTintList(android.content.res.ColorStateList tint) {}
    public void setImageTintMode(android.graphics.PorterDuff.Mode mode) {}
    public void setMaxWidth(int maxWidth) { /* View has no setMaxWidth */ }
    public void setMaxHeight(int maxHeight) {
        // 没有对应父方法，忽略
    }
}