public class SupervisorSpider {
    public void init(String extend) {
        if ("error".equals(extend)) throw new IllegalStateException("fixture init error");
    }

    public String homeContent(boolean filter) {
        if (filter) {
            for (;;) {
                try { Thread.sleep(1000L); } catch (InterruptedException ignored) {}
            }
        }
        return "{\"class\":[],\"list\":[{\"vod_id\":\"jar-ok\",\"vod_name\":\"JAR healthy\"}]}";
    }

    public String searchContent(String key, boolean quick, String pg) {
        if ("error".equals(key)) throw new IllegalStateException("fixture jar error");
        if ("crash".equals(key)) Runtime.getRuntime().halt(86);
        if ("slow".equals(key)) {
            try { Thread.sleep(60000L); } catch (InterruptedException ignored) {}
        }
        return "{\"list\":[{\"vod_id\":\"jar-search\",\"vod_name\":\"" + key + "\"}]}";
    }

    public String detailContent(String[] ids) {
        return "{\"list\":[]}";
    }

    public String playerContent(String flag, String id, String[] vipFlags) {
        return "{\"parse\":0,\"url\":\"" + id + "\"}";
    }
}
