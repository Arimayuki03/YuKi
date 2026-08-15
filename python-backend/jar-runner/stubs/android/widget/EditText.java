package android.widget;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;

/** Minimal android.widget.EditText stub. */
public class EditText extends TextView {
    public EditText(Context context) { super(context); }
    public EditText(Context context, AttributeSet attrs) { super(context, attrs); }
    public EditText(Context context, AttributeSet attrs, int defStyleAttr) { super(context, attrs, defStyleAttr); }

    public void setHint(CharSequence hint) {}
    public void setHint(int resid) {}
    public CharSequence getHint() { return ""; }
    public void setInputType(int type) {}
    public int getInputType() { return 0; }
    public void setSelection(int index) {}
    public void setSelection(int start, int stop) {}
    public void setCursorVisible(boolean visible) {}
    public void setSelectAllOnFocus(boolean selectAllOnFocus) {}
    public void setLines(int lines) {}
    public void setMaxLength(int maxLength) {}
    public boolean onPreDraw() { return true; }
    public void setImeOptions(int imeOptions) {}
    public void setRawInputType(int type) {}
    public void setCompoundDrawablePadding(int pad) {}
    public void setPadding(int left, int top, int right, int bottom) {}
}