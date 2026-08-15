package android.content.res;

/** android.content.res.Configuration stub。 */
public class Configuration {
    public static final int SCREENLAYOUT_SIZE_MASK = 0x0f;
    public static final int SCREENLAYOUT_SIZE_LARGE = 0x03;
    public static final int SCREENLAYOUT_SIZE_NORMAL = 0x02;
    public static final int SCREENLAYOUT_SIZE_SMALL = 0x01;
    public static final int SCREENLAYOUT_SIZE_XLARGE = 0x04;
    public static final int ORIENTATION_LANDSCAPE = 2;
    public static final int ORIENTATION_PORTRAIT = 1;
    public static final int ORIENTATION_UNDEFINED = 0;
    public static final int UI_MODE_TYPE_NORMAL = 1;
    public static final int UI_MODE_TYPE_TELEVISION = 4;

    public Configuration() {}

    public void setToDefaults() {}
    public int compareTo(Configuration that) { return 0; }
    public boolean equals(Configuration o) { return o != null; }
    public int hashCode() { return 0; }
    public String toString() { return "Configuration{}"; }
}