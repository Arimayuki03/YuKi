/**
 * 最小测试 spider：在 jar 中被 SpiderRunner 加载。
 * 编译：javac -cp stubs TestSpider.java
 * 打包：jar cf test-spider.jar TestSpider.class
 */
public class TestSpider {
    public void init(String extend) {
        System.err.println("[TestSpider] init: " + extend);
    }

    public String homeContent(boolean filter) {
        return "{\"class\":[{\"type_id\":\"1\",\"type_name\":\"测试分类\"}],\"list\":[{\"vod_id\":\"t-1\",\"vod_name\":\"测试影片\",\"vod_remarks\":\"HD\"}]}";
    }

    public String searchContent(String key, boolean quick, String pg) {
        return "{\"list\":[{\"vod_id\":\"ts-1\",\"vod_name\":\"" + key + "测试结果\"}]}";
    }

    public String detailContent(String[] ids) {
        return "{\"list\":[{\"vod_id\":\"" + ids[0] + "\",\"vod_name\":\"测试详情\",\"vod_play_from\":\"test\",\"vod_play_url\":\"ep1$http://test/v.mp4\"}]}";
    }

    public String playerContent(String flag, String id, String[] vipFlags) {
        return "{\"parse\":0,\"url\":\"" + id + "\",\"header\":{}}";
    }
}