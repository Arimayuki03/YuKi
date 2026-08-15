package android.graphics;

/** Minimal Bitmap stub。 */
public class Bitmap {
    public static Bitmap createBitmap(int width, int height, Bitmap.Config config) { return new Bitmap(); }
    public static class Config {
        public static final Config ARGB_8888 = new Config();
        public static final Config RGB_565 = new Config();
    }
}