// Thin Sheet access. Apps Script only (uses SpreadsheetApp); not loaded by Node tests.
// Columns are located by the header text in row 1, so a tab that gained extra
// columns later still reads and writes correctly.

function sheet_(tab) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tab);
  if (!sh) throw new Error("Missing tab: " + tab + ". Run setup().");
  return sh;
}

function headersOf_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

function readTable_(tab) {
  var sh = sheet_(tab);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var headers = headersOf_(sh);
  return sh.getRange(2, 1, last - 1, headers.length).getValues().map(function (row) {
    return rowToObj(headers, row);
  });
}

function appendObj_(tab, obj) {
  var sh = sheet_(tab);
  sh.appendRow(objToRow(headersOf_(sh), obj));
}

function updateWhere_(tab, column, value, patch) {
  var sh = sheet_(tab);
  var last = sh.getLastRow();
  if (last < 2) return null;
  var headers = headersOf_(sh);
  var col = headers.indexOf(column);
  if (col === -1) return null;
  var cells = sh.getRange(2, col + 1, last - 1, 1).getValues();
  for (var i = 0; i < cells.length; i++) {
    if (String(cells[i][0]) !== String(value)) continue;
    var rowNum = i + 2;
    Object.keys(patch).forEach(function (key) {
      var c = headers.indexOf(key);
      if (c !== -1) sh.getRange(rowNum, c + 1).setValue(sanitizeCell(patch[key]));
    });
    return rowToObj(headers, sh.getRange(rowNum, 1, 1, headers.length).getValues()[0]);
  }
  return null;
}

function updateById_(tab, id, patch) {
  return updateWhere_(tab, "id", id, patch);
}
