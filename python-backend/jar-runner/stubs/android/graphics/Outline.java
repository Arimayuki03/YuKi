package android.graphics;

public class Outline {
    public static final int MODE_CONVEX_PATH = 2;
    public static final int MODE_EMPTY = 0;
    public static final int MODE_ROUND_RECT = 1;
    public Outline() {}
    public Outline(Outline src) {}
    public void setEmpty() {}
    public void setRoundRect(int left, int top, int right, int bottom, float radius) {}
    public void setConvexPath(Object path) {}
    public void setOval(int left, int top, int right, int bottom) {}
    public void setAlpha(float alpha) {}
    public float getAlpha() { return 1; }
    public boolean isEmpty() { return false; }
    public boolean canClip() { return false; }
    public void offset(int dx, int dy) {}
    public int getMode() { return MODE_ROUND_RECT; }
}