/* Loader: lift it at the first snap of the mark after the font and the page's images are in. If landing.css has
   already started lifting it (two cycles), follow that instead, and if that happened before this script ran, leave
   the headline still rather than replaying its split under the reader. */
(() => {
  const root = document.documentElement;
  const loader = document.querySelector(".loader");
  if (!loader) return;
  const cap = loader.getAnimations?.().find((a) => a.animationName === "lift");
  if (cap && cap.currentTime >= cap.effect.getTiming().delay) {
    loader.remove();
    return;
  }
  let ready = false;
  const lift = () => {
    if (root.classList.contains("ready")) return;
    root.classList.add("ready");
    setTimeout(() => loader.remove(), 450);
  };
  const font = document.fonts ? document.fonts.load('1em "Stack Sans Text"').then(() => document.fonts.ready) : Promise.resolve();
  const page = new Promise((done) => (document.readyState === "complete" ? done() : addEventListener("load", done, { once: true })));
  Promise.all([font, page]).catch(() => {}).then(() => {
    ready = true;
    if (document.hidden) lift();
  });
  loader.addEventListener("animationiteration", () => ready && lift());
  loader.addEventListener("animationstart", (event) => event.animationName === "lift" && lift());
})();

/* Simplify demo on the home page. The page renders the example bills, their direct payments and
   the controls' space up front (a <noscript> style hides the controls without JavaScript), so this
   script fills the graph and wires the toggles without moving anything. */
