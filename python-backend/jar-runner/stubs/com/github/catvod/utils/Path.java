package com.github.catvod.utils;

import android.os.Environment;
import com.github.catvod.Init;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** File/cache paths mapped to the private PC JVM cache directory. */
public final class Path {
    private Path() {}

    private static File mkdir(File file) {
        if (file != null && !file.exists()) file.mkdirs();
        return file;
    }

    public static boolean exists(String path) { return path != null && new File(path.replace("file://", "")).exists(); }
    public static boolean exists(File file) { return file != null && file.exists() && (file.isDirectory() || file.length() > 0); }
    public static File root() { return Environment.getExternalStorageDirectory(); }
    public static File cache() { return mkdir(Init.context().getCacheDir()); }
    public static File files() { return mkdir(Init.context().getFilesDir()); }
    public static String rootPath() { return root().getAbsolutePath(); }
    public static File tv() { return mkdir(new File(root(), "TV")); }
    public static File so() { return mkdir(new File(files(), "so")); }
    public static File js() { return mkdir(new File(cache(), "js")); }
    public static File py() { return mkdir(new File(cache(), "py")); }
    public static File jar() { return mkdir(new File(cache(), "jar")); }
    public static File exoCache() { return mkdir(new File(cache(), "exo")); }
    public static File mpvCache() { return mkdir(new File(cache(), "mpv")); }
    public static File mpv() { return mkdir(new File(tv(), "mpv")); }
    public static File epg() { return mkdir(new File(cache(), "epg")); }
    public static File jpa() { return mkdir(new File(cache(), "jpa")); }
    public static File thunder() { return mkdir(new File(cache(), "thunder")); }
    public static File root(String name) { return new File(root(), name); }
    public static File root(String child, String name) { return new File(mkdir(new File(root(), child)), name); }
    public static File cache(String name) { return new File(cache(), name); }
    public static File files(String name) { return new File(files(), name); }
    public static File mpv(String name) { return new File(mpv(), name); }
    public static File epg(String name) { return new File(epg(), name); }
    public static File js(String name) { return new File(js(), name); }
    public static File py(String name) { return new File(py(), name); }
    public static File jar(String name) { return new File(jar(), Util.md5(name) + ".jar"); }
    public static File thunder(String name) { return mkdir(new File(thunder(), name)); }

    public static File local(String path) {
        String value = path == null ? "" : path.replace("file:/", "");
        File rooted = new File(root(), value);
        return rooted.exists() ? rooted : new File(value);
    }

    public static String read(File file) { return new String(readToByte(file), StandardCharsets.UTF_8); }
    public static String read(InputStream in) {
        try { return new String(readToByte(in), StandardCharsets.UTF_8); }
        catch (Throwable ignored) { return ""; }
    }
    public static byte[] readToByte(File file) {
        try (FileInputStream in = new FileInputStream(file)) { return readToByte(in); }
        catch (Throwable ignored) { return new byte[0]; }
    }
    private static byte[] readToByte(InputStream in) throws IOException {
        try (InputStream source = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384];
            int n;
            while ((n = source.read(buffer)) >= 0) if (n > 0) out.write(buffer, 0, n);
            return out.toByteArray();
        }
    }
    public static File write(File file, InputStream in) {
        try (InputStream source = in; FileOutputStream out = new FileOutputStream(create(file))) {
            byte[] buffer = new byte[16384]; int n;
            while ((n = source.read(buffer)) >= 0) if (n > 0) out.write(buffer, 0, n);
        } catch (Throwable ignored) {}
        return file;
    }
    public static File write(File file, byte[] data) {
        try (FileOutputStream out = new FileOutputStream(create(file))) { out.write(data); }
        catch (Throwable ignored) {}
        return file;
    }
    public static void move(File in, File out) { if (!in.renameTo(out)) { copy(in, out); clear(in); } }
    public static void copy(File in, File out) { try { copy(new FileInputStream(in), out); } catch (Throwable ignored) {} }
    public static void copy(InputStream in, File out) {
        try (InputStream source = in; FileOutputStream target = new FileOutputStream(create(out))) {
            byte[] buffer = new byte[16384]; int n;
            while ((n = source.read(buffer)) >= 0) if (n > 0) target.write(buffer, 0, n);
        } catch (Throwable ignored) {}
    }
    public static void sort(File[] files) {
        if (files != null) Arrays.sort(files, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
    }
    public static List<File> list(File dir) {
        File[] files = dir == null ? null : dir.listFiles();
        sort(files);
        return files == null ? new ArrayList<>() : Arrays.asList(files);
    }
    public static void clear(File file) {
        if (file == null) return;
        if (file.isDirectory()) for (File child : list(file)) clear(child);
        file.delete();
    }
    public static File create(File file) {
        if (file == null) return null;
        File parent = file.getParentFile();
        if (parent != null) parent.mkdirs();
        if (file.exists()) clear(file);
        try { file.createNewFile(); } catch (IOException ignored) {}
        return file;
    }
}
