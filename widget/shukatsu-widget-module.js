// 就活管理 ウィジェットの本体(Scriptable のモジュール)。研究管理アプリのウィジェットと同じ仕組み。
// iPhone に貼り付けるのは短い読み込み役(shukatsu-widget.js)だけ。読み込み役がこのファイルを
// https://articlemanagerapp.github.io/syuukatu-app/widget/shukatsu-widget-module.js から取ってきて保存し、run() を呼ぶ。
// (iPhone では長い文章を貼り付けると約1万文字で切れるため、本体は貼り付けずに読み込む)
// ・最初に Scriptable の中で開くと、就活管理アプリのメールアドレスとパスワードを聞かれる。
//   パスワードは保存しない(ログインし続けるための鍵だけを iPhone のキーチェーンに置く)。
// ・中身は就活管理アプリが保存のたびに Realtime Database の users/{uid}/widget に書いている。読むのは1回に1件だけ。
// ・残り日数(今日・明日・あと○日)は、表示のたびにその日の日付から計算し直す。終わった予定は出さない。

const APP_URL = 'https://articlemanagerapp.github.io/syuukatu-app/syuukatu-v3.html';
const API_KEY = 'AIzaSyB8-VCe66GK77czczFqJKIDqfTaC1jTi8g';
const DB_URL = 'https://shukatsu-app-ae30e-default-rtdb.asia-southeast1.firebasedatabase.app';
const KEY_TOKEN = 'shukatsu_widget_refresh_token';
const KEY_CACHE = 'shukatsu_widget_cache';

// アプリの左のメニューと同じ紺
const C = {
  bg: '#14213d', bg2: '#2a3a63', text: '#eef2fa', muted: '#aab6cf', label: '#ffffff', onLabel: '#14213d',
  red: '#ffb4a8', redFill: '#c8281f', soon: '#f3d48a', ongoing: '#b9cdf5',
};
const KIND_LABEL = { es: 'ES締切', test: '適性検査', session: '説明会', interview: '面接', intern: 'インターン', other: 'その他' };

/* ---------- 日付と言い方(アプリの countdown と同じ決まり) ---------- */
function toDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
function daysUntil(ymd, now) {
  const d = toDate(ymd);
  if (!d) return null;
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((d - t) / 86400000);
}
// 3日以内=赤、7日以内=黄、それより先=補足の色。始まっていて終わっていない日程は「開催中」
function reasonOf(it, now) {
  const d = daysUntil(it.date, now);
  if (d === null) return { text: '', color: C.muted, fill: null };
  if (d < 0) return { text: '開催中', color: C.ongoing, fill: null };
  if (d === 0) return { text: '今日', color: C.text, fill: C.redFill };
  if (d === 1) return { text: '明日', color: C.text, fill: C.redFill };
  return { text: `あと${d}日`, color: d <= 3 ? C.red : d <= 7 ? C.soon : C.muted, fill: null };
}
function md(ymd) {
  const d = toDate(ymd);
  return d ? `${d.getMonth() + 1}/${d.getDate()}(${'日月火水木金土'[d.getDay()]})` : '';
}
// 終わった予定(終了日・日付が今日より前)は出さない
function liveItems(p, now) {
  return ((p && p.items) || []).filter(it => {
    const d = daysUntil(it.end || it.date, now);
    return d !== null && d >= 0;
  });
}

