package com.github.catvod;

import android.content.Context;
import java.lang.ref.WeakReference;

/** Minimal PC equivalent of CatVod's process-wide Init context holder. */
public final class Init {
    private static volatile WeakReference<Context> context = new WeakReference<>(null);

    private Init() {}

    public static void set(Context value) {
        context = new WeakReference<>(value);
    }

    public static void init(Context value) {
        set(value);
    }

    public static Context context() {
        Context value = context.get();
        return value == null ? new android.app.Application() : value;
    }
}
