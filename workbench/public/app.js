const $ = id => document.getElementById(id);
const views = ["workbench", "acceptance", "reconciliation"];
const records = new Map();
const form = $("purchase");
const date = new Intl.DateTimeFormat("en-HK", {
  timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "medium", hour12: false,
});
let latestRequest;
let selected;
let merchants;

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const use = document.createElementNS(ns, "use");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", "#icon-" + name);
  svg.append(use);
  return svg;
}

function link(text, href, className, glyph) {
  const node = element("a", text, className);
  node.href = href;
  if (glyph) node.prepend(icon(glyph));
  if (href.startsWith("https:")) {
    node.target = "_blank";
    node.rel = "noopener noreferrer";
  }
  return node;
}

function mode(record) {
  return record.mode === "aevum" ? "Aevum replay" : "Local Sandbox";
}

function paymentStatus(record) {
  return record.status === "settled" ? "Settled" : "Rejected · funds released";
}

function showRecord(record) {
  selected = record.paymentId;
  if (location.hash === "#acceptance") renderAcceptance();
  else location.hash = "acceptance";
}

function openRecord(record, text = record.reference) {
  const button = element("button", text, "secondary");
  button.type = "button";
  button.addEventListener("click", () => showRecord(record));
  return button;
}

function arithmeticDetail(record) {
  let sourceLines;
  if (record.format === "xml") {
    const xml = new DOMParser().parseFromString(record.input, "application/xml");
    sourceLines = Array.from(xml.querySelectorAll("line"), line => ({
      line_id: line.getAttribute("line_id"),
      qty: line.getAttribute("qty"),
      unit_minor: line.getAttribute("unit_minor"),
      declared_minor: line.getAttribute("declared_minor"),
    }));
  } else {
    const [header, ...rows] = record.input.trim().split(/\r?\n/).map(line => line.split(","));
    sourceLines = rows.map(row => Object.fromEntries(header.map((key, index) => [key, row[index]])));
  }
  for (const line of sourceLines) {
    const delivered = record.report.lines.find(entry => entry.line_id === line.line_id);
    const expected = Number(line.declared_minor) - Number(line.qty) * Number(line.unit_minor);
    if (delivered && Number.isSafeInteger(expected) && delivered.delta_minor !== expected) {
      return line.line_id + " · expected " + expected + "¢, reported " + delivered.delta_minor + "¢";
    }
  }
  return "The reported variance differs from the buyer calculation.";
}

function renderAcceptance() {
  $("record-select").replaceChildren(...Array.from(records.values(), record => {
    const option = element("option", record.reference + " · " + mode(record));
    option.value = record.paymentId;
    return option;
  }));
  const record = records.get(selected) || records.values().next().value;
  if (!record) return;
  $("record-select").value = record.paymentId;
  $("file-format").textContent = record.format.toUpperCase();
  $("input").textContent = record.input;
  $("report").textContent = JSON.stringify(record.report, null, 2);
  $("checks").replaceChildren(...record.checks.map(rule => {
    const passed = rule.status === "pass";
    const item = element("li", "", passed ? "" : "fail");
    const state = element("span", passed ? "Passed" : "Failed", "rule-state " + rule.status);
    state.prepend(icon(passed ? "check" : "x"));
    item.append(state, element("span", rule.label, "rule-title"));
    if (!passed && rule.id === "ARITHMETIC") {
      item.append(element("span", arithmeticDetail(record), "rule-detail"));
    }
    return item;
  }));
  const actions = element("div", "", "actions");
  if (record.settlement) actions.append(link("View settlement", record.settlement, "button secondary", "link"));
  if (record.release) actions.append(link("View on-chain release", record.release, "button secondary", "link"));
  actions.append(link("Download evidence ZIP", record.evidence, "button", "download"));

  const rejected = record.status === "rejected";
  const emblem = element("span", "", "summary-symbol");
  emblem.append(icon(rejected ? "x" : "check"));
  const details = element("div", "");
  const reference = element("div", "", "summary-reference");
  reference.append(element("span", mode(record), "mode " + (record.mode === "aevum" ? "live" : "local")),
    element("span", record.reference, "reference"));
  details.append(element("h2", paymentStatus(record)), reference);
  const title = element("div", "", "summary-title");
  title.append(emblem, details);
  const amount = element("div", "", "summary-amount");
  amount.append(element("span", "Service fee paid"), element("strong", Number(record.paid).toFixed(2) + " tUSD8"));
  if (rejected) amount.append(element("span", Number(record.fee).toFixed(2) + " tUSD8 released back to the vault", "released-amount"));
  const summary = $("acceptance-summary");
  summary.className = "card summary " + record.status;
  summary.replaceChildren(title, amount, actions);
}