/* ---------- ログインと読み込み ---------- */
async function postJson(url, body, form = false) {
  const r = new Request(url);
  r.method = 'POST';
  r.headers = { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' };
  r.body = form ? body : JSON.stringify(body);
  const json = await r.loadJSON();
  return { status: r.response ? r.response.statusCode : 0, json };
}
async function signIn(email, password) {
  const { json } = await postJson(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, { email, password, returnSecureToken: true });
  if (!json || !json.refreshToken) throw new Error(json && json.error ? json.error.message : 'ログインできませんでした');
  Keychain.set(KEY_TOKEN, json.refreshToken);
}
// 鍵(refresh token)から、読み込みに使う一時的な鍵(id token)をもらう
async function idToken() {
  if (!Keychain.contains(KEY_TOKEN)) return null;
  const { json } = await postJson(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, `grant_type=refresh_token&refresh_token=${encodeURIComponent(Keychain.get(KEY_TOKEN))}`, true);
  if (!json || !json.id_token) {
    const msg = json && json.error ? (json.error.message || '') : '';
    // 鍵が無効になった(パスワード変更など)ときはログインし直してもらう
    if (/TOKEN_EXPIRED|INVALID_REFRESH_TOKEN|USER_NOT_FOUND|USER_DISABLED/.test(msg)) { Keychain.remove(KEY_TOKEN); return null; }
    throw new Error(msg || '通信できませんでした');
  }
  if (json.refresh_token) Keychain.set(KEY_TOKEN, json.refresh_token);
  return { token: json.id_token, uid: json.user_id };
}
async function loadPayload() {
  const auth = await idToken();
  if (!auth) return { state: 'login' };
  const r = new Request(`${DB_URL}/users/${auth.uid}/widget.json?auth=${encodeURIComponent(auth.token)}`);
  const json = await r.loadJSON();
  const status = r.response ? r.response.statusCode : 0;
  if (status >= 400 || (json && json.error)) throw new Error(json && json.error ? String(json.error) : '読み込めませんでした');
  if (!json) return { state: 'empty-app' };
  Keychain.set(KEY_CACHE, JSON.stringify(json));
  return { state: 'ok', p: json };
}

/* ---------- 描く ---------- */
function txt(stack, s, size, color, bold = false, lines = 1) {
  const t = stack.addText(String(s));
  t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  t.textColor = new Color(color);
  t.lineLimit = lines;
  t.minimumScaleFactor = 0.8;
  return t;
}
function label(stack, s, size) {
  const b = stack.addStack();
  b.backgroundColor = new Color(C.label);
  b.cornerRadius = 4;
  b.setPadding(1, 6, 1, 6);
  txt(b, s, size, C.onLabel, true);
}
// 「あと3日 10/20(月) 23:59」の行
function reasonLine(stack, it, now, size) {
  const r = reasonOf(it, now);
  const row = stack.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  if (r.text) {
    if (r.fill) {
      const b = row.addStack();
      b.backgroundColor = new Color(r.fill);
      b.cornerRadius = 4;
      b.setPadding(1, 5, 1, 5);
      txt(b, r.text, size, C.text, true);
    } else txt(row, r.text, size, r.color, true);
    row.addSpacer(6);
  }
  const when = [md(it.date), it.time || ''].filter(Boolean).join(' ');
  if (when) txt(row, when, size - 1, C.muted);
  return row;
}
// 区分の色の印と「区分名・種類」
function trackLine(stack, it, size) {
  const row = stack.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  const dot = row.addStack();
  dot.size = new Size(8, 8);
  dot.cornerRadius = 4;
  dot.backgroundColor = new Color(it.color || C.muted);
  row.addSpacer(5);
  txt(row, [it.track, KIND_LABEL[it.kind] && KIND_LABEL[it.kind] !== it.title ? KIND_LABEL[it.kind] : ''].filter(Boolean).join(' ・ '), size, C.muted);
}
// 中身から、小(small)または中(medium)のウィジェットを作る
function buildWidget(res, family, now) {
  const w = new ListWidget();
  w.backgroundColor = new Color(C.bg);
  w.setPadding(14, 14, 14, 14);
  w.url = APP_URL + '#/home';
  w.refreshAfterDate = new Date(now.getTime() + 30 * 60 * 1000);
  if (res.state === 'login' || res.state === 'empty-app') {
    label(w, '就活管理', 12);
    w.addSpacer(8);
    txt(w, res.state === 'login' ? 'Scriptable でこのスクリプトを開いて、ログインしてください' : '就活管理アプリを一度開くと表示されます', 13, C.text, false, 4);
    w.addSpacer();
    return w;
  }
  const items = liveItems(res.p, now);
  const first = items[0];
  const medium = family === 'medium';
  const main = medium ? w.addStack() : w;
  if (medium) main.layoutHorizontally();
  const left = medium ? main.addStack() : w;
  if (medium) { left.layoutVertically(); left.size = new Size(150, 0); }

  label(left, '次の予定', 11);
  left.addSpacer(6);
  if (!first) {
    txt(left, 'これからの予定はありません', 15, C.text, true, 3);
    left.addSpacer();
  } else {
    txt(left, first.company, 15, C.text, true, 2);
    txt(left, first.title, 13, C.text, false, 1);
    left.addSpacer(6);
    reasonLine(left, first, now, 13);
    left.addSpacer();
    trackLine(left, first, 11);
    if (first.link) w.url = APP_URL + first.link;
  }
  if (medium) {
    main.addSpacer(12);
    const line = main.addStack();
    line.size = new Size(1, 0);
    line.backgroundColor = new Color(C.bg2);
    main.addSpacer(12);
    const right = main.addStack();
    right.layoutVertically();
    txt(right, 'そのあとに', 11, C.muted, true);
    right.addSpacer(6);
    const rest = items.slice(1, 4);
    if (!rest.length) txt(right, 'なし', 13, C.muted);
    rest.forEach((it, i) => {
      if (i) right.addSpacer(6);
      txt(right, `${it.company} ${it.title}`, 13, C.text, true, 1);
      reasonLine(right, it, now, 12);
    });
    right.addSpacer();
  }
  if (res.note) { w.addSpacer(4); txt(w, res.note, 10, C.muted); }
  return w;
}

/* ---------- 動かす ---------- */
async function getRes() {
  try {
    return await loadPayload();
  } catch (e) {
    // 通信できないときは、前回読んだ中身を出す
    if (Keychain.contains(KEY_CACHE)) {
      try { return { state: 'ok', p: JSON.parse(Keychain.get(KEY_CACHE)), note: 'オフライン(前回の内容)' }; } catch (_) { /* 読めなければ下へ */ }
    }
    return { state: 'ok', p: { items: [] }, note: '読み込めませんでした' };
  }
}
async function loginDialog() {
  const a = new Alert();
  a.title = '就活管理にログイン';
  a.message = '就活管理アプリと同じメールアドレスとパスワード。パスワードは保存しません。';
  a.addTextField('メールアドレス', '');
  a.addSecureTextField('パスワード', '');
  a.addAction('ログイン');
  a.addCancelAction('やめる');
  if (await a.present() === -1) return false;
  try {
    await signIn(a.textFieldValue(0).trim(), a.textFieldValue(1));
    return true;
  } catch (e) {
    const b = new Alert();
    b.title = 'ログインできませんでした';
    b.message = String(e.message || e);
    b.addAction('OK');
    await b.present();
    return false;
  }
}
async function main() {
  const now = new Date();
  if (config.runsInWidget) {
    Script.setWidget(buildWidget(await getRes(), config.widgetFamily, now));
    return Script.complete();
  }
  // Scriptable の中で開いたとき: ログインと表示の確かめ
  if (!Keychain.contains(KEY_TOKEN) && !(await loginDialog())) return Script.complete();
  const m = new Alert();
  m.title = '就活管理 ウィジェット';
  m.message = 'ログインしています。ホーム画面にウィジェットを置いて、このスクリプトを選んでください。';
  m.addAction('小の見え方を確かめる');
  m.addAction('中の見え方を確かめる');
  m.addAction('ログインし直す');
  m.addDestructiveAction('ログアウト');
  m.addCancelAction('閉じる');
  const i = await m.present();
  if (i === 0 || i === 1) {
    const w = buildWidget(await getRes(), i === 0 ? 'small' : 'medium', now);
    // iPhone の JavaScript は「await (条件 ? a : b)」を読めないことがあるので、if で分ける
    if (i === 0) await w.presentSmall();
    else await w.presentMedium();
  } else if (i === 2) {
    Keychain.remove(KEY_TOKEN);
    await loginDialog();
  } else if (i === 3) {
    Keychain.remove(KEY_TOKEN);
    if (Keychain.contains(KEY_CACHE)) Keychain.remove(KEY_CACHE);
  }
  Script.complete();
}
module.exports = { run: main };
