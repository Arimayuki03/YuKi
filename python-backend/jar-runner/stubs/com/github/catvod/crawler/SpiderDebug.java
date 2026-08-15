package com.github.catvod.crawler;

/** Minimal SpiderDebug stub — 供 FongMi 系蜘蛛引用。 */
public class SpiderDebug {
    public static void log(String msg) { System.err.println("[SpiderDebug] " + msg); }

    public static void log(Throwable tr) {
        if (tr != null) tr.printStackTrace(System.err);
    }
}
