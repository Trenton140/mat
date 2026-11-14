function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return json_({ ok: true, rev: 0, data: { name: "mat" } });
}

function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  return json_({ ok: true, rev: 0, data: { echo: body } });
}
