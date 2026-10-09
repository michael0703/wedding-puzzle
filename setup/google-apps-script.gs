// 破關抽獎登記：把這段貼到 Google 試算表的「擴充功能 → Apps Script」
// 設定步驟見 README 的「抽獎登記設定」

const SHEET_NAME = '破關名單';
const HEADERS = ['登記時間', '名字', '序號', '解謎時間', '提示次數'];

function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(HEADERS);
      sheet.setFrozenRows(1);
    }
    const serial = clean(data.serial, 10);
    // 網路重試可能重送同一筆，同一個序號只記一次
    const rows = sheet.getLastRow() - 1;
    const serials = rows > 0 ? sheet.getRange(2, 3, rows, 1).getValues().flat() : [];
    if (serial && !serials.includes(serial)) {
      sheet.appendRow([new Date(), clean(data.name, 20), serial, clean(data.duration, 20), Number(data.hints) || 0]);
    }
  } finally {
    lock.releaseLock();
  }
  return ContentService.createTextOutput('ok');
}

// 避免名字被試算表當成公式執行（例如輸入 =1+1）
function clean(value, maxLength) {
  const s = String(value == null ? '' : value).slice(0, maxLength);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
