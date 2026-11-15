// The "no signal" strip (#net), across the top of the phone, above the
// sentence. It shows while the phone has no signal, or while a line rung up
// is held on the phone for the next contact, and says how many lines are
// still to send. While it shows, the screens move down by its height (the
// --net-h property on the phone), so it never covers the sentence, and it
// sits below every sheet and the bottom bar.
//
// mountNet(root, store) adds #net to root (the phone).

const NO_SIGNAL = "No signal. Showing what this phone last saw.";

export function mountNet(root, store) {
  const strip = document.createElement("div");
  strip.className = "net";
  strip.id = "net";
  strip.setAttribute("role", "status");
  strip.hidden = true;
  const words = document.createElement("span");
  const count = document.createElement("b");
  count.id = "netN";
  strip.append(words, count);
  root.prepend(strip);

  // How far the screens move down: the strip's height while it shows.
  function place() {
    root.style.setProperty("--net-h", strip.hidden ? "0px" : strip.offsetHeight + "px");
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(place).observe(strip);

  function render(s) {
    const { unsent, waiting } = store.outbox();
    const show = !s.online || waiting > 0;
    words.textContent = s.online ? "" : NO_SIGNAL;
    count.textContent = unsent > 0 ? (s.online ? "" : " ") + unsent + " to send." : "";
    if (strip.hidden === show) {
      strip.hidden = !show;
      root.classList.toggle("net-on", show);
    }
    place();
  }

  render(store.state);
  store.subscribe(render);
}