(() => {
  const list = document.getElementById("bills");
  const graph = document.getElementById("graph");
  const tally = document.getElementById("tally");
  const payments = document.getElementById("payments");
  const toggle = document.getElementById("simplify-switch");
  if (!list || !graph || !tally || !payments || !toggle) return;

  // Order matches data-payer and data-among in the template.
  const people = [
    { name: "Asha", fill: "#FFD99B", labelAbove: true },
    { name: "Ravi", fill: "#FFC6B5", labelAbove: true },
    { name: "Meera", fill: "#FFE6B8", labelAbove: false },
    { name: "Kabir", fill: "#FBD0D2", labelAbove: false },
  ];
  const layouts = {
    wide: { viewBox: "0 30 600 400", left: 95, right: 505, top: 125, bottom: 345 },
    compact: { viewBox: "0 25 400 430", left: 78, right: 322, top: 130, bottom: 360 },
  };
  const R = 34, NS = "http://www.w3.org/2000/svg";
  const narrow = matchMedia("(max-width: 40rem)");
  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  const rupees = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
  const boxes = [...list.querySelectorAll("input[data-amount]")];
  const bills = boxes.map((box) => ({
    box,
    amount: Number(box.dataset.amount),
    payer: Number(box.dataset.payer),
    among: box.dataset.among.split(" ").map(Number),
  }));
  let simplified = false;

  function ledger() {
    const owe = people.map(() => people.map(() => 0));
    const balance = people.map(() => 0);
    for (const bill of bills.filter((b) => b.box.checked)) {
      const share = bill.amount / bill.among.length;
      balance[bill.payer] += bill.amount;
      for (const p of bill.among) {
        balance[p] -= share;
        if (p !== bill.payer) owe[p][bill.payer] += share;
      }
    }
    const direct = [];
    for (let a = 0; a < people.length; a++) for (let b = a + 1; b < people.length; b++) {
      const net = owe[a][b] - owe[b][a];
      if (Math.abs(net) >= 1) direct.push(net > 0 ? { from: a, to: b, amount: net } : { from: b, to: a, amount: -net });
    }
    return { balance, direct, simple: settle(balance) };
  }

  // Largest debtor pays largest creditor until everyone is square.
  function settle(balance) {
    const left = balance.map((amount, who) => ({ who, amount }));
    const out = [];
    for (;;) {
      left.sort((x, y) => x.amount - y.amount);
      const debtor = left[0], creditor = left[left.length - 1];
      if (creditor.amount < 1 || debtor.amount > -1) return out;
      const amount = Math.min(creditor.amount, -debtor.amount);
      out.push({ from: debtor.who, to: creditor.who, amount });
      debtor.amount += amount;
      creditor.amount -= amount;
    }
  }

  function el(name, attrs, parent) {
    const node = document.createElementNS(NS, name);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    if (parent) parent.appendChild(node);
    return node;
  }

  function curve(from, to) {
    const a = people[from], b = people[to];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
    const s = { x: a.x + ux * (R + 10), y: a.y + uy * (R + 10) };
    const e = { x: b.x - ux * (R + 12), y: b.y - uy * (R + 12) };
    const bend = 20, c = { x: (s.x + e.x) / 2 - uy * bend, y: (s.y + e.y) / 2 + ux * bend };
    const at = (t) => ({ x: (1 - t) ** 2 * s.x + 2 * (1 - t) * t * c.x + t * t * e.x, y: (1 - t) ** 2 * s.y + 2 * (1 - t) * t * c.y + t * t * e.y });
    // Diagonals cross in the middle, so their amounts sit nearer the payer.
    const label = at(Math.abs(dx) > 1 && Math.abs(dy) > 1 ? 0.3 : 0.5);
    const tx = e.x - c.x, ty = e.y - c.y, tl = Math.hypot(tx, ty), hx = tx / tl, hy = ty / tl, size = 11;
    const head = `M${e.x + hx * 4} ${e.y + hy * 4} L${e.x - hx * size + hy * size * 0.55} ${e.y - hy * size - hx * size * 0.55} L${e.x - hx * size - hy * size * 0.55} ${e.y - hy * size + hx * size * 0.55}Z`;
    return { d: `M${s.x} ${s.y} Q${c.x} ${c.y} ${e.x} ${e.y}`, head, label };
  }

  let layer = el("g", { class: "edges" }, graph);
  const nodeLayer = el("g", { class: "nodes" }, graph);
  let balances = [];

  function placeNodes() {
    const compact = narrow.matches, box = layouts[compact ? "compact" : "wide"];
    graph.setAttribute("viewBox", box.viewBox);
    graph.classList.toggle("compact", compact);
    [[box.left, box.top], [box.right, box.top], [box.right, box.bottom], [box.left, box.bottom]].forEach(([x, y], i) => Object.assign(people[i], { x, y }));
    nodeLayer.replaceChildren();
    balances = people.map((person) => {
      const group = el("g", {}, nodeLayer);
      el("circle", { class: "avatar", cx: person.x, cy: person.y, r: R, fill: person.fill }, group);
      el("text", { class: "initial", x: person.x, y: person.y }, group).textContent = person.name[0];
      const nameY = person.labelAbove ? person.y - R - (compact ? 40 : 34) : person.y + R + (compact ? 28 : 26);
      el("text", { class: "who", x: person.x, y: nameY }, group).textContent = person.name;
      return el("text", { class: "bal", x: person.x, y: nameY + (compact ? 23 : 21) }, group);
    });
  }

  function drawEdges(target, edges, animate) {
    edges.forEach((edge, i) => {
      const shape = curve(edge.from, edge.to);
      const group = el("g", { class: `edge${simplified ? " pay" : ""}${animate ? " enter" : ""}`, style: `--delay:${i * 0.08}s` }, target);
      el("path", { class: "line", d: shape.d, pathLength: 1 }, group);
      el("path", { class: "head", d: shape.head }, group);
      el("text", { x: shape.label.x, y: shape.label.y }, group).textContent = rupees(edge.amount);
    });
  }

  function line(strong, rest) {
    const count = document.createElement("strong");
    const text = document.createElement("span");
    count.textContent = strong;
    text.textContent = rest;
    tally.replaceChildren(count, " ", text);
  }

  function render(animate) {
    const { balance, direct, simple } = ledger();
    const edges = simplified ? simple : direct;

    balance.forEach((amount, who) => {
      const node = balances[who];
      node.textContent = amount >= 1 ? `gets back ${rupees(amount)}` : amount <= -1 ? `owes ${rupees(-amount)}` : "settled up";
      node.setAttribute("class", `bal${amount >= 1 ? " owed" : amount <= -1 ? " owes" : ""}`);
    });

    const motion = animate && !calm.matches;
    const next = el("g", { class: "edges" });
    graph.insertBefore(next, nodeLayer);
    const old = layer;
    if (motion) { old.classList.add("leave"); setTimeout(() => old.remove(), 200); } else old.remove();
    layer = next;
    if (motion) setTimeout(() => drawEdges(next, edges, true), 160);
    else drawEdges(next, edges, false);

    const count = edges.length, word = count === 1 ? "payment" : "payments";
    if (!count) line("0", "payments. Everyone is square.");
    else if (!simplified) line(String(count), `${word} to settle up`);
    else if (count < direct.length) line(String(count), `${word} instead of ${direct.length}`);
    else line(String(count), `${word}. Already as simple as it gets.`);

    payments.replaceChildren(...edges.map((edge) => {
      const item = document.createElement("li");
      const who = document.createElement("span");
      const amount = document.createElement("strong");
      who.textContent = `${people[edge.from].name} pays ${people[edge.to].name}`;
      amount.textContent = rupees(edge.amount);
      item.append(who, amount);
      return item;
    }));
  }

  toggle.addEventListener("click", () => {
    simplified = !simplified;
    toggle.setAttribute("aria-checked", String(simplified));
    render(true);
  });
  list.addEventListener("change", () => render(true));
  narrow.addEventListener("change", () => { placeNodes(); render(false); });
  placeNodes();
  render(false);
})();
