function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return json_({ ok: true, rev: 0, data: { name: "mat" } });
}

// One endpoint: the body is { key, actor, via, action, args }; Actions.js does
// the rest. Always answers JSON, never an HTML error page.
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e && e.postData ? e.postData.contents : undefined);
  } catch (err) {
    return json_({ ok: false, error: "bad_input", message: "That request didn’t come through properly." });
  }
  try {
    return json_(handle_(body));
  } catch (err) {
    return json_({ ok: false, error: "server", message: "Something went wrong on our side. Try again. (" + String((err && err.message) || err) + ")" });
  }
}