function formatDate(value) {
  return value ? date.format(new Date(value)) : "—";
}

function renderLedger() {
  const all = [...records.values()];
  const total = environment => all.filter(record => record.mode === environment)
    .reduce((sum, record) => sum + Number(record.paid), 0).toFixed(2);
  const cards = [
    { label: "Aevum replay paid", value: total("aevum"), unit: "tUSD8", glyph: "shield", variant: "chain" },
    { label: "Local Sandbox paid", value: total("local"), unit: "tUSD8", glyph: "wallet", variant: "simulated" },
    { label: "Rejected and released", value: String(all.filter(record => record.status === "rejected").length), glyph: "x", variant: "rejections" },
  ];
  $("totals").replaceChildren(...cards.map(({ label, value, unit, glyph, variant }) => {
    const card = element("div", "", "card kpi " + variant);
    const heading = element("div", label, "kpi-heading");
    const mark = element("span", "", "kpi-icon");
    mark.append(icon(glyph));
    heading.append(mark);
    card.append(heading, element("strong", value, "kpi-value"));
    if (unit) card.append(element("span", unit, "kpi-unit"));
    return card;
  }));
  $("ledger").replaceChildren(...all.map(record => {
    const row = document.createElement("tr");
    const purchase = openRecord(record);
    purchase.classList.add("reference");
    const isAevum = record.mode === "aevum";
    const environment = element("span", isAevum ? "Aevum 44005" : mode(record), "mode " + (isAevum ? "live" : "local"));
    const status = element("span", paymentStatus(record), "status " + record.status);
    status.prepend(icon(record.status === "settled" ? "check" : "x"));
    const paid = element("td", Number(record.paid).toFixed(2), "numeric");
    for (const value of [
      purchase, environment, formatDate(record.authorizedAt), formatDate(record.closedAt), status,
    ]) {
      const cell = document.createElement("td");
      cell.append(value);
      row.append(cell);
    }
    const evidence = document.createElement("td");
    evidence.append(link("Download ZIP", record.evidence, "button secondary evidence-button", "download"));
    row.append(paid, evidence);
    return row;
  }));
}

