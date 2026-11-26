const path = require("node:path");
const { promisify } = require("node:util");
const { execFile, spawn } = require("node:child_process");

const run = promisify(execFile);
const rules = {
  ORDER: "Order reference",
  LINES: "Line completeness",
  CURRENCY: "Currency",
  SOURCE_FIELDS: "Source field match",
  ARITHMETIC: "Arithmetic in HKD cents",
};
const merchants = {
  a: { name: "Merchant A", formats: ["csv"], amount: 50000 },
  b: { name: "Merchant B", formats: ["csv", "xml"], amount: 100000 },
};

function validateRequest(body) {
  if (!body || typeof body !== "object" ||
      typeof body.intent !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.intent) ||
      !["csv", "xml"].includes(body.format) ||
      !Number.isSafeInteger(body.quantity) || body.quantity < 1 || body.quantity > 1000 ||
      typeof body.fault !== "boolean") throw new Error("Choose CSV or XML and a whole quantity from 1 to 1000.");
  return { intent: body.intent, format: body.format, quantity: body.quantity, fault: body.fault };
}

function orderFor(request) {
  const orderId = "PO-" + request.intent;
  const lines = [
    { line_id: "L1", sku: "PAPER", qty: request.quantity, unit_minor: 1200, declared_minor: 12500 },
    { line_id: "L2", sku: "CLIP", qty: 2, unit_minor: 350, declared_minor: 700 },
  ];
  const header = ["line_id", "sku", "qty", "unit_minor", "declared_minor"];
  const input = request.format === "csv"
    ? ["order_id,currency," + header.join(","), ...lines.map(line =>
      [orderId, "HKD", ...header.map(key => line[key])].join(","))].join("\n") + "\n"
    : '<order order_id="' + orderId + '" currency="HKD">\n' + lines.map(line =>
      "  <line " + header.map(key => key + '="' + line[key] + '"').join(" ") + "/>\n").join("") + "</order>\n";
  return { orderId, lines, input };
}

function selectMerchant(format) {
  return Object.keys(merchants).filter(id => merchants[id].formats.includes(format))
    .sort((a, b) => merchants[a].amount - merchants[b].amount)[0];
}

function deliver(id, request) {
  const merchant = merchants[id];
  if (!merchant?.formats.includes(request.format)) throw Error("Merchant does not support this format.");
  const order = orderFor(request);
  return {
    order_id: order.orderId,
    currency: "HKD",
    lines: order.lines.map((line, index) => ({
      ...line,
      delta_minor: line.declared_minor - line.qty * line.unit_minor + (request.fault && index === 0 ? 1 : 0),
    })),
  };
}

async function accept(input, format, report) {
  const child = spawn("python3", [path.join(__dirname, "../spec/v1/acceptance.py")], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5000,
  });
  const result = await new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { errors += chunk; });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output) : reject(Error(errors || "Acceptance service failed")));
    child.stdin.end(JSON.stringify({ input, format, report }));
  });
  const { failures } = JSON.parse(result);
  if (failures.includes("SCHEMA")) return [{ id: "SCHEMA", label: "Report schema", status: "fail" }];
  return Object.entries(rules).map(([id, label]) => ({
    id, label, status: failures.includes(id) ? "fail" : "pass",
  }));
}

async function zipEvidence(directory) {
  const { stdout } = await run("python3", ["-c",
    "import io,pathlib,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:\n for p in sorted(pathlib.Path(sys.argv[1]).iterdir()):\n  if p.is_file(): z.write(p,p.name)\nsys.stdout.buffer.write(b.getvalue())",
    directory], { encoding: "buffer", timeout: 5000 });
  return stdout;
}

module.exports = { validateRequest, orderFor, merchants, selectMerchant, deliver, accept, zipEvidence };
