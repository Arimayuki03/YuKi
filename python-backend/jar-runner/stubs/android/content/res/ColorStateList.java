package android.content.res;

/** Minimal android.content.res.ColorStateList stub. */
public class ColorStateList {
    public ColorStateList(int[][] states, int[] colors) {}
    public static ColorStateList valueOf(int color) { return new ColorStateList(null, null); }
    public int getDefaultColor() { return 0; }
    public boolean isStateful() { return false; }
    public int getColorForState(int[] stateSet, int defaultColor) { return defaultColor; }
    public ColorStateList withAlpha(int alpha) { return this; }
    public static ColorStateList createFromXml(Resources r, XmlResourceParser parser) throws Exception { return null; }
}