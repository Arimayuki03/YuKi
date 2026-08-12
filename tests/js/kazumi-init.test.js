'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

function loadKazumi(extra = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/kazumi.js'), 'utf8');
    let bindCount = 0;
    const jqueryStub = () => ({
        on() { bindCount++; return this; },
        off() { return this; },
        val() { return ''; },
        text() { return this; },
        html() { return this; },
        show() { return this; },
        hide() { return this; },
        empty() { return this; },
        append() { return this; },
        prop() { return this; },
        toggle() { return this; },
        length: 1,
    });
    const context = {
        console,
        Map,
        Promise,
        Date,
        Math,
        JSON,
        String,
        Array,
        parseInt,
        parseFloat,
        setTimeout,
        clearTimeout,
        $: jqueryStub,
        window: { vpc: {} },
        ...extra,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__testKazumi = Kazumi;`, context, { filename: 'kazumi.js' });
    return { kazumi: context.__testKazumi, bindCount: () => bindCount };
}

test('Kazumi.init 重复调用时只绑定一次事件', () => {
    const { kazumi, bindCount } = loadKazumi();
    let refreshCount = 0;
    kazumi._prefillBangumiToken = () => {};
    kazumi.refreshRuleList = () => { refreshCount++; };
    kazumi.init();
    const firstBindings = bindCount();
    kazumi.init();
    assert.ok(firstBindings > 0);
    assert.equal(bindCount(), firstBindings);
    assert.equal(refreshCount, 1);
});

test('kazumi.js 不再在文件加载阶段抢跑初始化', () => {
    const { kazumi, bindCount } = loadKazumi();
    assert.equal(kazumi._inited, false);
    assert.equal(bindCount(), 0);
});

test('openBangumiInfoPage 委托给统一详情页 Detail.openBangumi（T74 移除二级页）', async () => {
    let called = null;
    const app = { currentView: 'timeline', showViewCalls: [] };
    const { kazumi } = loadKazumi({
        App: app,
        Detail: { openBangumi: async (id, name) => { called = { id, name }; } },
    });
    kazumi._infoReferrer = '';
    await kazumi.openBangumiInfoPage('383233');
    assert.deepEqual(called, { id: '383233', name: '' });   // 委托给统一详情页
    assert.equal(kazumi._infoReferrer, 'timeline');          // 记录来源视图供返回
});
