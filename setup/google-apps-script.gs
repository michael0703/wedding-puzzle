// 破關抽獎登記：把這段貼到 Google 試算表的「擴充功能 → Apps Script」
// 設定步驟見 README 的「抽獎登記設定」

const SHEET_NAME = '破關名單';
const HEADERS = ['登記時間', '名字', '序號', '解謎時間', '提示次數'];

// 抽獎頁讀取名單用的密碼：留空 = 不需要密碼（settings.js 的 draw.key 也留空）
// 要設密碼的話，在 Apps Script 那邊填，不要寫在這個檔案（會放上 GitHub）
const DRAW_KEY = '';

function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  if (data.action === 'list') return listEntries(data.key);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet();
    const serial = clean(data.serial, 10);
    const name = clean(data.name, 20);
    // 網路重試可能重送同一筆：名字和序號都一樣才算重複
    // （兩個人剛好抽到同一個序號時，名字不同，兩筆都會記下來）
    const rows = sheet.getLastRow() - 1;
    const existing = rows > 0 ? sheet.getRange(2, 2, rows, 2).getValues() : [];
    const plain = (v) => String(v).replace(/^'/, '');
    const dup = existing.some((r) => plain(r[0]) === plain(name) && String(r[1]) === serial);
    if (serial && !dup) {
      sheet.appendRow([new Date(), name, serial, clean(data.duration, 20), Number(data.hints) || 0]);
    }
  } finally {
    lock.releaseLock();
  }
  return ContentService.createTextOutput('ok');
}

// 抽獎頁用：密碼正確才回傳名單（名字、序號、登記時間）
function listEntries(key) {
  if (DRAW_KEY && key !== DRAW_KEY) return json({ ok: false, error: 'key' });
  const sheet = getSheet();
  const rows = sheet.getLastRow() - 1;
  const values = rows > 0 ? sheet.getRange(2, 1, rows, 3).getValues() : [];
  const entries = values
    .filter((r) => r[2])
    .map((r) => ({ at: r[0] instanceof Date ? r[0].getTime() : String(r[0]), name: String(r[1]).replace(/^'/, ''), serial: String(r[2]) }));
  return json({ ok: true, entries });
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// 避免名字被試算表當成公式執行（例如輸入 =1+1）
function clean(value, maxLength) {
  const s = String(value == null ? '' : value).slice(0, maxLength);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
