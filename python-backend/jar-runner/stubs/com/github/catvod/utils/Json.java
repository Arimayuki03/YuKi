package com.github.catvod.utils;

import android.text.TextUtils;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Small Gson-backed subset of the CatVod Json helper used by spiders. */
public final class Json {
    private Json() {}

    public static JsonElement parse(String text) {
        try {
            return JsonParser.parseString(text);
        } catch (Throwable first) {
            try { return new JsonParser().parse(text); }
            catch (Throwable ignored) { return com.google.gson.JsonNull.INSTANCE; }
        }
    }

    public static boolean isObj(String text) {
        try { return !TextUtils.isEmpty(text) && new JSONObject(text).length() >= 0; }
        catch (Throwable ignored) { return false; }
    }

    public static boolean isArray(String text) {
        try { return !TextUtils.isEmpty(text) && new JSONArray(text).length() >= 0; }
        catch (Throwable ignored) { return false; }
    }

    public static boolean isEmpty(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) return true;
        JsonElement value = object.get(key);
        if (value.isJsonArray()) return value.getAsJsonArray().size() == 0;
        if (value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()) {
            return value.getAsString().trim().isEmpty();
        }
        return false;
    }

    public static String safeString(JsonObject object, String key) {
        try { return object.getAsJsonPrimitive(key).getAsString().trim(); }
        catch (Throwable ignored) { return ""; }
    }

    public static List<String> safeListString(JsonObject object, String key) {
        List<String> result = new ArrayList<>();
        if (object == null || !object.has(key)) return result;
        try {
            if (object.get(key).isJsonObject()) result.add(safeString(object, key));
            else for (JsonElement item : object.getAsJsonArray(key)) result.add(item.getAsString());
        } catch (Throwable ignored) {}
        return result;
    }

    public static List<JsonElement> safeListElement(JsonObject object, String key) {
        List<JsonElement> result = new ArrayList<>();
        if (object == null || !object.has(key)) return result;
        try {
            if (object.get(key).isJsonObject()) result.add(object.get(key));
            else for (JsonElement item : object.getAsJsonArray(key)) result.add(item);
        } catch (Throwable ignored) {}
        return result;
    }

    public static JsonObject safeObject(JsonElement element) {
        try {
            if (element != null && element.isJsonPrimitive()) element = parse(element.getAsString());
            return element == null ? new JsonObject() : element.getAsJsonObject();
        } catch (Throwable ignored) { return new JsonObject(); }
    }

    public static Map<String, String> toMap(String text) {
        return TextUtils.isEmpty(text) ? null : toMap(parse(text));
    }

    public static Map<String, String> toMap(JsonElement element) {
        Map<String, String> result = new HashMap<>();
        JsonObject object = safeObject(element);
        for (Map.Entry<String, JsonElement> entry : object.entrySet()) {
            result.put(entry.getKey(), safeString(object, entry.getKey()));
        }
        return result;
    }
}
