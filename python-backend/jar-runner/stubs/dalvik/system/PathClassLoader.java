package dalvik.system;

public class PathClassLoader extends ClassLoader {
    public PathClassLoader(String path, ClassLoader parent) {
        super(parent);
    }

    public PathClassLoader(String path, String librarySearchPath, ClassLoader parent) {
        super(parent);
    }
}