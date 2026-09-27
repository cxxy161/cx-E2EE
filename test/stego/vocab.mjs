/* ═══════════════════════════════════════════════════════════════════
 * Mock 词表（4096 token）—— 真 vocab.bin 到货前占位
 * ═══════════════════════════════════════════════════════════════════
 *
 * 接口约定（与真 vocab.bin 一致）：
 *   token_id → UTF-8 字节串，客户端只做查表，不跑 BPE 分词。
 *
 * ⚠️ 本 mock **刻意植入对抗样本**，用于逼出过滤器的缺陷：
 *   - prefix 冲突对（"我"/"我们"、"系"/"系统"）→ 未做 prefix-free 时解码会歧义
 *   - 含换行 token（"好\n"、"\n"、"。\r"）      → 若不过滤，段体带换行，剪贴板被折叠
 *   - 含空格 token（" 好"）                      → 若不过滤，粘贴丢空格就错位
 *   - 非汉字 token（"abc"、"123"）               → 若不过滤，一眼看出是机器文本
 *   - 超长 token（5 字）                          → 观察膨胀率被拉高的程度
 *
 * 真词表到货后：只替换 buildMockVocab 的数据源，接口与测试全部复用。
 */

// 常用汉字池（够生成 4096 个唯一 token）
const HANZI_POOL = [...'的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日军者意无力它与长把机十民第公此已工使情明性知全三又关点正业外将两高间由问很最重并物手应战向头文体政美相见被利什二等产或新己制身果加西斯月话合回特代内信表化老给世位次度门任常先海通教儿原东声提立及比员解水名真论处走义各入几口认条平系气题活尔更别打女变四神总何电数安少报才结反受目太量再感建务做接必场件计管期市直德资命山金指克许统区保至队形社便空决治展马科司五基眼书非则听白却界达光放强即像难且权思王象完设式色路记南品住告类求据程北边死张该交规万取拉格望觉术领共确传师观清今切院让识候带导争运笑飞风步改收根干造言联持组每济车亲极林服快办议往元英士证近失转夫令准布始怎呢存未远叫台单影具罗字爱击流备兵连调深商算质团集百需价花党华城石级整府离况亚请技际约示复病息究线似官火断精满支视消越器容照须九增研写称企八功吗包片史委乎查轻易早曾除农找装广显吧阿李标谈吃图念六引历首医局突专费号尽另周较注语仅考落青随选列武红响虽推势参希古众构房半节土投某案黑维革划敌致陈律足态护七兴派孩验责营星够章音跟志底站严巴例防族供效续施留讲型料终答紧黄绝奇察母京段依批群项故按河米围江织害斗双境客纪采举杀攻父苏密低朝友诉止细愿千值仍男钱破网热助倒育属坐帝限船脸职速刻乐否刚威毛状率甚独球般普怕弹校苦创假久错承印晚兰试股拿脑预谁益阳若哪微尼继送急血惊伤素药适波夜省初喜卫源食险待述陆习置居劳财环排福纳欢雷警获模充负云停木游龙树疑层冷洲冲射略范竟句室异激汉村哈策演简卡罪判担州静退既衣您宗积余痛检差富灵协角占配征修皮挥胜降阶审沉坚善妈刘读啊超免压银买皇养伊怀执副乱抗犯追帮宣佛岁航优怪香著田铁控税左右份穿艺背阵草脚概恶块顿敢守酒岛托央户烈洋哥索胡款靠评版宝座释景顾弟登货互付伯慢欧换闻危忙核暗姐介坏讨丽良序升监临亮露永呼味野架域沙掉括舰鱼杂误湾吉减编楚肯测败屋跑梦散温困剑渐封救贵枪缺楼县尚毫移娘朋画班智亦耳恩短掌恐遗固席松秘谢鲁遇康虑幸均销钟诗藏赶剧票损忽巨炮旧端探湖录叶春乡附吸予礼港雨呀板庭妇归睛饭额含顺输摇招婚脱补谓督毒油疗旅泽材灭逐莫笔亡鲜词圣择寻厂睡博勒烟授诺伦岸奥唐卖俄炸载洛健堂旁宫喝借君禁阴园谋宋避抓荣姑孙逃牙束跳顶玉镇雪午练迫爷篇肉嘴馆遍凡础洞卷坦牛宁纸诸训私庄祖丝翻暴森塔默握戏隐熟骨访弱蒙歌店鬼软典欲萨伙遭盘爸扩盖弄雄稳'];

export function isAllowedChar(ch) {
    const c = ch.codePointAt(0);
    if (c >= 0x4e00 && c <= 0x9fff) return true;                 // CJK 统一汉字
    if ('，。！？、；：（）《》“”‘’…—'.includes(ch)) return true;   // 中文标点白名单
    return false;                                                // 空格/换行/ASCII 一律拒
}

export function buildMockVocab({ size = 4096, mix = [[1, 30], [2, 40], [3, 20], [4, 10]] } = {}) {
    const tokens = [];

    // ── 对抗样本（固定 id 0..10） ──
    const planted = [
        '我', '我们',            // 0,1  prefix 冲突对
        '系', '系统',            // 2,3  prefix 冲突对
        '好\n', '\n', '。\r',    // 4,5,6 含换行
        ' 好',                   // 7    含空格
        'abc', '123',            // 8,9  非汉字
        '的的的的的',            // 10   5 字超长 token
    ];
    for (const t of planted) tokens.push(t);

    // ── 按 mix 生成填充，命中真实 BPE 的长度分布 ──
    let seed = 20240926;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const cum = []; let tot = 0;
    for (const [len, w] of mix) { tot += w; cum.push([len, tot]); }
    const pickLen = () => { const r = rnd() * tot; for (const [len, c] of cum) if (r <= c) return len; return 1; };

    const seen = new Set(tokens);
    let guard = 0;
    while (tokens.length < size && guard++ < size * 200) {
        const L = pickLen();
        let s = '';
        for (let i = 0; i < L; i++) s += HANZI_POOL[Math.floor(rnd() * HANZI_POOL.length)];
        if (seen.has(s)) continue;
        seen.add(s); tokens.push(s);
    }
    if (tokens.length < size) throw new Error('vocab 生成不足: ' + tokens.length);

    const enc = new TextEncoder();
    const bytes = tokens.map(t => enc.encode(t));
    const allowed = tokens.map(t => [...t].every(isAllowedChar));
    const nl = tokens.map(t => t.includes('\n') || t.includes('\r'));
    const sp = tokens.map(t => /\s/.test(t));

    return {
        size, tokens, bytes, allowed, nl, sp,
        adversarialIds: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        str: (id) => tokens[id],
        byteLen: (id) => bytes[id].length,
        hasNewline: (id) => nl[id],
        hasSpace: (id) => sp[id],
        isAllowed: (id) => allowed[id],
    };
}
