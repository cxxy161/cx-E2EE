/**
 * detect/deps.js — 依赖握手（经典脚本 → ES 模块）
 *
 * 为什么需要这么一个小文件
 * -----------------------
 * src/image-crypto.js 是经典脚本，它的 `const IA` / `const MOB` / `$` / `T` 是顶层词法声明。
 * detect-ui.mjs 是 ES 模块，要用这些对象。与其赌"模块能不能看见经典脚本的全局词法绑定"
 * 这种依赖引擎细节的行为，不如在这里显式转交一次：模块只认 window.__CX_DETECT。
 *
 * 这样也顺带解决了加载顺序问题：本文件一定排在 image-crypto.js 之后、模块之前。
 */
(function () {
    'use strict';
    window.__CX_DETECT = {
        MOB: typeof MOB !== 'undefined' ? MOB : null,
        IA: typeof IA !== 'undefined' ? IA : null,
        T: typeof T !== 'undefined' ? T : null,
        $: typeof $ !== 'undefined' ? $ : function (id) { return document.getElementById(id); },
        StaticHost: typeof StaticHost !== 'undefined' ? StaticHost : null,
    };
})();
