// Yen per Canadian dollar for today's Japan date. Fetched at most once a day
// (kept in Script Properties as RATE_<YYYY-MM-DD>); on any failure the last
// good rate, or 111 if there has never been one.

function getRate_() {
  var key = "RATE_" + Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
  var today = Number(getProp_(key));
  if (today > 0) return today;
  try {
    var res = UrlFetchApp.fetch("https://open.er-api.com/v6/latest/CAD", { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      var jpy = Number(JSON.parse(res.getContentText()).rates.JPY);
      // Refuse an absurd figure rather than stamp it onto every expense today.
      if (isFinite(jpy) && jpy > 30 && jpy < 500) {
        setProp_(key, String(jpy));
        setProp_("RATE_LAST", String(jpy));
        return jpy;
      }
    }
  } catch (e) {
    // fall through to the last good rate
  }
  var last = Number(getProp_("RATE_LAST"));
  return last > 0 ? last : 111;
}
