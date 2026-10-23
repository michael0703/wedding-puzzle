// 破關抽獎登記：把這段貼到 Google 試算表的「擴充功能 → Apps Script」
// 設定步驟見 README 的「抽獎登記設定」

const SHEET_NAME = '破關名單';
const HEADERS = ['登記時間', '名字', '序號', '解謎時間', '提示次數'];

// 抽獎頁讀取名單用的密碼：貼到 Apps Script 之後，在那邊改成你自己的密碼
// （這個檔案會放上 GitHub，不要把真的密碼寫在這裡）
const DRAW_KEY = '請改成你自己的密碼';

function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  if (data.action === 'list') return listEntries(data.key);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet();
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

// 抽獎頁用：密碼正確才回傳名單（名字、序號、登記時間）
function listEntries(key) {
  if (DRAW_KEY === '請改成你自己的密碼' || key !== DRAW_KEY) return json({ ok: false, error: 'key' });
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
