package android.content;

import android.content.res.Configuration;

/** android.content.ComponentCallbacks stub。 */
public interface ComponentCallbacks {
    void onConfigurationChanged(Configuration newConfig);
    void onLowMemory();
}