package dalvik.system;

public class DexClassLoader extends ClassLoader {
    public DexClassLoader(String dexPath, String optimizedDirectory,
                          String librarySearchPath, ClassLoader parent) {
        super(parent);
    }
}