# Kazumi 规则引擎

> 整合说明 v1.4 (2026-08-09) + 差距分析 v2.2 (基于 Kazumi v2.2.6)
> 前置：PROGRESS.md + ARCHITECTURE.md

---

## 第一部分：整合说明


> - 鐗堟湰锛歷1.4锛?026-08-09锛?
> - 鐩爣锛氳鏄?Kazumi XPath/API 瑙勫垯寮曟搸鍦ㄥ奖瑙?PC 涓殑褰撳墠瀹炵幇锛屼笉鐮村潖鐜版湁 CatVod 閰嶇疆閾捐矾銆?
> - 鍓嶇疆鏂囨。锛氬厛璇?[褰撳墠寮€鍙戠姸鎬乚(../PROGRESS.md) 鍜?[绯荤粺鏋舵瀯](ARCHITECTURE.md)銆?
> - Git 鍩虹嚎锛歵ag `pre-kazumi`锛坈ommit 4269bc4锛夈€?
> - 鐘舵€侊細**鏃㈠畾 Kazumi 鎺ュ叆鑼冨洿宸插畬鎴愬苟閫氳繃娴嬭瘯**銆傝繖涓嶈〃绀哄奖瑙?PC 宸蹭笌 Kazumi Flutter 鍘熺増瀹屽叏绛変环锛屽樊璺濊 [KAZUMI.md#差距](KAZUMI.md#差距)銆?

---

## 1. 鏁村悎鐩爣涓庤竟鐣?

### 1.1 宸插畬鎴愮殑鎺ュ叆鑼冨洿
- 鏀寔 Kazumi 瑙勫垯 JSON锛圥lugin schema锛宎pi 灏忎簬绛変簬 8锛夌殑瀵煎叆銆佷繚瀛樸€佸垪琛ㄣ€佸垹闄ゃ€佸惎鐢ㄧ鐢ㄣ€?
- 瑙勫垯涓ょ妯″紡锛歺path锛? 鏉?XPath 閫夋嫨鍣級涓?api锛圝SONPath 妯℃澘锛夈€?
- 鑱氬悎鎼滅储锛欿azumi 瑙勫垯婧愪笌鐜版湁 CatVod 绔欑偣骞惰鍑虹幇鍦ㄦ悳绱㈢粨鏋滀腑锛屾潵婧愭爣璁颁负 kazumi:瑙勫垯鍚嶃€?
- 璇︽儏椤碉細褰?CatVod 婧愭棤鎾斁绾胯矾鎴栫敤鎴蜂富鍔ㄧ偣鍑绘椂锛屾彁渚?Kazumi 婧愬脊绐楋紙T74 瀵归綈 Kazumi SourceSheet锛氬苟鍙戞祦寮忋€佹瘡婧愬崱鐗?鐘舵€佸窘鏍囥€侀涓湁缁撴灉婧愯嚜鍔ㄥ睍寮€锛夛紝鐢ㄦ埛閫夋簮鍚庤В鏋愬墽闆嗗苟鎾斁銆?
- 鎾斁閾捐矾锛氬鐢ㄧ幇鏈?Player.play()锛屼絾 Kazumi 婧愰渶鍏堢粡鐪熷疄瑙嗛娴佹彁鍙栵紙闅愯棌 BrowserWindow 鎶?m3u8/mp4锛夈€?
- **鍐呯疆榛樿瑙勫垯**锛?sefun/DM84/enlie 涓変釜瑙勫垯棣栨鍚姩鑷姩瀵煎叆锛岀敤鎴峰紑绠卞嵆鐢ㄣ€?
- **鍦ㄧ嚎瑙勫垯鍟嗗簵**锛氫粠 KazumiRules 浠撳簱娴忚/瀹夎/鏇存柊瑙勫垯锛圙itHub/GitCode 闀滃儚锛夈€?
- **Bangumi 鍏冩暟鎹?*锛氱粺涓€璇︽儏椤靛ご閮ㄦ樉绀虹暘鍓у皝闈?绠€浠?璇勫垎锛堝畼鏂?API锛歛pi.bgm.tv / next.bgm.tv锛?026-08-09 浠?bangumi.lol 闀滃儚鏀瑰洖锛夈€?
- **楠岃瘉鐮佽瘑鍒?*锛氭娴嬪埌楠岃瘉鐮佹椂婧愬崱鏍囪銆岄渶楠岃瘉銆嶏紝鐐瑰嚮鎵撳紑鍙楠岃瘉绐楀彛锛堟墜鍔ㄨ繃楠岃瘉锛屽叧闂悗鏀跺壊 Cookie 骞惰嚜鍔ㄩ噸鏌ヨ婧愶級銆?
- **浠ュ浘鎼滅暘**锛氭敮鎸?URL/base64 鍥剧墖杈撳叆骞惰皟鐢?trace.moe锛圱74 鏀逛负鍚庣涓嬭浇瀛楄妭涓婁紶锛岃閬?URL 鐩翠紶 403锛夈€?
- **鍏煎鍩虹**锛氫繚鐣?DanDanPlay API 涓?mpv ASS 鐩稿叧浠ｇ爜锛屼絾浜у搧褰撳墠涓嶅惎鐢ㄥ脊骞曞叆鍙ｆ垨鎾斁鏃跺脊骞曞姞杞姐€?

### 1.2 褰撳墠杈圭晫

- 楠岃瘉鐮佹敮鎸佹娴嬨€佹墦寮€楠岃瘉椤甸潰銆佹墜鍔ㄨ繃楠岃瘉鍜?Cookie 澶嶇敤锛涜嚜鍔ㄨ瘑鍒笌鑷姩鎻愪氦涓嶅湪褰撳墠浜や粯鑼冨洿銆?
- 寮瑰箷浜у搧鍔熻兘褰撳墠鍏抽棴銆傚悗绔?API 鍜?ASS 鍩虹浠ｇ爜灞炰簬淇濈暀鍏煎灞傦紝涓嶅簲瑙嗕负姝ｅ湪绛夊緟琛ラ綈鐨勪骇鍝佸姛鑳姐€?
- Anime4K銆佷笅杞姐€乄ebDAV銆丼yncPlay銆丏LNA 绛夌敱褰辫 PC 鍏叡鑳藉姏鎻愪緵锛孠azumi 鎾斁婧愮洿鎺ュ鐢紝涓嶅湪鏈ā鍧楅噸澶嶅疄鐜般€?
- macOS/Linux 楠岃瘉銆佷唬鐮佺鍚嶃€佽嚜鍔ㄦ洿鏂板拰 CI/CD 灞炰簬椤圭洰绾у彂甯冨伐浣滐紝涓嶅睘浜?Kazumi 鎺ュ叆鑼冨洿銆?

### 1.3 鍏煎鎬х孩绾?
- 鐜版湁 CatVod 閰嶇疆鍔犺浇銆佹悳绱€佽鎯呫€佹挱鏀俱€佷笅杞姐€佺洿鎾浂鏀瑰姩銆?
- 鎵€鏈夋柊澧炰唬鐮佸繀椤绘斁鍦ㄧ嫭绔嬫ā鍧楋紝绂佹淇敼 app.py銆乺unner.py銆乥ase/spider.py锛圕atVod 瀛楄妭鐮佸绾︼級銆?
- 鏂板 Python 渚濊禆蹇呴』闄愬埗鍏煎鐗堟湰鑼冨洿骞跺啓鍏?`requirements.txt`锛涚姝㈠紩鍏ラ渶瑕佺紪璇戠殑 C 鎵╁睍锛堥櫎宸插瓨鍦ㄧ殑 lxml/quickjs-ng锛夈€?

---

## 2. 鎬讳綋鏋舵瀯锛堝弻寮曟搸骞惰锛?

```
娓叉煋灞?
  棣栭〉/鎼滅储/璇︽儏/璁剧疆锛圕atVod 閾捐矾锛?
       |
       +-- 璇︽儏椤?Kazumi 婧愬脊绐?
       |
       +-- Player.play() 缁熶竴鎾斁鍏ュ彛
             宸﹁矾 CatVod: playerContent 瑙ｆ瀽鍚?mpv
             鍙宠矾 Kazumi: kazumiResolve 鍚?captureDirect 鍐?mpv
                           |
鍚庣锛團astAPI锛?
  /action        CatVod Spider 寮曟搸锛堢幇鏈夛紝闆舵敼鍔級
  /kazumi/action Kazumi 瑙勫垯寮曟搸锛堟柊澧炴ā鍧楋級
       |
       +-- python-backend/kazumi/ 瑙勫垯妯″瀷銆乆Path/API 绛栫暐銆佽鍒欑鐞?
```

鍏抽敭鍐崇瓥锛?
- 鐙珛绔偣锛欿azumi 鎵€鏈夋搷浣滆蛋 /kazumi/action锛屼笌 CatVod 鐨?/action 鐗╃悊闅旂锛岄伩鍏?do 鍙傛暟鍐茬獊銆?
- 鐙珛瀛樺偍锛欿azumi 瑙勫垯瀛?~/.yuki/kazumi/plugins.json锛屼笌 CatVod 鐨?cache/py 鎻掍欢鐩綍鍒嗙銆?
- 鏃?Runner 澶嶇敤锛欿azumi 瑙勫垯涓嶇户鎵?base.spider.Spider锛屼笉杩涘叆 SiteManager锛岄伩鍏嶅崟渚嬫薄鏌撱€?

---

## 3. 鏁版嵁妯″瀷瀵归綈

### 3.1 Kazumi Plugin JSON Schema锛坴8 鍏煎锛?
- api锛氳鍒?schema 鐗堟湰锛屽ぇ浜?8 鎷掔粷瀵煎叆銆?
- name锛氬敮涓€鏍囪瘑锛屽繀濉潪绌恒€?
- baseURL锛氱珯鐐规牴 URL锛堟敞鎰忓ぇ鍐?URL锛夈€?
- searchURL锛氬惈 @keyword 鍗犱綅绗︺€?
- searchList/searchName/searchResult锛歑Path 鎼滅储涓変欢濂椼€?
- chapterRoads/chapterResult锛歑Path 鍓ч泦涓や欢濂椼€?
- searchMode/chapterMode锛歺path 鎴?api銆?
- searchApiConfig/chapterApiConfig锛欰PI 妯″紡閰嶇疆銆?
- userAgent/referer锛氭挱鏀句笅杞借姹傚ご銆?

### 3.2 Python 鍐呴儴妯″瀷
- SearchItem锛歯ame, src銆?
- Road锛歯ame, data锛堝墽闆?URL 鍒楄〃锛? identifier锛堝墽闆嗗悕绉板垪琛級銆?
- PluginSearchResponse锛歱lugin_name, data銆?
- RuleExecutionConfig锛歱lugin_name, base_url, use_post, search_mode, chapter_mode, search_url, search_list, search_name, search_result, chapter_roads, chapter_result, search_api_config, chapter_api_config, anti_crawler_config, user_agent, referer銆?

### 3.3 涓?CatVod 妯″瀷鏄犲皠
- Kazumi Plugin 瀵瑰簲 CatVod Site锛屼絾鐙珛瀛樺偍锛宬ey 涓?kazumi:name銆?
- Kazumi SearchItem 鏃?vod_id/vod_pic锛屼粎 name/src銆?
- Kazumi Road 瀵瑰簲鎾斁绾胯矾锛屼絾 data 鏄挱鏀鹃〉 URL锛岄潪鐩撮摼銆?
- Kazumi 瑙勫垯鍝嶅簲鏃?`detailContent`锛涘奖瑙?PC 浣跨敤 Bangumi API 鐙珛琛ュ厖绠€浠嬨€佸皝闈㈠拰璇勫垎銆?

鍏抽敭宸紓锛欿azumi 瑙勫垯鏈韩娌℃湁 CatVod 寮?`detailContent` 姒傚康锛宍searchResult` 鐩存帴寰楀埌鐣墽璇︽儏椤?URL锛宍chapterResult` 浠庤鎯呴〉鎻愬彇鍓ч泦鎾斁椤?URL銆傝鍒欏眰鍙湁鏍囬鍜岄摼鎺ワ紱褰辫 PC 鍙﹀浣跨敤 Bangumi API 琛ュ厖灏侀潰銆佺畝浠嬪拰璇勫垎绛夊厓鏁版嵁銆?

---

## 4. 鍚庣鏀归€狅紙Python锛?

### 4.1 鏂板鏂囦欢缁撴瀯
```
python-backend/
  kazumi/
    __init__.py
    models.py          鏁版嵁妯″瀷
    plugin.py          Plugin 绫伙細搴忓垪鍖栥€佹墽琛屽叆鍙?
    xpath_strategy.py  XPath 绛栫暐锛坙xml锛?
    api_strategy.py    API 绛栫暐锛堝彈闄?JSONPath锛?
    rule_engine.py     RuleEngine锛氭悳绱㈠墽闆嗙紪鎺?
    plugin_manager.py  PluginManager锛氳鍒?CRUD銆佹寔涔呭寲
    utils.py           normalize_episode_url銆乁A 姹犮€佸紓甯?
  tests/
    test_kazumi.py     鍗曞厓娴嬭瘯
```

### 4.2 PluginManager 瑙勫垯绠＄悊
- 鎸佷箙鍖栵細~/.yuki/kazumi/plugins.json锛屽崟鏂囦欢瀛樺偍鍏ㄩ儴瑙勫垯銆?
- 鍔犺浇鏃舵満锛歴erver.py create_app 鏃跺垵濮嬪寲锛屼笌 SiteManager 骞跺垪銆?
- 绾跨▼瀹夊叏锛歵hreading.Lock 淇濇姢瑙勫垯鍒楄〃璇诲啓銆?
- 瀵煎叆鏍￠獙锛歛pi 灏忎簬绛変簬 8锛沶ame 闈炵┖鍞竴锛涙ā寮忓繀椤讳负 xpath 鎴?api锛沊Path 妯″紡浜斾欢濂楅潪绌猴紱API 妯″紡 URL 闈炵┖涓?JSONPath 鍚堟硶銆?
- 鍚敤绂佺敤锛氬鍔?enabled 瀛楁榛樿 true锛岀鐢ㄥ悗涓嶅嚭鐜板湪鑱氬悎鎼滅储涓庤鎯呴〉寮圭獥銆?

### 4.3 RuleEngine 瑙勫垯鎵ц
- search(config, keyword, cancel_token) 杩斿洖 RuleSearchTrace銆?
- query_chapters(config, source_url) 杩斿洖 RuleChapterTrace銆?
- HTTP 鎵ц鍣細requests锛岃秴鏃?10 绉掞紝headers 甯?referer 涓?UA銆?
- 鍙栨秷锛歵hreading.Event 杞彇娑堬紝瓒呮椂涓㈠純缁撴灉銆?

### 4.4 XPathRuleStrategy
- 浣跨敤 lxml.html 瑙ｆ瀽銆?
- root.xpath(searchList) 寰楄妭鐐瑰垪琛紝閫愯妭鐐?xpath(searchName) 涓?xpath(searchResult)銆?
- 鍙栭摼鎺?node.get(href)锛屽彇鏂囨湰 node.text_content().strip()銆?
- 鎵€鏈?href 蹇呴』缁?normalize_episode_url(base_url, raw)銆?
- 閿欒澶勭悊锛歑Path 璇硶閿欒鎶?XPathRuleFormatException锛涜妭鐐圭己鍚嶇О鎴栭摼鎺ヨ鍏?diagnostics 璺宠繃锛涘叏閮ㄥけ璐ユ姏 NoResultException銆?

### 4.5 ApiRuleStrategy
- 鍙楅檺 JSONPath锛氫粎鏀寔 $ . [index|*|key]锛岀姝㈤€掑綊涓嬮檷涓庤繃婊ゅ櫒銆?
- 鏂板渚濊禆 `jsonpath-ng`锛屽湪 `requirements.txt` 涓檺鍒跺吋瀹圭増鏈寖鍥淬€?
- 妯℃澘娓叉煋锛歎RL/headers/query/body 鏀寔 @variable 鍗犱綅绗︼紝URL 涓彉閲忛渶 quote 缂栫爜銆?
- 鍓ч泦瑙ｆ瀽涓ょ鏍煎紡锛歯ested锛圝SON 鏍戯級涓?delimited锛堝垎闅斿瓧绗︿覆锛屽吋瀹?$$$/#/$锛夈€?
- episodePage 妯℃澘锛氫粠鍝嶅簲鍙橀噺鏋勯€犳挱鏀鹃〉 URL銆?

### 4.6 URL 褰掍竴鍖?
瀹屽叏瀵归綈 Kazumi Dart 瀹炵幇锛氬幓绌虹櫧銆佺浉瀵硅矾寰?urljoin銆佸悓绔欏崗璁粺涓€銆佸幓灏炬枩鏉犮€佸幓绌?query銆佸箓绛夈€?

### 4.7 API 绔偣锛坄/kazumi/action`锛?

鏍稿績瑙勫垯绔偣锛?

- `kazumiList` / `kazumiAdd` / `kazumiRemove` / `kazumiToggle`锛氳鍒?CRUD 涓庡惎鐢ㄧ姸鎬併€?
- `kazumiSearch` / `kazumiChapters` / `kazumiResolve`锛氭悳绱€佸墽闆嗚В鏋愪笌鎾斁椤佃В鏋愬弬鏁般€?
- `kazumiShopCatalog` / `kazumiShopInstall`锛氳鍒欏晢搴楁祻瑙堜笌瀹夎銆?
- `kazumiCheckValidity` / `kazumiValidityStatus`锛氬悗鍙版湁鏁堟€ф鏌ヤ笌鐘舵€佹煡璇€?
- `kazumiBatchUpdate` / `kazumiUpdateStatus`锛氬悗鍙版壒閲忔洿鏂颁笌鐘舵€佹煡璇€?

浼氳瘽涓庡厓鏁版嵁绔偣锛?

- `kazumiCookieSet` / `kazumiCookieList` / `kazumiCookieClear`锛氳В鏋?Cookie 鎸佷箙鍖栫鐞嗐€?
- `kazumiBangumiSearch` / `Info` / `Calendar` / `Season` / `Trends` / `Episodes` / `Characters` / `Staff` / `Comments` / `Relations`锛欱angumi 鍏冩暟鎹€俙Season(start,end)` 鎸?air_date 鍖洪棿妫€绱㈠巻鍙插搴︽斁閫佸苟鍒嗘《锛堟椂闂磋〃瀛ｈ妭绱㈠紩鐢級銆?
- `kazumiBangumiMe` / `Collections` / `CollectionGet` / `CollectionSet` / `CollectionDel`锛欱angumi 鐢ㄦ埛鏀惰棌鍚屾銆?

浠撳簱杩樹繚鐣欏脊骞曞吋瀹圭鐐癸紝浣嗕骇鍝佺晫闈㈠綋鍓嶄笉鍚敤寮瑰箷鍔熻兘銆?

---

## 5. 鍓嶇鏀归€狅紙Electron 娓叉煋灞傦級

### 5.1 鏂板鏂囦欢
- src/renderer/js/kazumi.js锛氳鍒欑鐞嗐€佹悳绱€佸脊绐楅€昏緫銆?

### 5.2 淇敼鏂囦欢
- index.html锛氭柊澧炶缃〉 Kazumi 鏉垮潡銆佽鎯呴〉 Kazumi 婧愬脊绐椼€?
- panels.js锛氳缃〉瀵艰埅娉ㄥ唽銆?
- search.js锛氳仛鍚堟悳绱㈠悎骞?Kazumi 缁撴灉銆?
- detail.js锛氳鎯呴〉 Kazumi 婧愭寜閽笌寮圭獥銆?
- player.js锛歅layer.play 鏀寔 kazumi: 鍓嶇紑婧愩€?
- ui.css锛氭柊澧炲脊绐楁牱寮忥紙澶嶇敤 md-dialog锛夈€?

### 5.3 璁剧疆椤?Kazumi 瑙勫垯绠＄悊
- 浣嶇疆锛氳缃〉涓€绾у鑸柊澧?Kazumi 瑙勫垯锛屼綅浜庢簮璁剧疆涔嬪悗绯荤粺涔嬪墠銆?
- 瀵煎叆瑙勫垯鍗＄墖锛歵extarea 绮樿创瑙勫垯 JSON 鎴?kazumi:// 鍒嗕韩閾炬帴锛屽鍏ユ寜閽紝浠庡壀璐存澘瀵煎叆鎸夐挳锛屾垚鍔熷け璐?toast銆?
- 宸插畨瑁呰鍒欏崱鐗囷細鍒楄〃灞曠ず瑙勫垯鍚嶃€佺増鏈€佸惎鐢ㄥ紑鍏炽€佸垹闄ゆ寜閽紝鍒犻櫎鍓?confirmDialog 纭锛岀┖鎬佹彁绀恒€?

### 5.4 璇︽儏椤?Kazumi 婧愬脊绐楋紙閫夋簮 Sheet锛?
- 瑙﹀彂锛氳鎯呴〉鎾斁绾胯矾鍖轰笅鏂广€岄€夋嫨 Kazumi 婧愩€?銆岃瘯璇?Kazumi 瑙勫垯婧愩€嶏紝鎴栫粺涓€璇︽儏椤点€屽紑濮嬭鐪嬨€嶆寜閽紙Bangumi-only锛夛紝浠呭綋瀛樺湪宸插惎鐢ㄨ鍒欐椂鏄剧ず銆?
- 寮圭獥锛圱74锛屽榻?Kazumi SourceSheet锛夛細鎵撳紑鍗虫覆鏌?*姣忓惎鐢ㄦ簮涓€寮犲彲鎶樺彔鍗＄墖**锛岄€氳繃 SSE `/search/kazumi-stream` **骞跺彂娴佸紡**濉厖锛屾瘡婧愮姸鎬佸窘鏍囷紙妫€绱腑/N 鏉?闇€楠岃瘉/妫€绱㈠け璐?鏃犵粨鏋滐級锛?*棣栦釜鏈夌粨鏋滄簮鑷姩灞曞紑**銆?
- 鐐圭粨鏋滆 鈫?鏄剧ず銆岃幏鍙栦腑銆嶁啋 kazumiChapters 瑙ｆ瀽 鈫?閫夐泦瑙嗗浘锛堝惈銆屸啇 杩斿洖閫夋簮銆嶏級銆?
- 鐐瑰墽闆?鈫?鍏抽棴寮圭獥锛岃皟 Player.play(site='kazumi:瑙勫垯鍚?, flag='绾胯矾鍚?, id='鎾斁椤?URL', ...)銆?
- 姣忔簮琛ユ晳鎿嶄綔锛氶噸璇?/ 杩涜楠岃瘉锛堝彲瑙佺獥鍙ｏ紝瀹屾垚鍚庤嚜鍔ㄩ噸鏌ヨ婧愶級/ 鎵嬪姩妫€绱紙鍏抽敭璇嶉噸鏌ヨ婧愶級/ 娴忚鍣ㄦ墦寮€銆?
- Player.play 妫€娴嬪埌 site 浠?kazumi: 寮€澶存椂锛屽厛璋?kazumiResolve 鍙?pageUrl 涓?headers锛屽啀璋?yuki:captureDirect 鎶撶湡瀹炴祦锛屾渶鍚庝氦 mpv銆?

### 5.5 鎼滅储椤佃仛鍚?
- 鐜版湁 CatVod 鑱氬悎鎼滅储璧?SSE /search/stream锛汯azumi 婧愰〉绛捐蛋 SSE `/search/kazumi-stream`锛堟瘡婧愬畬鎴愬嵆鎺ㄤ竴鏉★紝鍚姸鎬佸瓧娈碉級銆?
- Kazumi 缁撴灉鍗＄墖鏃犳簮灏侀潰锛氭寜鐗囧悕浠?Bangumi 鎷夊彇灏侀潰骞剁紦瀛樻樉绀猴紙T73锛屽懡涓?`kazumi_bgm_cover` localStorage + 鍐呭瓨缂撳瓨鐩存帴澶嶇敤锛屾湭鍛戒腑璧拌ˉ鎷夋睜鎸夌墖鍚嶆煡 Bangumi 棣栦釜鍖归厤 `{id, cover}` 灏侀潰锛夛紝鍙充笂瑙掕鍒欏悕寰界珷淇濈暀锛涚偣鍑诲崱鐗囧懡涓紦瀛?id 鐩存帴杩?*缁熶竴璇︽儏椤?*锛堝厤閲嶅鎼滅储銆佸皝闈笌璇︽儏涓€鑷达級锛岃缃〉鍙竻绌哄皝闈㈢紦瀛樸€?

---

## 6. 鎾斁閾捐矾鏀归€?

### 6.1 娓叉煋灞?Player.play 鏀归€?
- 鍏ュ弬 site 涓?kazumi:瑙勫垯鍚?鏃讹紝杩涘叆 Kazumi 鎾斁鍒嗘敮銆?
- 鍏堣皟 /kazumi/action do=kazumiResolve 鍙?pageUrl 涓?headers銆?
- 鍐嶈皟 window.yuki.captureDirect(pageUrl) 鎶撶湡瀹炶棰戞祦锛堜富杩涚▼闅愯棌 BrowserWindow 鎷︽埅 m3u8/mp4锛夈€?
- 鎶撳埌鐩撮摼鍚庯紝涓庤鍒?headers 鍚堝苟锛屼氦 mpv 鎾斁銆?
- 杩炴挱锛欿azumi 婧愬悓鏍锋敮鎸佹覆鏌撳眰椹卞姩杩炴挱锛宔pisodes 鍒楄〃鐢?kazumiChapters 杩斿洖鐨?data 涓?identifier 缁勮銆?

### 6.2 涓昏繘绋嬫敼閫?
- 鏃犻渶鏂板 IPC锛屽鐢ㄧ幇鏈?yuki:capture-direct銆?
- 鍙€変紭鍖栵細captureDirect 澧炲姞鑷畾涔?UA/Referer 浼犲叆锛堝綋鍓嶇増鏈粠椤甸潰璇锋眰澶存姄 Referer锛夈€?

---

## 7. 瑙勫垯绠＄悊 UI 璇︾粏璁捐

### 7.1 璁剧疆椤靛鑸?
- 鏂板 data-cat=kazumi锛屾枃妗?Kazumi 瑙勫垯銆?
- 鎻掑叆浣嶇疆锛氭簮璁剧疆涔嬪悗锛岀郴缁熶箣鍓嶃€?

### 7.2 瀵煎叆瑙勫垯鍗＄墖
- 鏍囬锛氬鍏?Kazumi 瑙勫垯銆?
- 璇存槑锛氱矘璐磋鍒?JSON 鎴?kazumi:// 鍒嗕韩閾炬帴锛涜鍒欓渶绗﹀悎 Kazumi v8 schema銆?
- 杈撳叆锛歵extarea锛岄珮 120px锛屽崰浣嶇绀轰緥銆?
- 鎸夐挳琛岋細瀵煎叆瑙勫垯锛坒illed锛夈€佷粠鍓创鏉垮鍏ワ紙tonal锛夈€佹竻绌猴紙text锛夈€?
- 瀵煎叆娴佺▼锛氳В鏋?JSON锛堟垨 base64 瑙ｇ爜 kazumi:// 閾炬帴锛夆啋 鍓嶇鏍￠獙 name/api 鐗堟湰 鈫?璋?kazumiAdd 鈫?鎴愬姛鍒锋柊瑙勫垯鍒楄〃锛屽け璐ユ樉绀洪敊璇師鍥犮€?

### 7.3 宸插畨瑁呰鍒欏崱鐗?
- 鏍囬锛氬凡瀹夎瑙勫垯锛圢锛夈€?
- 鍒楄〃琛岋細宸︿晶瑙勫垯鍚嶄笌鐗堟湰锛屼腑闂村惎鐢ㄥ紑鍏筹紝鍙充晶鍒犻櫎鎸夐挳銆?
- 寮€鍏冲垏鎹細璋?kazumiToggle锛岀珛鍗崇敓鏁堛€?
- 鍒犻櫎锛歝onfirmDialog 纭鍚庤皟 kazumiRemove锛屽埛鏂板垪琛ㄣ€?

---

## 8. 娼滃湪 Bug 涓庨闃叉帾鏂?

### 8.1 XPath 涓婁笅鏂囬敊璇?
- 鐜拌薄锛氭悳绱㈡垨鍓ч泦瑙ｆ瀽缁撴灉涓虹┖銆?
- 鍘熷洜锛欿azumi XPath 鏄浉瀵硅妭鐐规煡璇紝鑻ュ湪閿欒涓婁笅鏂囨墽琛屼細鎵句笉鍒拌妭鐐广€?
- 棰勯槻锛氫弗鏍煎尯鍒?root 鏌ヨ涓庤妭鐐瑰唴鏌ヨ锛涘崟鍏冩祴璇曡鐩栧吀鍨嬭鍒欙紙enlie銆丏M84锛夈€?

### 8.2 URL 褰掍竴鍖栦笉涓€鑷?
- 鐜拌薄锛氬悓涓€闆嗗湪涓嶅悓鍏ュ彛 URL 涓嶅悓锛屽鑷村巻鍙茶褰曟垨杩炴挱閿欎贡銆?
- 棰勯槻锛氱粺涓€浣跨敤 normalize_episode_url锛涘崟鍏冩祴璇曡鐩栫浉瀵硅矾寰勩€佸崗璁贩鐢ㄣ€佸熬鏂滄潬鍦烘櫙銆?

### 8.3 骞跺彂鎼滅储閿佺珵浜?
- 鐜拌薄锛氳仛鍚堟悳绱㈡椂 Kazumi 瑙勫垯缁撴灉闀挎椂闂翠笉杩斿洖銆?
- 鍘熷洜锛氫笌 CatVod 鎼滅储鍏变韩绾跨▼姹犳垨閿併€?
- 棰勯槻锛欿azumi 浣跨敤鐙珛 ThreadPoolExecutor锛宮ax_workers 闄愬埗涓?5锛屼笌 CatVod 鎼滅储闅旂銆?

### 8.4 JSONPath 娉ㄥ叆鎴栨寰幆
- 鐜拌薄锛氭伓鎰忚鍒欏鑷磋В鏋愬崱姝绘垨寮傚父銆?
- 棰勯槻锛氬彈闄?JSONPath 鐧藉悕鍗曟牎楠岋紝绂佹閫掑綊涓嬮檷涓庤繃婊ゅ櫒锛沯sonpath-ng 瑙ｆ瀽瓒呮椂淇濇姢锛堣櫧搴撴湰韬棤瓒呮椂锛屼絾琛ㄨ揪寮忓鏉傚害鍙楅檺锛夈€?

### 8.5 鎾斁椤?URL 涓庣洿閾炬贩娣?
- 鐜拌薄锛歮pv 灏濊瘯鎾斁 HTML 椤甸潰澶辫触銆?
- 棰勯槻锛歅layer.play 妫€娴嬪埌 kazumi: 鍓嶇紑鏃跺己鍒惰蛋 captureDirect锛沜aptureDirect 浠呮帴鍙?http/https 涓旈潪濯掍綋鍚庣紑椤甸潰銆?

### 8.6 瑙勫垯鎸佷箙鍖栨枃浠舵崯鍧?
- 鐜拌薄锛歱lugins.json 鎹熷潖瀵艰嚧鍚庣鍚姩澶辫触銆?
- 棰勯槻锛氬姞杞芥椂 try/catch锛屾崯鍧忔椂澶囦唤涓?plugins.json.bak 骞跺垵濮嬪寲涓虹┖鍒楄〃锛涘啓鍏ユ椂鐢ㄤ复鏃舵枃浠跺姞鍘熷瓙鏇挎崲銆?

### 8.7 鍓嶇寮圭獥鐘舵€佹畫鐣?
- 鐜拌薄锛氬叧闂?Kazumi 婧愬脊绐楀悗鍐嶆鎵撳紑鏄剧ず鏃ф暟鎹€?
- 棰勯槻锛氬脊绐楁墦寮€鏃舵竻绌轰笂娆＄粨鏋滐紱鎼滅储涓庡墽闆嗚В鏋愮敤 token 闃茶繃鏈熷洖璋冦€?

### 8.8 璁剧疆椤靛鑸啿绐?
- 鐜拌薄锛氭柊澧?Kazumi 鏉垮潡鍚庤缃〉甯冨眬閿欎贡銆?
- 棰勯槻锛氬鐢ㄧ幇鏈?settings-nav 涓?settings-grid 缁撴瀯锛屾柊澧?data-setcat 涓庡崱鐗囨牱寮忎笌鐜版湁鏉垮潡涓€鑷淬€?

---

## 9. 娴嬭瘯楠屾敹娓呭崟

### 9.1 鍚庣鍗曞厓娴嬭瘯锛坧ython-backend/tests/test_kazumi.py锛?
- Plugin JSON 搴忓垪鍖栦笌鍙嶅簭鍒楀寲锛堝惈缂哄け瀛楁榛樿鍊硷級銆?
- XPath 绛栫暐锛歟nlie 瑙勫垯鎼滅储瑙ｆ瀽銆丏M84 瑙勫垯鍓ч泦瑙ｆ瀽銆?
- API 绛栫暐锛歯ested 涓?delimited 涓ょ鏍煎紡瑙ｆ瀽銆?
- URL 褰掍竴鍖栵細鐩稿璺緞銆佺粷瀵硅矾寰勩€佸崗璁贩鐢ㄣ€佸熬鏂滄潬銆佺┖ query銆?
- PluginManager锛氬鍏ャ€佸垹闄ゃ€佸惎鐢ㄧ鐢ㄣ€佹寔涔呭寲銆佹崯鍧忔仮澶嶃€?
- RuleEngine锛氬苟鍙戞悳绱€佸崟瑙勫垯澶辫触涓嶅奖鍝嶅叾浠栥€佽秴鏃朵涪寮冦€?

### 9.2 鍓嶇闆嗘垚娴嬭瘯
- 璁剧疆椤靛鍏ヨ鍒欍€佸垹闄よ鍒欍€佸惎鐢ㄧ鐢ㄣ€?
- 璇︽儏椤?Kazumi 婧愬脊绐楁墦寮€銆佹悳绱€侀€夋簮銆佽В鏋愬墽闆嗐€佹挱鏀俱€?
- 鑱氬悎鎼滅储鍚屾椂杩斿洖 CatVod 涓?Kazumi 缁撴灉銆?
- 鎾斁鍣ㄥ kazumi: 鍓嶇紑婧愭纭蛋 captureDirect銆?

### 9.3 鍥炲綊娴嬭瘯
- 鐜版湁 CatVod 閰嶇疆鍔犺浇銆佹悳绱€佽鎯呫€佹挱鏀俱€佷笅杞姐€佺洿鎾叏閮ㄦ甯搞€?
- npm run test:all 鍏ㄧ豢銆?

---

## 10. 浜や粯鐗╀笌楠屾敹鏍囧噯

### 10.1 浜や粯鐗?
- python-backend/kazumi/ 鐩綍鍏ㄩ儴 Python 妯″潡銆?
- python-backend/tests/test_kazumi.py 鍗曞厓娴嬭瘯銆?
- src/renderer/js/kazumi.js 鍓嶇妯″潡銆?
- index.html銆乸anels.js銆乻earch.js銆乨etail.js銆乸layer.js銆乽i.css 淇敼銆?
- requirements.txt 鏂板渚濊禆閿佸畾銆?
- 鏈枃浠讹紙KAZUMI.md锛夈€?

### 10.2 楠屾敹鏍囧噯
- 鍙鍏?Kazumi 瑙勫垯骞跺嚭鐜板湪瑙勫垯鍒楄〃銆?
- 璇︽儏椤靛彲閫氳繃 Kazumi 婧愭挱鏀惧奖鐗囥€?
- 鑱氬悎鎼滅储缁撴灉鍖呭惈 Kazumi 婧愩€?
- 鐜版湁 CatVod 鍔熻兘闆跺洖褰掋€?
- 瑙勫垯 CRUD銆乆Path/API 瑙ｆ瀽銆佸苟鍙戦殧绂汇€丆ookie銆丅angumi 鍜屾挱鏀惧叆鍙ｇ瓑鍏抽敭璺緞鏈夎嚜鍔ㄥ寲娴嬭瘯瑕嗙洊銆?

### 10.3 楠屾敹璁板綍锛?026-08-09锛?

鍘嗗彶鍩虹嚎锛欿azumi 55 椤广€乻moke 13 椤广€乸hase3 25 椤瑰拰褰撴椂鐨?JavaScript 妫€鏌ュ潎閫氳繃銆?

鏈鏂囨。鏁寸悊鏃堕噸鏂伴獙璇侊細

- [x] smoke锛?3/13銆?
- [x] phase3锛?5/25锛堝皢娴嬭瘯鏁版嵁鐩綍瀹氬悜鍒板伐浣滃尯鍚庤繍琛岋級銆?
- [x] JavaScript 鍗曞厓娴嬭瘯锛?4/34锛堥€愭枃浠剁洿鎺ヨ繍琛岋紝瑙勯伩鍙楃鐜绂佹娴嬭瘯杩愯鍣ㄦ淳鐢熷瓙杩涚▼锛夈€?
- [x] JavaScript 璇硶妫€鏌ワ細32/32銆?
- [ ] Kazumi锛氬叡杩愯 61 椤癸紝60 椤归€氳繃锛汣ookie 鎸佷箙鍖栫敤渚嬪洜鍙楃鐜鎷掔粷鍚戞祴璇曚复鏃剁洰褰曞啓鏂囦欢鑰屽け璐ワ紝闇€鍦ㄦ櫘閫氭湰鏈虹幆澧冮噸鏂版墽琛?`npm run test:all` 纭銆?

---

## 11. 琛ュ厖娉ㄦ剰浜嬮」锛堟牴鎹敤鎴锋弿杩拌拷鍔狅級

### 11.1 鏂囨。鍏堣
Kazumi 鎺ュ彛銆乻chema 鎴栬В鏋愰摼璺彉鏇村繀椤诲厛鏇存柊鏈枃浠讹紝鍐嶄慨鏀逛唬鐮侊紱椤圭洰绾х姸鎬佷笌寰呭姙缁熶竴缁存姢鍦?[../PROGRESS.md](../PROGRESS.md)銆?

### 11.2 鏈€灏忎镜鍏?
鏂板浠ｇ爜涓嶅緱淇敼鐜版湁 CatVod 閾捐矾浠讳綍鏂囦欢锛坅pp.py銆乺unner.py銆乥ase/spider.py銆乧onfig.py銆乻ite_manager.py 绛夛級锛屾墍鏈?Kazumi 閫昏緫鏀惧湪鐙珛妯″潡銆?

### 11.3 閿欒闅旂
Kazumi 瑙勫垯瑙ｆ瀽澶辫触涓嶅緱褰卞搷 CatVod 绔欑偣锛涘崟鏉¤鍒欏紓甯镐笉寰楀奖鍝嶅叾浠栬鍒欍€?

### 11.4 鎬ц兘
Kazumi 鑱氬悎鎼滅储骞惰搴﹂檺鍒朵负 5锛岄伩鍏嶄笌 CatVod 鎼滅储浜夋姠鍚庣绾跨▼姹犮€?

### 11.5 瀹夊叏
瑙勫垯 JSON 瀵煎叆鏃舵牎楠?api 鐗堟湰涓庡繀濉瓧娈碉紝鎷掔粷鎭舵剰鎴栨崯鍧忚鍒欙紱鎾斁椤?URL 蹇呴』缁?captureDirect 楠岃瘉涓虹湡瀹炲獟浣撴祦鍚庢墠浜?mpv銆?

### 11.6 鏃ュ織瑙勮寖锛堝悗绔帶鍒跺彴锛?
Kazumi 寮曟搸鍏抽敭姝ラ锛堣鍒欏鍏ャ€佹悳绱€佸墽闆嗚В鏋愩€佹挱鏀捐В鏋愶級椤昏緭鍑烘棩蹇楀埌鍚庣鎺у埗鍙帮紝鏍煎紡缁熶竴涓?`[kazumi] <鎿嶄綔>: <璇︽儏>`锛屼究浜庢帓鏌ャ€?

### 11.7 鐗堟湰鍏煎锛坅piLevel 鍙樻洿锛?
褰撳墠瀵归綈 Kazumi v2.2.6锛坅piLevel 8锛夛紝鍚庣画鍗囩骇 apiLevel 鏃堕渶鍚屾鏇存柊鏍￠獙閫昏緫涓庢湰鏂囦欢锛涜鍒欏鍏ユ椂鑻?api 澶т簬 8 蹇呴』鏄庣‘鎷掔粷骞舵彁绀虹敤鎴枫€?

### 11.8 渚濊禆绠＄悊
鏂板 Python 渚濊禆蹇呴』鍦?`requirements.txt` 涓檺鍒跺吋瀹圭増鏈寖鍥达紱瀹夎鍓嶉獙璇?Python 3.14 鍏煎鎬с€傞櫎宸插瓨鍦ㄧ殑 lxml/quickjs-ng 澶栵紝涓嶅紩鍏ラ渶瑕侀澶栨湰鏈虹紪璇戠幆澧冪殑 C 鎵╁睍銆?

### 11.9 浠ｇ爜瀹℃煡娓呭崟锛堝己鍒讹紝鎻愪氦鍓嶉€愰」鏍稿锛?
- [ ] 鏈慨鏀?app.py銆乺unner.py銆乥ase/spider.py銆乧onfig.py銆乻ite_manager.py 绛?CatVod 鏍稿績鏂囦欢銆?
- [ ] 鏂板 Python 浠ｇ爜鍏ㄩ儴浣嶄簬 python-backend/kazumi/ 鐩綍銆?
- [ ] Kazumi 瑙勫垯鏍稿績浠ｇ爜闆嗕腑鍦?`python-backend/kazumi/`锛涜法妯″潡鏀瑰姩浠呯敤浜庣鐐规敞鍐屻€両PC銆佸叕鍏辨挱鏀捐兘鍔涘拰 UI 鎺ュ叆銆?
- [ ] 鏂板渚濊禆宸查檺鍒跺吋瀹圭増鏈寖鍥村苟鍐欏叆 `requirements.txt`銆?
- [ ] 鍏抽敭姝ラ宸茶緭鍑烘棩蹇楋紙瑙勫垯瀵煎叆銆佹悳绱€佸墽闆嗚В鏋愩€佹挱鏀捐В鏋愶級銆?
- [ ] 瑙勫垯鎸佷箙鍖栨枃浠舵崯鍧忔椂鏈夊浠戒笌鎭㈠閫昏緫銆?
- [ ] 鍏抽敭琛屼负鏈夎嚜鍔ㄥ寲娴嬭瘯锛岀浉鍏抽泦鎴愪笌鍥炲綊娴嬭瘯閫氳繃銆?
- [ ] 鐜版湁 CatVod 鍔熻兘闆跺洖褰掞紙npm run test:all 鍏ㄧ豢锛夈€?

### 11.10 鍙樻洿瀹夊叏涓庢仮澶?

- `pre-kazumi` tag 鍙綔涓烘帴鍏ュ墠鍩虹嚎鍙傝€冿紝涓嶅簲鍦ㄥ瓨鍦ㄦ湭鎻愪氦鏀瑰姩鏃朵娇鐢ㄧ牬鍧忔€у洖閫€鍛戒护銆?
- 淇敼鍓嶅厛妫€鏌ュ伐浣滃尯骞朵繚鐣欑敤鎴峰凡鏈夋敼鍔紱鎸夊彲鐙珛楠岃瘉鐨勬ā鍧楁媶鍒嗘彁浜ゃ€?
- 瑙勫垯鎸佷箙鍖栧啓鍏ラ噰鐢ㄤ复鏃舵枃浠朵笌鍘熷瓙鏇挎崲锛屾崯鍧忔枃浠跺浠戒负 `plugins.json.bak`銆?
- 姣忎釜妯″潡瀹屾垚鍚庤繍琛?`npm run test:all`锛涘嚭鐜板洖褰掓椂浼樺厛淇鎴栭拡瀵瑰叿浣撴彁浜ゅ洖閫€銆?

### 11.11 鏂囨。缁存姢

- 褰撳墠瀹屾垚鑼冨洿鍜屽緟鍔炲彧鍦?[../PROGRESS.md](../PROGRESS.md) 缁存姢銆?
- 鎺ュ彛銆乻chema銆佺洰褰曟垨瑙ｆ瀽閾捐矾鍙樺寲鏇存柊鏈枃浠躲€?
- 涓?Kazumi 鍘熺増鐨勫姛鑳藉樊璺濇洿鏂?[KAZUMI.md#差距](KAZUMI.md#差距)銆?
- 杩愯闂銆佹棩蹇楄瘉鎹拰澶嶆祴缁撹鏇存柊 [RUNTIME_ISSUES.md](RUNTIME_ISSUES.md)銆?

---

## 第二部分：与原版差距对照


> - 鐗堟湰锛歷2.2锛?026-08-10锛?
> - 鍩轰簬 Kazumi v2.2.6 婧愮爜锛坙ib/ 321 涓枃浠讹級涓?yuki 褰撳墠瀹炵幇瀵规瘮銆?
> - 鏍囪锛氣渽 宸插疄鐜帮紝鈿狅笍 閮ㄥ垎瀹炵幇锛屸徃 浜у搧鑼冨洿澶栨垨鏆傜紦锛屸潓 褰撳墠鑼冨洿鍐呮湭瀹炵幇銆?
> - 鈥淜azumi 鎺ュ叆瀹屾垚鈥濇寚鏃㈠畾鍙屽紩鎿庢帴鍏ヨ寖鍥村畬鎴愶紝涓嶄唬琛ㄤ笌 Flutter 鍘熺増 1:1 绛変环銆?

## 褰撳墠缁撹

- 瑙勫垯銆佹悳绱€佹挱鏀捐В鏋愩€佷笅杞姐€丅angumi銆乄ebDAV銆丼yncPlay銆丏LNA 鍜屼富瑕侀〉闈㈠潎宸叉帴鍏ャ€?
- 寮瑰箷浜у搧鍔熻兘宸叉槑纭叧闂紱淇濈暀鐨?DanDanPlay/ASS 浠ｇ爜灞炰簬鍏煎鍩虹锛屼笉鍒楀叆褰撳墠寰呭姙銆?
- 涓昏鍓╀綑宸ヤ綔鏄獙璇佺爜鑷姩鍖栵紙鏆備笉浜や粯锛夈€佽法骞冲彴楠岃瘉銆佷唬鐮佺鍚嶃€佽嚜鍔ㄦ洿鏂板拰 CI/CD銆?
- 鎸夊綋鍓嶄骇鍝佽寖鍥寸粺璁★紝87 椤逛腑 79 椤瑰畬鎴愩€? 椤归儴鍒嗗畬鎴愩€? 椤瑰欢鍚庯紝瀹屾垚鐜囩害 91%銆?

---

## 1. 鏍稿績瑙勫垯绯荤粺锛堣鍒?鎻掍欢寮曟搸锛?

| 鍔熻兘 | Kazumi 鍘熺増 | yuki 鐜扮姸 | 宸窛 |
|------|------------|--------------|------|
| 瑙勫垯妯″瀷锛圥lugin锛?| 鉁?瀹屾暣 schema | 鉁?宸插疄鐜帮紙api鈮? 鏍￠獙锛屽瓧娈靛畬鏁达級 | 鏃?|
| XPath 绛栫暐 | 鉁?lxml锛岀浉瀵硅妭鐐规煡璇紝URL 褰掍竴鍖?| 鉁?宸插疄鐜?| 鏃?|
| API 绛栫暐锛圝SONPath锛?| 鉁?鍙楅檺 JSONPath锛屾ā鏉挎覆鏌?| 鉁?宸插疄鐜帮紙jsonpath-ng锛?| 鏃?|
| 瑙勫垯鎼滅储 | 鉁?RuleEngine 缂栨帓锛屽苟鍙戞煡璇?| 鉁?宸插疄鐜帮紙ThreadPoolExecutor锛屽苟琛屽害 5锛?| 鏃?|
| 瑙勫垯鍓ч泦瑙ｆ瀽 | 鉁?chapterRoads/chapterResult 瑙ｆ瀽 | 鉁?宸插疄鐜?| 鏃?|
| 瑙勫垯绠＄悊 | 鉁?PluginsController锛圕RUD/鍚敤绂佺敤/鎸佷箙鍖栵級 | 鉁?宸插疄鐜帮紙PluginManager锛?| 鏃?|
| 瑙勫垯瀵煎叆/瀵煎嚭 | 鉁?kazumi:// base64 鍒嗕韩閾炬帴 | 鉁?宸插疄鐜帮紙绮樿创瀵煎叆锛?| 鏃?|
| 鍐呯疆榛樿瑙勫垯 | 鉁?assets/plugins/ 3 涓鍒?| 鉁?宸插疄鐜帮紙棣栨鍚姩鑷姩瀵煎叆锛?| 鏃?|
| 鍦ㄧ嚎瑙勫垯鍟嗗簵 | 鉁?KazumiRules 浠撳簱娴忚/瀹夎/鏇存柊 | 鉁?宸插疄鐜帮紙GitHub/GitCode 闀滃儚锛?| 鏃?|
| 瑙勫垯缂栬緫鍣?| 鉁?PluginEditorPage | 鉁?宸插疄鐜帮紙鍙鍖栬〃鍗曠紪杈?+ 淇濆瓨/娴嬭瘯锛?| 鏃?|
| 瑙勫垯娴嬭瘯 | 鉁?PluginTestPage | 鉁?宸插疄鐜帮紙缂栬緫鍣ㄥ唴缃祴璇曟寜閽級 | 鏃?|
| 瑙勫垯鏈夋晥鎬ц拷韪?| 鉁?PluginValidityTracker | 鉁?宸插疄鐜帮紙鍚庡彴骞跺彂鎼滅储娴嬭瘯鍏抽敭璇嶏紝鏍囪 valid/invalid/captcha锛孶I 寰芥爣锛?| 鏃?|
| 瑙勫垯瀹夎鏃堕棿杩借釜 | 鉁?PluginInstallTimeTracker | 鉁?宸插疄鐜帮紙installedAt/updatedAt 鎸佷箙鍖栵紝鍒楄〃鎮仠灞曠ず锛?| 鏃?|
| 瑙勫垯鎵归噺鏇存柊 | 鉁?4 骞跺彂鎵归噺鏇存柊 | 鉁?宸插疄鐜帮紙鍚庡彴 4 骞跺彂鍟嗗簵妫€鏌?鐗堟湰姣旇緝+鏇存柊锛?| 鏃?|

---

## 2. 瑙嗛婧愯幏鍙栨満鍒?

| 鍔熻兘 | Kazumi 鍘熺増 | yuki 鐜扮姸 | 宸窛 |
|------|------------|--------------|------|
| 鐣墽婧愶紙绔欑偣/绾胯矾锛?| 鉁?瑙勫垯鎼滅储寰楀埌鐣墽璇︽儏椤?URL | 鉁?宸插疄鐜?| 鏃?|
| 鍓ч泦婧愶紙鎾斁椤碉級 | 鉁?chapterResult 鎻愬彇鍓ч泦鎾斁椤?URL | 鉁?宸插疄鐜?| 鏃?|
| 鐪熷疄瑙嗛娴佹彁鍙?| 鉁?鏃犲ご WebView 涓夋満鍒?| 鉁?宸插疄鐜帮紙webRequest 鎷︽埅濯掍綋璇锋眰 + JS 娉ㄥ叆杞 video 鍏冪礌 + 鏃цВ鏋愬櫒 iframe 鐩戝惉涓夋満鍒讹級 | 鏃?|
| 鏃цВ鏋愬櫒锛坲seLegacyParser锛?| 鉁?iframe src 鐩戝惉 | 鉁?宸插疄鐜帮紙useLegacyParser 瑙勫垯璧?iframe src 鐩戝惉骞惰窡闅忥紝闄愭繁闃茬幆锛?| 鏃?|
| 骞垮憡杩囨护锛坅dBlocker锛?| 鉁?HLS 骞垮憡杩囨护 | 鉁?宸插疄鐜帮紙m3u8 涓嬭浇鍓嶈繃婊?CUE-OUT/CUE-IN + 骞垮憡璺緞鍒嗘锛岃缃」寮€鍏筹級 | 鏃?|
| 楠岃瘉鐮佸弽鐖?| 鉁?AntiCrawlerConfig | 鈿狅笍 宸插疄鐜帮紙T74锛氭悳绱㈤〉/閫夋簮寮圭獥婧愬崱鏍囪銆岄渶楠岃瘉銆嶏紝鐐瑰嚮鎵撳紑鍙楠岃瘉绐楀彛渚涙墜鍔ㄨ繃楠岃瘉锛屽叧闂悗鏀跺壊 Cookie 骞惰嚜鍔ㄩ噸鏌ヨ婧愶級 | 浠嶄负鎵嬪姩杩囬獙璇侊紱鑷姩楠岃瘉锛堝浘鐗囩爜/鐐瑰嚮/鑴氭湰涓夊瀷锛夋殏涓嶄氦浠?|
| Cookie 绠＄悊 | 鉁?PluginCookieManager | 鉁?宸插疄鐜帮紙CookieJar 钀界洏 kazumi/cookies.json锛岃В鏋愪細璇?Cookie 鍥炰紶锛岃鍒欏紩鎿庤姹傝嚜鍔ㄥ甫涓婏紝璁剧疆椤垫煡鐪?娓呴櫎锛?| 鏃?|
| 瑙嗛婧愯В鏋愭睜 | 鉁?VideoSourceResolverPool | 鉁?宸插疄鐜帮紙3 鐙珛 partition 妲戒綅骞跺彂瑙ｆ瀽锛屼簰涓嶅啿绐侊級 | 鏃?|

---

## 3. 鐣墽鍏冩暟鎹紙Bangumi API锛?

| 鍔熻兘 | Kazumi 鍘熺増 | yuki 鐜扮姸 | 宸窛 |
|------|------------|--------------|------|
| 鐣墽鎼滅储 | 鉁?bangumiSearch | 鉁?宸插疄鐜?| 鏃?|
| 鐣墽璇︽儏 | 鉁?getBangumiInfoByID | 鉁?宸插疄鐜?| 鏃?|
| 鐣墽灏侀潰/绠€浠?璇勫垎 | 鉁?瀹屾暣灞曠ず | 鉁?宸插疄鐜帮紙缁熶竴璇︽儏椤靛ご閮細灏侀潰/鏍囬/璇勫垎/鏃ユ湡锛?| 鏃?|
| 鐣墽鏃堕棿琛?| 鉁?getCalendar + 瀛ｅ害妫€绱?瀛ｈ妭绱㈠紩/鎺掑簭/鏀惰棌杩囨护 | 鉁?宸插疄鐜帮紙timeline.js锛氭湰鍛ㄦ斁閫?+ 杩?20 骞村搴︽绱€佺儹搴?璇勫垎/鎾嚭鎺掑簭銆佹敹钘忚繃婊ゃ€佹帓鍚嶈鏍囷級 | 鏃?|
| 鐣墽姒滃崟 | 鉁?getBangumiTrendsList | 鉁?宸插疄鐜帮紙bangumi_trends 绔偣锛?| 鏃?|
| 鐣墽鍏宠仈 | 鉁?getBangumiRelationsByID | 鉁?宸插疄鐜帮紙缁熶竴璇︽儏椤靛叧鑱旈〉绛撅級 | 鏃?|
| 鐣墽鍒嗛泦淇℃伅 | 鉁?getBangumiEpisodeByID | 鉁?宸插疄鐜帮紙缁熶竴璇︽儏椤靛垎闆嗛〉绛?Bangumi-only 姒傝鍒嗛泦锛?| 鏃?|
| 鐣墽璇勮 | 鉁?getBangumiCommentsByID | 鉁?宸插疄鐜帮紙缁熶竴璇︽儏椤靛悙妲介〉绛撅級 | 鏃?|
| 瑙掕壊/Staff | 鉁?getBangumiStaffByID / getCharatersByBangumiID | 鉁?宸插疄鐜帮紙缁熶竴璇︽儏椤佃鑹?鍒朵綔椤电锛?| 鏃?|
| 鐢ㄦ埛鏀惰棌鍚屾 | 鉁?updateBangumiById | 鉁?宸插疄鐜帮紙璁剧疆椤?Bangumi 鍚屾鍗★細token 绠＄悊/娴嬭瘯杩炴帴/鎴戠殑鏀惰棌/鍒犻櫎锛涚粺涓€璇︽儏椤垫敹钘忔寜閽悓姝ワ紱T74 鏀惰棌鍐欏叆璧?POST/PUT 脳 `-`/鐪熷疄鐢ㄦ埛鍚?脳 瀹樻柟/闀滃儚鐭╅樀锛?| 鏃?|

---

## 4. 鎾斁鍣ㄤ笌濯掍綋鏈嶅姟

| 鍔熻兘 | Kazumi 鍘熺増 | yuki 鐜扮姸 | 宸窛 |
|------|------------|--------------|------|
| 鎾斁鍣?| 鉁?media_kit锛坢pv/libmpv锛?| 鉁?宸插疄鐜帮紙mpv 鐙珛绐楀彛锛?| 鏃?|
| 纭欢鍔犻€?| 鉁?鏀寔 | 鉁?宸插疄鐜?| 鏃?|
| 楂樺埛閫傞厤 | 鉁?鏀寔 | 鉁?宸插疄鐜?| 鏃?|
| 鍊嶉€熸挱鏀?| 鉁?鏀寔 | 鉁?宸插疄鐜?| 鏃?|
| 鎾斁浣嶇疆璁板繂 | 鉁?鏀寔 | 鉁?宸插疄鐜帮紙watch-later锛?| 鏃?|
| 鑷姩杩炴挱 | 鉁?鏀寔 | 鉁?宸插疄鐜帮紙娓叉煋灞傞┍鍔級 | 鏃?|
| Anime4K 瓒呭垎 | 鉁?涓夋。浣?| 鉁?宸插疄鐜帮紙涓夋。浣嶏級 | 鏃?|
| 澶栭儴鎾斁鍣?| 鉁?MethodChannel | 鉁?宸插疄鐜帮紙VLC 鑷姩鎺㈡祴 + 鑷畾涔夎矾寰?+ Referer 娉ㄥ叆锛?| 鏃?|
| 鐢讳腑鐢伙紙PiP锛?| 鉁?Android PiP + 妗岄潰 mini 绐?| 鉁?宸插疄鐜帮紙鏃犺竟妗嗙疆椤?mini 绐?320x180锛?| 鏃?|
| 鎴睆 | 鉁?PlayerScreenshotService | 鉁?宸插疄鐜帮紙mpv screenshot-to-file锛屽揩鎹烽敭 s 瀛樺浘锛宻ettings 鎵撳紑鎴浘鐩綍锛?| 鏃?|
| 瀹氭椂鍏虫満 | 鉁?TimedShutdownService | 鉁?宸插疄鐜帮紙N 鍒嗛挓鍊掕鏃?鈫?鍋?mpv 鈫?绯荤粺鍏虫満锛?| 鏃?|
| DLNA 鎶曞睆 | 鉁?dlna_dart | 鉁?宸插疄鐜帮紙UPnP SSDP 鍙戠幇 + SetAVTransportURI/Play/Stop锛?| 鏃?|
| 闊抽浼氳瘽 | 鉁?audio_service / audio_session | 鉂?鏈疄鐜帮紙妗岄潰绔棤绯荤粺濯掍綋鎺у埗鍣級 | 鍙悗缁ˉ鍏?|
| 寮瑰箷娓叉煋 | 鉁?canvas_danmaku | 鈴?浜у搧鍔熻兘鍏抽棴锛屼繚鐣?ASS/API 鍩虹 | 涓嶅垪鍏ュ綋鍓嶅緟鍔?|

---

## 5. 寮瑰箷绯荤粺

| 鍔熻兘 | Kazumi 鍘熺増 | yuki 鐜扮姸 | 宸窛 |
|------|------------|--------------|------|
| 寮瑰箷 API | 鉁?DanDanPlay 寮€鏀惧钩鍙?| 鉁?淇濈暀鍏煎瀹炵幇锛圚MAC-SHA256 绛惧悕锛?| 浜у搧鏈惎鐢?|
| 寮瑰箷绛惧悕 | 鉁?HMAC-SHA256 | 鉁?宸插疄鐜?| 浜у搧鏈惎鐢?|
| 寮瑰箷鏁版嵁妯″瀷 | 鉁?DanmakuEntry / DanmakuEpisodeResponse | 鉁?宸插疄鐜?| 浜у搧鏈惎鐢?|
| 寮瑰箷娓叉煋 | 鉁?canvas_danmaku | 鈴?浜у搧鑼冨洿澶?| 涓嶅垪鍏ュ綋鍓嶅緟鍔?|
| 寮瑰箷寮€鍏?閫熷害 | 鉁?PlayerDanmakuController | 鈴?浜у搧鑼冨洿澶?| 涓嶅垪鍏ュ綋鍓嶅緟鍔?|
| 绂荤嚎寮瑰箷 | 鉁?涓嬭浇鏃剁紦瀛樺脊骞?JSON | 鈴?浜у搧鑼冨洿澶?| 涓嶅垪鍏ュ綋鍓嶅緟鍔?|
| 寮瑰箷灞忚斀 | 鉁?灞忚斀璇嶅垪琛?| 鈴?浜у搧鑼冨洿澶?| 涓嶅垪鍏ュ綋鍓嶅緟鍔?|

---

## 6. 涓嬭浇绯荤粺

| 鍔熻兘 | Kazumi 鍘熺増 | yuki 鐜扮姸 | 宸窛 |
|------|------------|--------------|------|
| 涓嬭浇绠＄悊 | 鉁?DownloadManager | 鉁?宸插疄鐜帮紙aria2c + HLS 鍚堟垚锛?| 鏃?|
| M3U8 涓嬭浇 | 鉁?鍒嗘涓嬭浇 + 骞垮憡杩囨护 + 鏂偣缁紶 | 鉁?宸插疄鐜帮紙ffmpeg 鍚堟垚锛?| 鏃?|
| 鐩存帴涓嬭浇 | 鉁?Range 鏂偣缁紶 | 鉁?宸插疄鐜帮紙aria2c锛?| 鏃?|
| 涓嬭浇閫氱煡 | 鉁?flutter_foreground_task | 鉁?宸插疄鐜帮紙绯荤粺閫氱煡锛?| 鏃?|
| 涓嬭浇璁板綍 | 鉁?DownloadRecord / DownloadEpisode | 鉁?宸插疄鐜帮紙dl-records.json 鎸佷箙鍖栵紝璺ㄩ噸鍚仮澶嶏紝鍒犻櫎/娓呴櫎鍚屾锛?| 鏃?|
| 寮瑰箷缂撳瓨 | 鉁?涓嬭浇鏃剁紦瀛樺脊骞?| 鈴?浜у搧鑼冨洿澶?| 涓嶅垪鍏ュ綋鍓嶅緟鍔?|

---

## 7. 鍚屾鏈嶅姟

| 鍔熻兘 | Kazumi 鍘熺増 | yuki 鐜扮姸 | 宸窛 |
|------|------------|--------------|------|
| WebDAV 鍚屾 | 鉁?webdav_client | 鉁?宸插疄鐜帮紙鏀惰棌/鍘嗗彶/瑙勫垯涓婁紶/鎭㈠锛?| 鏃?|
| Bangumi 鍚屾 | 鉁?BangumiSyncService | 鉁?宸插疄鐜帮紙Access Token 鏀惰棌鍚屾锛氱粺涓€璇︽儏椤佃拷鐣?+ 璁剧疆椤垫敹钘忕鐞嗭級 | 鏃?|
| 涓€璧风湅锛圫yncPlay锛?| 鉁?SyncPlay 鍗忚瀹㈡埛绔?| 鉁?宸插疄鐜帮紙TCP+TLS锛孒ello/State/Set/Chat 鍗忚锛?| 鏃?|
| 璺ㄨ澶囧悓姝?| 鉁?WebDAV + Bangumi | 鉁?宸插疄鐜帮紙WebDAV 鏀惰棌/鍘嗗彶 + Bangumi 鏀惰棌鍙屽悜鍚屾锛?| 鏃?|

---

## 8. WebView 瀛愮郴缁?

| 鍔熻兘 | Kazumi 鍘熺増 | yuki 鐜扮姸 | 宸窛 |
|------|------------|--------------|------|
| 瑙嗛婧愯В鏋?WebView | 鉁?澶氬钩鍙板疄鐜?| 鉁?宸插疄鐜帮紙Electron BrowserWindow 涓夋満鍒讹細webRequest 鎷︽埅 + JS 娉ㄥ叆杞 + iframe 鐩戝惉锛?| 鏃?|
| 楠岃瘉鐮?WebView | 鉁?CaptchaWebviewController | 鈿狅笍 鍩虹璇嗗埆 + 鎵嬪姩杩囬獙璇?| 闇€鑷姩杩囬獙璇?|
| 寮傛浼氳瘽 | 鉁?AsyncSession / AsyncSerialQueue / AsyncSingleFlight | 鉁?宸插疄鐜帮紙AsyncSingleFlight 鍚?key 骞跺彂鍘婚噸 / AsyncSerialQueue FIFO 涓茶锛屾帴鍏?captureDirect 鍘婚噸锛?| 鏃?|

---

## 9. 椤甸潰涓?UI

| 鍔熻兘 | Kazumi 鍘熺増 | yuki 鐜扮姸 | 宸窛 |
|------|------------|--------------|------|
| 棣栭〉 | 鉁?PopularPage | 鉁?宸插疄鐜帮紙CatVod 棣栭〉 + 銆屾帹鑽愩€岯angumi 瓒嬪娍姒滐紝T62锛?| 鏃?|
| 鐣墽鏃堕棿琛?| 鉁?TimelinePage | 鉁?宸插疄鐜帮紙timeline.js + Bangumi API锛氭湰鍛ㄦ斁閫併€佽繎 20 骞村鑺傜储寮曘€佹帓搴忋€佹敹钘忚繃婊ゃ€佹帓鍚?璇勫垎灞曠ず銆佺粺涓€璇︽儏椤碉級 | 鏃?|
| 杩界暘鍒楄〃 | 鉁?CollectPage | 鉁?宸插疄鐜帮紙鏀惰棌杩涘害杩借釜 + 杩涘害鏉★級 | 鏃?|
| 鎴戠殑 | 鉁?MyPage锛堣鐪嬬粺璁?+ 鏈€杩戣鐪嬶級 | 鉁?宸插疄鐜帮紙瑙傜湅缁熻 + 鎴戠殑鏀惰棌锛涙渶杩戣鐪嬪苟鍏ュ乏渚у巻鍙查〉锛孴58 绉婚櫎锛?| 鏃?|
| 鎼滅储 | 鉁?SearchPage | 鉁?宸插疄鐜帮紙鑱氬悎鎼滅储锛?| 鏃?|
| 浠ュ浘鎼滅暘 | 鉁?ImageSearchPage | 鉁?宸插疄鐜帮紙URL/base64 涓婁紶锛?| 鏃?|
| 璇︽儏椤?| 鉁?InfoPage | 鉁?宸插疄鐜帮紙T74 缁熶竴璇︽儏椤?#view-detail锛欳atVod 婧?Bangumi-only 鑷€傚簲锛屾瑙?鍒嗛泦/瑙掕壊/璇勮/鍏宠仈/鍒朵綔锛屾敹钘忓悓姝?+ 寮€濮嬭鐪嬶紱鍘?#view-bangumi-info 宸茬Щ闄わ級 | 鏃?|
| 鎾斁椤?| 鉁?VideoPage | 鉁?宸插疄鐜帮紙mpv 鐙珛绐楀彛锛涘脊骞曚笉鍦ㄥ綋鍓嶄骇鍝佽寖鍥达級 | 鏃?|
| 涓嬭浇椤?| 鉁?DownloadPage | 鉁?宸插疄鐜帮紙涓嬭浇绠＄悊锛?| 鏃?|
| 鍘嗗彶椤?| 鉁?HistoryPage | 鉁?宸插疄鐜帮紙鍘嗗彶璁板綍锛?| 鏃?|
| 璁剧疆椤?| 鉁?SettingsPage | 鉁?宸插疄鐜帮紙璁剧疆涓績 + Kazumi 瑙勫垯鏉垮潡 + WebDAV 鍚屾锛?| 鏃?|
| 瑙勫垯缂栬緫鍣?| 鉁?PluginEditorPage | 鉁?宸插疄鐜帮紙鍙鍖栬〃鍗曠紪杈?+ 娴嬭瘯锛?| 鏃?|
| 瑙勫垯鍟嗗簵 | 鉁?PluginShopPage | 鉁?宸插疄鐜帮紙鍦ㄧ嚎鍟嗗簵寮圭獥锛?| 鏃?|
| 棣栨寮曞 | 鉁?OnboardingPage | 鉁?宸插疄鐜帮紙娆㈣繋寮圭獥 + 蹇€熶笂鎵嬫寚鍗楋級 | 鏃?|
| 鏃ュ織鏌ョ湅 | 鉁?LogsPage | 鉁?宸插疄鐜帮紙鍒嗛〉鏃ュ織鏌ョ湅鍣ㄥ脊绐楋級 | 鏃?|
| 鍏充簬椤?| 鉁?AboutPage | 鉁?宸插疄鐜帮紙鐙珛瑙嗗浘锛氬簲鐢ㄦ爣璇?鐗堟湰/鎶€鏈爤/鑷磋阿/绯荤粺淇℃伅锛?| 鏃?|

---

## 10. 涓婚涓庡浗闄呭寲

| 鍔熻兘 | Kazumi 鍘熺増 | yuki 鐜扮姸 | 宸窛 |
|------|------------|--------------|------|
| 涓婚鑹?| 鉁?鍔ㄦ€佽壊 + 棰勮涓婚 | 鉁?宸插疄鐜帮紙6 濂楀唴缃?+ 鑷畾涔夛級 | 鏃?|
| 鏄庢殫妯″紡 | 鉁?auto/light/dark | 鉁?宸插疄鐜?| 鏃?|
| 澹佺焊 | 鉁?鏀寔 | 鉁?宸插疄鐜?| 鏃?|
| 瀛椾綋 | 鉁?MiSans 鍐呯疆 | 鉁?宸插疄鐜帮紙download-binaries misans 涓嬭浇瀛愰泦鍖?woff2锛屾湭灏辩华鍥為€€绯荤粺瀛椾綋锛?| 鏃?|
| 鍥介檯鍖?| 鉁?浠呯畝浣撲腑鏂?| 鉁?宸插疄鐜帮紙纭紪鐮佷腑鏂囷級 | 鏃?|

---

## 11. 骞冲彴閰嶇疆

| 鍔熻兘 | Kazumi 鍘熺増 | yuki 鐜扮姸 | 宸窛 |
|------|------------|--------------|------|
| 骞冲彴鏀寔 | 鉁?Android/Windows/macOS/Linux/iOS/HarmonyOS | 鈿狅笍 Windows锛圗lectron 璺ㄥ钩鍙颁絾鏈祴 macOS/Linux锛?| 闇€澶氬钩鍙版祴璇?|
| 浠ｇ爜绛惧悕 | 鉁?SignPath | 鉂?鏈疄鐜?| 鍙悗缁ˉ鍏?|
| 鑷姩鏇存柊 | 鉁?upgrader | 鉂?鏈疄鐜?| 鍙悗缁ˉ鍏?|
| CI/CD | 鉁?GitHub Actions | 鉂?鏈疄鐜?| 鍙悗缁ˉ鍏?|

---

## 12. 娴嬭瘯涓?CI

| 鍔熻兘 | Kazumi 鍘熺増 | yuki 鐜扮姸 | 宸窛 |
|------|------------|--------------|------|
| 鍗曞厓娴嬭瘯 | 鉁?16 涓祴璇曟枃浠?| 鉁?宸插疄鐜帮紙55 涓?Kazumi 娴嬭瘯 + smoke 13 + phase3 25锛?| 鏃?|
| 缁勪欢娴嬭瘯 | 鉁?widget 娴嬭瘯 | 鉁?宸插疄鐜帮紙node --test 27 涓?JS 鍗曟祴锛歞ownloader/mpv-player/hls-filter/dl-record锛?| 鏃?|
| CI | 鉁?pr.yaml / release.yaml | 鉂?鏈疄鐜?| 鍙悗缁ˉ鍏?|

---

## 13. 鍘熶紭鍏堢骇缁撴灉

浠ヤ笅鏄暣鍚堥樁娈典娇鐢ㄨ繃鐨勪紭鍏堢骇娓呭崟銆傚綋鍓嶅緟鍔炰互 [../PROGRESS.md](../PROGRESS.md) 涓哄噯銆?

### 楂樹紭鍏堢骇
1. **鐣墽鏃堕棿琛?*锛欱angumi 姣忔棩鏀鹃€併€傗渽 宸插疄鐜?
2. **杩界暘鍒楄〃**锛氭敹钘?+ 瑙傜湅杩涘害杩借釜銆傗渽 宸插疄鐜?
3. **瀹屾暣璇︽儏椤?*锛欱angumi 鐣墽璇︽儏锛堣鑹?璇勮/鍏宠仈/鍒朵綔浜哄憳锛夈€傗渽 宸插疄鐜?
4. **寮瑰箷绯荤粺**锛欰PI 涓庡熀纭€浠ｇ爜宸叉帴鍏ワ紱浜у搧鍔熻兘鍚庢潵鏄庣‘鍏抽棴锛屼笉鍐嶇户缁ˉ娓叉煋寮曟搸銆?
5. **浠ュ浘鎼滅暘**锛歵race.moe 鍥剧墖璇嗗埆銆傗渽 宸插疄鐜?

### 涓紭鍏堢骇锛堝凡瀹屾垚锛?
6. **瑙勫垯缂栬緫鍣?*锛氬彲瑙嗗寲缂栬緫 XPath/JSONPath銆傗渽 宸插疄鐜?
7. **瑙勫垯娴嬭瘯闈㈡澘**锛氭祴璇曡鍒欐悳绱?鍓ч泦瑙ｆ瀽銆傗渽 宸插疄鐜?
8. **WebDAV 鍚屾**锛氳法璁惧鏀惰棌/鍘嗗彶鍚屾銆傗渽 宸插疄鐜?
9. **涓€璧风湅锛圫yncPlay锛?*锛氬浜哄悓姝ユ挱鏀俱€傗渽 宸插疄鐜?
10. **DLNA 鎶曞睆**锛氭姇灞忓埌鐢佃銆傗渽 宸插疄鐜?

### 浣庝紭鍏堢骇锛堝凡瀹屾垚锛?
11. **澶栭儴鎾斁鍣?*锛歏LC 鑷姩鎺㈡祴 + 鑷畾涔夎矾寰?+ Referer 娉ㄥ叆銆傗渽 宸插疄鐜?
12. **鐢讳腑鐢?*锛氭闈?mini 绐楋紙鏃犺竟妗嗙疆椤?320x180锛夈€傗渽 宸插疄鐜?
13. **瀹氭椂鍏虫満**锛歂 鍒嗛挓鍊掕鏃?鈫?鍋?mpv 鈫?绯荤粺鍏虫満銆傗渽 宸插疄鐜?
14. **鏃ュ織鏌ョ湅鍣?*锛氬垎椤垫煡鐪嬪簲鐢ㄦ棩蹇椼€傗渽 宸插疄鐜?
15. **棣栨寮曞**锛氭柊鐢ㄦ埛鍚戝銆傗渽 宸插疄鐜?

---

## 14. 鎶€鏈€哄姟涓庨闄?

1. **寮瑰箷鍏煎浠ｇ爜**锛氳嫢鏈潵閲嶆柊鍚敤寮瑰箷锛岄渶瑕佺敵璇?`DANDANAPI_APPID`/`DANDANAPI_KEY` 骞堕噸鏂拌瘎浼版覆鏌撴柟妗堬紱褰撳墠涓嶅睘浜庝骇鍝佸緟鍔炪€?
2. **Bangumi 闀滃儚绛惧悕**锛欱angumi 闀滃儚 API 鐨勭鍚嶇鐐癸紙KAZUMI_APPID/KAZUMI_KEY锛夋湭鐢宠鍓嶉儴鍒嗙鐐逛笉鍙敤锛涚敤鎴锋敹钘忓悓姝ヨ蛋鐨勬槸 Access Token锛堝凡鎺ュ叆锛夈€?
3. **楠岃瘉鐮佽嚜鍔ㄨ繃楠岃瘉**锛氬綋鍓嶄粎瀹炵幇鎵嬪姩杩囬獙璇侊紝鑷姩杩囬獙璇佸鏉傚害楂樸€?
4. **Cookie 鎸佷箙鍖?*锛氬凡瀹炵幇锛堥獙璇佸悗 Cookie 钀界洏锛岄噸鍚鐢級锛涗絾浠呰鐩栬В鏋愪細璇濓紝楠岃瘉鐮侀〉闇€鍐嶆鎵嬪姩杩囬獙璇佹椂鑷姩杩囬獙璇佹湭瑕嗙洊銆?
5. **瑙嗛婧愯В鏋愭睜**锛氬凡瀹炵幇锛? 妲戒綅鐙珛 partition 骞跺彂瑙ｆ瀽锛夛紱鍓嶇鎵归噺瑙ｆ瀽浠嶄覆琛岋紝姹犱负骞跺彂棰勭暀銆?
6. **寮瑰箷娓叉煋**锛歮pv 鐙珛绐楀彛鏃犳硶鐩存帴鍙犲姞鍓嶇寮瑰箷銆傝鍔熻兘褰撳墠鍏抽棴锛屽彧鏈夐噸鏂拌繘鍏ヤ骇鍝佽寖鍥存椂鎵嶉渶瑕佽璁￠澶栨覆鏌撳眰銆?
7. **鏈崟鑾峰紓甯稿厹搴?*锛氬凡娣诲姞鍏ㄥ眬 process.on('uncaughtException') 鍏滃簳闃茶繘绋嬪穿婧冦€?
8. **HLS 骞垮憡杩囨护**锛氫笅杞借矾寰勫凡瀹炵幇锛圕UE-OUT/CUE-IN + 骞垮憡璺緞鍒嗘锛岃缃紑鍏筹級锛涙挱鏀捐矾寰勶紙mpv 瀹炴椂杩囨护锛夋湭瀹炵幇銆?

---

## 15. 鍔熻兘缁熻

| 绫诲埆 | 宸插畬鎴?| 閮ㄥ垎瀹炵幇 | 寤跺悗 | 鑼冨洿澶?|
|------|--------|---------|------|--------|
| 鏍稿績瑙勫垯绯荤粺 | 14 | 0 | 0 | 0 |
| 瑙嗛婧愯幏鍙?| 7 | 1 | 0 | 0 |
| 鐣墽鍏冩暟鎹?| 10 | 0 | 0 | 0 |
| 鎾斁鍣ㄤ笌濯掍綋 | 11 | 0 | 1 | 1 |
| 寮瑰箷绯荤粺 | 3 | 0 | 0 | 4 |
| 涓嬭浇绯荤粺 | 5 | 0 | 0 | 1 |
| 鍚屾鏈嶅姟 | 4 | 0 | 0 | 0 |
| WebView | 2 | 1 | 0 | 0 |
| 椤甸潰涓?UI | 16 | 0 | 0 | 0 |
| 涓婚涓庡浗闄呭寲 | 5 | 0 | 0 | 0 |
| 骞冲彴閰嶇疆 | 0 | 1 | 3 | 0 |
| 娴嬭瘯涓?CI | 2 | 0 | 1 | 0 |
| **鍚堣** | **79** | **3** | **5** | **6** |

> 褰撳墠浜у搧鑼冨洿鎺掗櫎 6 涓脊骞曠浉鍏抽」鐩紝鍓╀綑 87 椤逛腑瀹屾垚 79 椤癸紝瀹屾垚鐜囩害 91%銆傗€滃欢鍚庘€濅富瑕佹槸妗岄潰闊抽浼氳瘽銆佺鍚嶃€佽嚜鍔ㄦ洿鏂板拰 CI/CD锛涒€滈儴鍒嗗疄鐜扳€濅富瑕佹槸楠岃瘉鐮佽嚜鍔ㄥ寲涓庤法骞冲彴楠岃瘉銆?

---

*鏈枃妗ｅ熀浜?Kazumi v2.2.6 婧愮爜锛坙ib/ 321 涓枃浠讹級涓?yuki 褰撳墠瀹炵幇瀵规瘮鏁寸悊銆?
