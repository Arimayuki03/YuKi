package com.github.catvod.spider;

import android.content.Context;

/** Compatibility alias used by a few FongMi-era spiders. */
public final class Init {
    private Init() {}

    public static void set(Context context) {
        com.github.catvod.Init.set(context);
    }

    public static void init(Context context) {
        com.github.catvod.Init.set(context);
    }

    public static Context context() {
        return com.github.catvod.Init.context();
    }
}
