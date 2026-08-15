package android.app;

import android.content.ComponentCallbacks;
import android.content.Context;
import android.content.res.Configuration;
import android.os.Bundle;

public class Application extends Context {
    private static Application sApp;

    public Application() { sApp = this; }

    public static Application getApplication() { return sApp; }
    public void onCreate() {}
    public void onTerminate() {}
    public void onConfigurationChanged(Configuration newConfig) {}
    public void onLowMemory() {}
    public void onTrimMemory(int level) {}
    public void registerActivityLifecycleCallbacks(android.app.Application.ActivityLifecycleCallbacks2 cb) {}
    public void unregisterActivityLifecycleCallbacks(android.app.Application.ActivityLifecycleCallbacks2 cb) {}
    public void registerComponentCallbacks(android.app.Application.ComponentCallbacks cb) {}
    public void unregisterComponentCallbacks(android.app.Application.ComponentCallbacks cb) {}

    public interface ActivityLifecycleCallbacks2 {
        void onActivityCreated(Activity activity, android.os.Bundle savedInstanceState);
        void onActivityStarted(Activity activity);
        void onActivityResumed(Activity activity);
        void onActivityPaused(Activity activity);
        void onActivityStopped(Activity activity);
        void onActivitySaveInstanceState(Activity activity, android.os.Bundle outState);
        void onActivityDestroyed(Activity activity);
    }

    public interface ComponentCallbacks {
        void onConfigurationChanged(Configuration newConfig);
        void onLowMemory();
    }
}