function navigate() {
  const requested = location.hash.slice(1);
  const current = views.includes(requested) ? requested : "workbench";
  for (const view of views) $(view).hidden = view !== current;
  for (const item of document.querySelectorAll("nav a")) {
    if (item.hash === "#" + current) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  if (current === "acceptance") renderAcceptance();
  if (current === "reconciliation") renderLedger();
}

function updateQuote() {
  if (!merchants) return;
  const format = form.elements.format.value;
  const merchant = merchants[format === "csv" ? "a" : "b"];
  const reason = format === "csv" ? "Lowest-priced eligible merchant" : "Only eligible merchant for XML";
  const quantity = form.elements.quantity;
  const businessAmount = quantity.validity.valid ? "HKD " + (quantity.valueAsNumber * 12 + 7).toFixed(2) : "—";
  const amounts = element("div", "", "quote-values");
  const business = element("div", "");
  const fee = element("div", "", "quote-fee");
  business.append(element("span", "Calculated subtotal", "quote-label"), element("strong", businessAmount));
  fee.append(element("span", "API service fee", "quote-label"), element("strong", (merchant.amount / 1000000).toFixed(2) + " tUSD8"));
  amounts.append(business, fee);
  $("quote").replaceChildren(amounts, element("p", merchant.name + " · " + reason));
}

async function submit(request) {
  $("run").disabled = true;
  $("retry").disabled = true;
  $("purchase-message").textContent = "Running order " + request.intent + " on the local test chain…";
  try {
    const response = await fetch("/api/purchases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const record = await response.json();
    if (!response.ok) throw Error(record.error);
    records.set(record.paymentId, record);
    const message = record.recovered ? "Original purchase recovered." : paymentStatus(record) + ".";
    $("purchase-message").replaceChildren(document.createTextNode(message + " "), openRecord(record, "View acceptance"));
  } catch (error) {
    $("purchase-message").textContent = error.message;
  } finally {
    $("run").disabled = false;
    $("retry").disabled = false;
  }
}

form.addEventListener("submit", event => {
  event.preventDefault();
  latestRequest = {
    intent: "demo-" + crypto.randomUUID().slice(0, 8),
    format: form.elements.format.value,
    quantity: form.elements.quantity.valueAsNumber,
    fault: form.elements.fault.checked,
  };
  submit(latestRequest);
});
form.elements.format.addEventListener("change", updateQuote);
form.elements.quantity.addEventListener("input", updateQuote);
for (const target of ["input", "report"]) {
  const button = $("copy-" + target);
  const label = button.querySelector("span");
  let reset;
  button.addEventListener("click", async () => {
    clearTimeout(reset);
    try {
      await navigator.clipboard.writeText($(target).textContent);
      label.textContent = "Copied";
      $("status").textContent = target === "input" ? "Source order copied." : "Supplier report copied.";
    } catch {
      const range = document.createRange();
      range.selectNodeContents($(target));
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      label.textContent = "Selected";
      $("status").textContent = "Text selected. Use your device’s copy command.";
    }
    reset = setTimeout(() => { label.textContent = "Copy"; }, 1500);
  });
}
$("retry").addEventListener("click", () => latestRequest && submit(latestRequest));
$("record-select").addEventListener("change", event => {
  selected = event.target.value;
  renderAcceptance();
});
$("csv").addEventListener("click", () => {
  const rows = [["reference", "environment", "payment_id", "merchant", "authorized_at_utc", "closed_at_utc", "budget_day", "status", "paid_tusd8", "reserve_tx", "close_tx"]];
  for (const record of records.values()) rows.push([
    record.reference, mode(record), record.paymentId, record.merchant, record.authorizedAt, record.closedAt,
    record.budgetDay, record.status, record.paid, record.transactions.reserve, record.transactions.capture || record.transactions.void,
  ]);
  const csv = rows.map(row => row.map(value => '"' + String(value ?? "").replaceAll('"', '""') + '"').join(",")).join("\r\n");
  const href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const download = link("", href);
  download.download = "guardrail-reconciliation.csv";
  download.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
});
window.addEventListener("hashchange", () => {
  navigate();
  window.scrollTo(0, 0);
});
navigate();

fetch("/api/records").then(async response => {
  if (!response.ok) throw Error("Could not load procurement records.");
  const data = await response.json();
  merchants = data.merchants;
  for (const record of data.records) records.set(record.paymentId, record);
  const aevum = data.records.filter(record => record.mode === "aevum");
  const settled = aevum.filter(record => record.status === "settled");
  const released = aevum.filter(record => record.status === "rejected");
  $("replay-fee").textContent = settled.reduce((sum, record) => sum + Number(record.paid), 0).toFixed(2);
  $("replay-released").textContent = released.reduce((sum, record) => sum + Number(record.fee), 0).toFixed(2);
  const replay = settled[0];
  if (replay) {
    const inspect = openRecord(replay, "Inspect acceptance");
    inspect.classList.add("primary-replay");
    const vault = "https://explorer-test.qday.info/address/" + replay.vault + "?tab=contract";
    $("replay-proof").append(link("Verified Contract", vault, "proof", "shield"));
    $("replay-actions").append(inspect, link("View on Blockscout", replay.settlement, "button secondary", "link"));
  }
  const rejection = released[0];
  if (rejection) {
    $("replay-proof").append(link("On-chain release", rejection.release, "proof release", "link"));
    $("replay-actions").append(openRecord(rejection, "Inspect on-chain rejection"));
  }
  updateQuote();
  navigate();
}).catch(error => { $("status").textContent = error.message; });
