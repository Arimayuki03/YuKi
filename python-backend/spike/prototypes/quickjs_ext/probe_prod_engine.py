import sys, os, json
sys.path.insert(0, os.path.abspath('.'))
sys.path.insert(0, os.path.abspath('js-engine'))

def mock_http(url, opt_json):
    return json.dumps({'ok': True, 'status': 200, 'code': 200,
                       'content': '<html><body><h1>Hi</h1></body></html>',
                       'headers': {}})

from quickjs_host import JsEngine
eng = JsEngine(site_key='prod_probe')
eng.ctx.add_callable('_native_http', mock_http)  # override with mock

rule = '''
var rule = {
    home: function() {
        var html = req('http://x/home');
        return JSON.stringify({ ok: true, len: html.length });
    }
};
var __jsEvalReturn = function() { return rule; };
export { __jsEvalReturn };
'''
try:
    ok = eng.load_spider(rule)
    print('load_spider:', ok)
    ret = eng.call('home')
    print('call home ret:', ret)
except Exception as e:
    print('PROD ENGINE FAILED:', type(e).__name__, str(e)[:160])
