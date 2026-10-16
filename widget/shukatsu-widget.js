// 就活管理 ウィジェット(Scriptable 用の読み込み役)
// 本体は長いので、ここからダウンロードして保存し、動かす。
// 本体が新しくなると、半日以内に自動で入れ替わる。
const SRC = 'https://articlemanagerapp.github.io/syuukatu-app/widget/shukatsu-widget-module.js';
const NAME = 'shukatsu-widget-module';

const fm = module.filename.includes('/Mobile Documents/') ? FileManager.iCloud() : FileManager.local();
// このスクリプトと同じ場所に本体を置く(importModule は同じ場所のファイルを名前で読める)
const path = fm.joinPath(module.filename.replace(/\/[^/]*$/, ''), NAME + '.js');
const old = fm.fileExists(path) ? fm.modificationDate(path) : null;

// 本体がない、または半日たったら取り直す(通信できなければ保存してあるものを使う)
if (!old || Date.now() - old.getTime() > 12 * 3600 * 1000) {
  try {
    const code = await new Request(SRC).loadString();
    if (code.includes('module.exports')) fm.writeString(path, code);
  } catch (e) {
    // 通信できないときは、前に保存した本体を使う
  }
}

if (fm.fileExists(path)) {
  if (fm.isFileStoredIniCloud && fm.isFileStoredIniCloud(path) && !fm.isFileDownloaded(path)) await fm.downloadFileFromiCloud(path);
  await importModule(NAME).run();
} else {
  const w = new ListWidget();
  w.backgroundColor = new Color('#14213d');
  const t = w.addText('就活管理: 通信できる所で、Scriptable からこのスクリプトを一度開いてください');
  t.textColor = new Color('#eef2fa');
  t.font = Font.systemFont(13);
  if (config.runsInWidget) Script.setWidget(w); else await w.presentSmall();
  Script.complete();
}
