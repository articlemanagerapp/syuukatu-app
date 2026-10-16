// iPhone のウィジェット(本体 widget/shukatsu-widget-module.js と、貼り付ける読み込み役 widget/shukatsu-widget.js)を、
// Scriptable の部品の代わりを使って PC で動かして確かめる。
// 使い方(このフォルダで): node tests/widget.mjs
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../widget/shukatsu-widget-module.js', import.meta.url), 'utf8');
const loaderSrc = fs.readFileSync(new URL('../widget/shukatsu-widget.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? '  … ' + detail : ''}`); };

const ymd = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const item = (company, title, o = {}) => ({ company, title, kind: 'es', date: '', time: '', end: '', track: '秋冬インターン', color: '#1971c2', link: '#/company/c1/e1', ...o });

// Scriptable の部品の代わり。描いた文字を集めて確かめる
function makeEnv({ widget = true, family = 'small', keychain = {}, respond, alerts = [] }) {
  const kc = new Map(Object.entries(keychain));
  const texts = [];
  const requests = [];
  let shown = null;
  class Stack {
    constructor() { this.children = []; }
    addText(s) { const t = { text: s }; texts.push(String(s)); this.children.push(t); return t; }
    addStack() { const st = new Stack(); this.children.push(st); return st; }
    addSpacer() {}
    layoutHorizontally() {} layoutVertically() {} centerAlignContent() {} setPadding() {}
  }
  class ListWidget extends Stack { presentSmall() { shown = 'small'; } presentMedium() { shown = 'medium'; } }
  class Request {
    constructor(url) { this.url = url; this.method = 'GET'; this.headers = {}; this.body = null; this.response = null; }
    async loadJSON() { requests.push(this); const r = await respond(this); this.response = { statusCode: r.status || 200 }; return r.json; }
  }
  const answers = [...alerts];
  class Alert {
    constructor() { this.fields = []; }
    addTextField() { this.fields.push(''); } addSecureTextField() { this.fields.push(''); }
    addAction() {} addCancelAction() {} addDestructiveAction() {}
    async present() { const a = answers.shift() || { index: -1 }; this.values = a.values || []; return a.index; }
    textFieldValue(i) { return this.values[i] || ''; }
  }
  let set = null;
  const env = {
    config: { runsInWidget: widget, runsInApp: !widget, widgetFamily: family },
    Keychain: { contains: k => kc.has(k), get: k => kc.get(k), set: (k, v) => kc.set(k, v), remove: k => kc.delete(k) },
    Request, ListWidget, Alert,
    Color: class { constructor(h) { this.hex = h; } },
    Font: { systemFont: s => ({ s }), boldSystemFont: s => ({ s, b: true }) },
    Size: class { constructor(w, h) { this.w = w; this.h = h; } },
    Script: { setWidget: w => { set = w; }, complete: () => {} },
  };
  return { env, kc, texts, requests, get widget() { return set; }, get shown() { return shown; } };
}
async function run(opts) {
  const E = makeEnv(opts);
  const names = Object.keys(E.env);
  const mod = { exports: {} };
  await new AsyncFunction(...names, 'module', src + '\nawait module.exports.run();')(...names.map(n => E.env[n]), mod);
  return E;
}
// 通信の代わり: ログイン・鍵の更新・中身の読み込み(Realtime Database の REST)
const server = ({ items = [], empty = false, denied = false, tokenError = '', down = false } = {}) => async req => {
  if (down) throw new Error('offline');
  if (req.url.includes('accounts:signInWithPassword')) {
    const b = JSON.parse(req.body);
    return b.password === 'pw123' ? { json: { refreshToken: 'R1', idToken: 'I1', localId: 'u1' } } : { status: 400, json: { error: { message: 'INVALID_LOGIN_CREDENTIALS' } } };
  }
  if (req.url.includes('securetoken.googleapis.com')) return tokenError ? { status: 400, json: { error: { message: tokenError } } } : { json: { id_token: 'I2', refresh_token: 'R2', user_id: 'u1' } };
  if (req.url.includes('firebasedatabase.app')) {
    if (denied) return { status: 401, json: { error: 'Permission denied' } };
    return { json: empty ? null : { v: 1, progress: 2, items, updatedAt: new Date().toISOString() } };
  }
  return { status: 500, json: {} };
};
const ITEMS = [
  item('秋商事', '終わった説明会', { kind: 'session', date: ymd(-3) }),
  item('秋商事', 'ES締切', { date: ymd(2), time: '23:59', link: '#/company/c2/e2' }),
  item('早期工業', '1次面接', { kind: 'interview', date: ymd(1), time: '10:00', track: '早期選考', color: '#7048e8' }),
  item('冬電機', '5daysインターン', { kind: 'intern', date: ymd(-1), end: ymd(3) }),
  item('本選考銀行', '適性検査', { kind: 'test', date: ymd(10) }),
];

console.log('ログインしていないとき');
let E = await run({ respond: server() });
check('ログインの案内が出る', E.texts.some(t => t.includes('ログインしてください')), E.texts.join(' / '));
check('通信はしない', E.requests.length === 0);

console.log('小');
E = await run({ keychain: { shukatsu_widget_refresh_token: 'R1' }, respond: server({ items: ITEMS }) });
check('終わった予定は出さない', !E.texts.includes('終わった説明会'), E.texts.join(' / '));
check('次の予定の企業名と題が出る', E.texts.includes('秋商事') && E.texts.includes('ES締切'), E.texts.join(' / '));
check('残り日数はその日の日付から計算(あと2日)', E.texts.includes('あと2日'));
check('日時が出る', E.texts.some(t => t.includes('23:59')));
check('区分名が出る', E.texts.some(t => t.includes('秋冬インターン')));
check('「そのあとに」は小には出さない', !E.texts.includes('そのあとに'));
check('押すとその企業の画面を開く', E.widget.url === 'https://articlemanagerapp.github.io/syuukatu-app/syuukatu-v3.html#/company/c2/e2', E.widget.url);
check('鍵は新しいものに置き換える', E.kc.get('shukatsu_widget_refresh_token') === 'R2');
check('読み込みは中身の1件だけ(鍵の更新+1件)', E.requests.length === 2 && E.requests[1].url.includes('/users/u1/widget.json?auth=I2'), E.requests.map(r => r.url).join(' '));
check('30分後に更新を頼む', E.widget.refreshAfterDate instanceof Date && E.widget.refreshAfterDate - Date.now() > 25 * 60 * 1000);

console.log('中');
E = await run({ family: 'medium', keychain: { shukatsu_widget_refresh_token: 'R1' }, respond: server({ items: ITEMS }) });
check('「そのあとに」と次の3件が出る', E.texts.includes('そのあとに') && E.texts.includes('早期工業 1次面接') && E.texts.includes('冬電機 5daysインターン') && E.texts.includes('本選考銀行 適性検査'), E.texts.join(' / '));
check('明日のものは「明日」', E.texts.includes('明日'));
check('始まっていて終わっていない日程は「開催中」', E.texts.includes('開催中'));
check('10日先は「あと10日」', E.texts.includes('あと10日'));

console.log('そのほか');
E = await run({ family: 'medium', keychain: { shukatsu_widget_refresh_token: 'R1' }, respond: server({ items: [] }) });
check('何もないときは「これからの予定はありません」', E.texts.includes('これからの予定はありません') && E.texts.includes('なし'));
E = await run({ keychain: { shukatsu_widget_refresh_token: 'R1' }, respond: server({ empty: true }) });
check('アプリをまだ開いていないときの案内', E.texts.some(t => t.includes('一度開くと表示されます')), E.texts.join(' / '));
E = await run({ keychain: { shukatsu_widget_refresh_token: 'R1', shukatsu_widget_cache: JSON.stringify({ items: [item('前回の会社', '面接', { date: ymd(0) })] }) }, respond: server({ down: true }) });
check('通信できないときは前回の内容と「オフライン」', E.texts.includes('前回の会社') && E.texts.includes('今日') && E.texts.some(t => t.includes('オフライン')), E.texts.join(' / '));
E = await run({ keychain: { shukatsu_widget_refresh_token: 'R1' }, respond: server({ denied: true }) });
check('読む権限がないときは「読み込めませんでした」', E.texts.some(t => t.includes('読み込めませんでした')), E.texts.join(' / '));
E = await run({ keychain: { shukatsu_widget_refresh_token: 'R1' }, respond: server({ tokenError: 'TOKEN_EXPIRED' }) });
check('鍵が無効になったら、ログインし直しの案内', E.texts.some(t => t.includes('ログインしてください')) && !E.kc.has('shukatsu_widget_refresh_token'));

console.log('Scriptable の中で開いたとき(ログイン)');
E = await run({ widget: false, respond: server(), alerts: [{ index: 0, values: ['me@example.com', 'pw123'] }, { index: 4 }] });
check('ログインすると鍵だけを保存する(パスワードは保存しない)', E.kc.get('shukatsu_widget_refresh_token') === 'R1' && ![...E.kc.values()].some(v => String(v).includes('pw123')));
E = await run({ widget: false, respond: server(), alerts: [{ index: 0, values: ['me@example.com', 'wrong'] }, { index: 0 }] });
check('パスワードが違うときは保存しない', !E.kc.has('shukatsu_widget_refresh_token'));
E = await run({ widget: false, keychain: { shukatsu_widget_refresh_token: 'R1' }, respond: server({ items: ITEMS }), alerts: [{ index: 1 }] });
check('「中の見え方を確かめる」で中を表示', E.shown === 'medium');
E = await run({ widget: false, keychain: { shukatsu_widget_refresh_token: 'R1', shukatsu_widget_cache: '{}' }, respond: server(), alerts: [{ index: 3 }] });
check('ログアウトで鍵と控えを消す', !E.kc.has('shukatsu_widget_refresh_token') && !E.kc.has('shukatsu_widget_cache'));

console.log('貼り付ける読み込み役');
// iPhone では長い文章を貼り付けると約1万文字で切れる。読み込み役は十分に短いこと
check('読み込み役は短い(3,000文字未満)', loaderSrc.length < 3000, `${loaderSrc.length}文字`);
const DIR = '/private/var/mobile/Library/Mobile Documents/iCloud~dk~simonbs~Scriptable/Documents';
async function runLoader({ files = {}, mtime = 0, down = false, code = 'module.exports = { run: async () => {} };' } = {}) {
  const fsm = new Map(Object.entries(files)), times = new Map(Object.keys(files).map(k => [k, new Date(mtime)]));
  const log = { fetched: 0, ran: 0, imported: '', shown: false, written: '' };
  const FM = {
    fileExists: p => fsm.has(p), modificationDate: p => times.get(p) || null,
    writeString: (p, s) => { fsm.set(p, s); times.set(p, new Date()); log.written = p; },
    joinPath: (a, b) => a + '/' + b, isFileStoredIniCloud: () => false, isFileDownloaded: () => true, downloadFileFromiCloud: async () => {},
  };
  const env = {
    module: { filename: DIR + '/就活管理.js' },
    FileManager: { iCloud: () => FM, local: () => FM },
    Request: class { constructor(u) { this.u = u; } async loadString() { log.fetched++; if (down) throw new Error('offline'); return code; } },
    importModule: name => { log.imported = name; return { run: async () => { log.ran++; } }; },
    ListWidget: class { addText() { return {}; } presentSmall() { log.shown = true; } },
    Color: class {}, Font: { systemFont: () => ({}) },
    config: { runsInWidget: true }, Script: { setWidget: () => { log.shown = true; }, complete: () => {} },
  };
  const names = Object.keys(env);
  await new AsyncFunction(...names, loaderSrc)(...names.map(n => env[n]));
  return { log, fsm };
}
const MODP = DIR + '/shukatsu-widget-module.js';
let L = await runLoader();
check('はじめては本体をダウンロードして、同じ場所に保存して動かす', L.log.fetched === 1 && L.log.written === MODP && L.log.imported === 'shukatsu-widget-module' && L.log.ran === 1, JSON.stringify(L.log));
L = await runLoader({ files: { [MODP]: 'module.exports={}' }, mtime: Date.now() - 3600 * 1000 });
check('保存して半日以内なら、ダウンロードしない', L.log.fetched === 0 && L.log.ran === 1);
L = await runLoader({ files: { [MODP]: 'module.exports={}' }, mtime: Date.now() - 13 * 3600 * 1000 });
check('半日たったら新しい本体に入れ替える', L.log.fetched === 1 && L.log.written === MODP && L.log.ran === 1);
L = await runLoader({ files: { [MODP]: 'module.exports={}' }, mtime: Date.now() - 13 * 3600 * 1000, down: true });
check('通信できないときは、保存してある本体で動かす', L.log.ran === 1 && L.fsm.get(MODP) === 'module.exports={}');
L = await runLoader({ down: true });
check('本体がなく通信もできないときは、案内を出す', L.log.ran === 0 && L.log.shown);
L = await runLoader({ code: '<html>Not Found</html>' });
check('本体でないもの(エラーのページなど)は保存しない', !L.fsm.has(MODP) && L.log.ran === 0 && L.log.shown);

console.log(`\n${pass} 件成功 / ${fail} 件失敗`);
process.exit(fail ? 1 : 0);
