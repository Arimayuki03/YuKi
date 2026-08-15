package android.content;

public class ComponentName {
    private final String mPackage;
    private final String mClass;

    public ComponentName(String pkg, String cls) { mPackage = pkg; mClass = cls; }
    public ComponentName(android.content.Context pkg, String cls) { mPackage = pkg.getPackageName(); mClass = cls; }

    public String getPackageName() { return mPackage; }
    public String getClassName() { return mClass; }
    public String getShortClassName() {
        if (mClass != null && mClass.startsWith(mPackage + ".")) return mClass.substring(mPackage.length());
        return mClass;
    }
    public static ComponentName unflattenFromString(String flattened) {
        if (flattened == null) return null;
        int i = flattened.indexOf('/');
        if (i < 0) return null;
        return new ComponentName(flattened.substring(0, i), flattened.substring(i + 1));
    }
    public String flattenToString() { return mPackage + "/" + mClass; }
    public String flattenToShortString() { return flattenToString(); }
    public android.content.Intent toIntent() { Intent i = new Intent(); i.setComponent(this); return i; }
    @Override
    public String toString() { return "ComponentInfo{" + mPackage + "/" + mClass + "}"; }
    @Override
    public boolean equals(Object o) { return o instanceof ComponentName && toString().equals(o.toString()); }
    @Override
    public int hashCode() { return toString().hashCode(); }
}