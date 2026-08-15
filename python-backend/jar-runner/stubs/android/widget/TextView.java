package android.widget;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;

/** Minimal android.widget.TextView stub. */
public class TextView extends View {
    public TextView(Context context) { super(context); }
    public TextView(Context context, AttributeSet attrs) { super(context, attrs); }
    public TextView(Context context, AttributeSet attrs, int defStyleAttr) { super(context, attrs, defStyleAttr); }

    public void setText(CharSequence text) {}
    public void setText(int resid) {}
    public CharSequence getText() { return ""; }
    public void setTextSize(float size) {}
    public void setTextSize(int unit, float size) {}
    public void setTextColor(int color) {}
    public void setGravity(int gravity) {}
    public void setSingleLine(boolean singleLine) {}
    public void setMaxLines(int maxLines) {}
    public void setMinLines(int minLines) {}
    public void setLines(int lines) {}
    public void setEllipsize(Object where) {}
    public void setCompoundDrawablesWithIntrinsicBounds(int left, int top, int right, int bottom) {}
    public void setCompoundDrawablePadding(int pad) {}
    public void setPadding(int left, int top, int right, int bottom) { /* View has no setPadding */ }
    public void setIncludeFontPadding(boolean includeFontPadding) {}
    public void setTypeface(Object typeface) {}
    public void setTypeface(Object typeface, int style) {}
    public void setMaxWidth(int maxWidth) {}
    public void setMinWidth(int minWidth) {}
    public void setWidth(int pixels) {}
    public void setHeight(int pixels) {}
    public void setHighlightColor(int color) {}
    public void setBreakStrategy(int strategy) {}
    public int getHighlightColor() { return 0; }
    public void setLetterSpacing(float spacing) {}
    public void setLineSpacing(float add, float mult) {}
    public void setHorizontallyScrolling(boolean whether) {}
    public void marqueeStart(int m) {}
    public void setAutoLinkMask(int mask) {}
    public void setLinksClickable(boolean clickable) {}
    public void setMovementMethod(Object movement) {}
    public void setTextIsSelectable(boolean selectable) {}
    public void setEms(int ems) {}
    public void setSelectAllOnFocus(boolean selectAllOnFocus) {}
}