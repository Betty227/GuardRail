const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ethers } = require("ethers");
const { transactionQueue } = require("../scripts/sandbox");
const { createLocalChain } = require("./local-chain");
const { validateRequest, merchants, deliver, accept, zipEvidence } = require("./procurement");

const replayRoot = path.join(__dirname, "../evidence/aevum/0xA38A8D54406d417EcFcd884BBA12E18079f74418");
const files = {
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/styles.css": ["styles.css", "text/css"],
};

async function replayRecords() {
  const index = JSON.parse(await fs.readFile(path.join(replayRoot, "index.json"), "utf8"));
  return Promise.all(index.purchases.map(async entry => {
    const dir = path.join(replayRoot, entry.paymentId);
    if (entry.status === "rejected") {
      const decision = JSON.parse(await fs.readFile(path.join(dir, "decision.json"), "utf8"));
      const [input, reportJson] = await Promise.all(
        ["order." + decision.format, "report.json"].map(file => fs.readFile(path.join(dir, file), "utf8"))
      );
      return { ...decision, input, report: JSON.parse(reportJson), release: entry.release,
        evidence: "/api/evidence/" + entry.paymentId + ".zip" };
    }
    const [input, reportJson, receiptJson] = await Promise.all(
      ["order.csv", "report.json", "receipt.json"].map(file => fs.readFile(path.join(dir, file), "utf8"))
    );
    const report = JSON.parse(reportJson);
    const bundle = JSON.parse(receiptJson);
    const fee = ethers.formatUnits(bundle.receipt.amount, 6);
    const chain = entry.chain || {};
    return {
      mode: "aevum", chainId: index.chainId, vault: index.vault, source: index.verifiedSource,
      reference: entry.intent, paymentId: entry.paymentId, status: "settled",
      merchant: bundle.receipt.merchant, format: "csv", input, report, fee, paid: fee,
      checks: await accept(input, "csv", report),
      transactions: bundle.transactions, settlement: entry.settlement,
      authorizedAt: chain.authorizedAt, closedAt: chain.closedAt, budgetDay: chain.budgetDay,
      evidence: "/api/evidence/" + entry.paymentId + ".zip",
    };
  }));
}

async function readRequest(req) {
  if ((req.headers["content-type"] || "").split(";")[0] !== "application/json") throw Error("JSON required.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw Error("Request too large.");
    chunks.push(chunk);
  }
  return validateRequest(JSON.parse(Buffer.concat(chunks)));
}

async function main() {
  const records = await replayRecords();
  const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "guardrail-workbench-"));
  const local = await createLocalChain(evidenceRoot);
  const enqueue = transactionQueue(key => local.purchase(JSON.parse(key)), 8);
  const limits = new Map();
  const cleanup = setInterval(() => {
    for (const [ip, state] of limits) if (state.expires <= Date.now()) limits.delete(ip);
  }, 60000).unref();
  const port = Number(process.env.PORT || 3030);
  const server = http.createServer(async (req, res) => {
    function send(code, payload, type = "application/json") {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(type === "application/json" ? JSON.stringify(payload) : payload);
    }
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && Object.hasOwn(files, url.pathname)) {
        const [file, type] = files[url.pathname];
        return send(200, await fs.readFile(path.join(__dirname, "public", file)), type + "; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/api/records") {
        return send(200, { records: [...records, ...local.list()], merchants });
      }
      const evidence = /^\/api\/evidence\/(0x[a-f0-9]{64})\.zip$/.exec(url.pathname);
      if (req.method === "GET" && evidence) {
        const id = evidence[1];
        const chainReplay = records.some(record => record.paymentId === id);
        if (!chainReplay && !local.list().some(record => record.paymentId === id)) return send(404, { error: "Evidence not found." });
        const zip = await zipEvidence(path.join(chainReplay ? replayRoot : evidenceRoot, id));
        res.setHeader("content-disposition", 'attachment; filename="guardrail-' + id.slice(2, 14) + '.zip"');
        return send(200, zip, "application/zip");
      }
      const merchant = /^\/api\/merchants\/([ab])$/.exec(url.pathname);
      if (req.method !== "POST" || (url.pathname !== "/api/purchases" && !merchant)) {
        return send(404, { error: "Unknown endpoint." });
      }
      const origin = req.headers.origin;
      const origins = ["http://localhost:" + port, "http://127.0.0.1:" + port];
      if (origin && !origins.includes(origin)) return send(403, { error: "Origin denied." });
      const ip = req.socket.remoteAddress;
      const now = Date.now();
      if (!limits.has(ip) || limits.get(ip).expires <= now) limits.set(ip, { count: 0, expires: now + 60000 });
      if (++limits.get(ip).count > 12) {
        res.setHeader("retry-after", Math.ceil((limits.get(ip).expires - now) / 1000));
        return send(429, { error: "Too many requests. Try again in a minute." });
      }
      let request;
      try { request = await readRequest(req); }
      catch (error) { return send(400, { error: error.message }); }
      if (merchant) {
        if (!merchants[merchant[1]].formats.includes(request.format)) return send(422, { error: "Merchant does not support this format." });
        return send(200, deliver(merchant[1], request));
      }
      let job;
      try { job = enqueue(JSON.stringify(request)); }
      catch { return send(503, { error: "Queue full. Retry the same intent." }); }
      try { return send(200, await job); }
      catch (error) {
        if (error.message.includes("different order or quote")) return send(409, { error: error.message });
        throw error;
      }
    } catch (error) {
      console.error(error.shortMessage || error.message);
      if (!res.destroyed) send(502, { error: "Purchase incomplete. Retry the same intent or check the terminal." });
    }
  });
  server.once("close", () => clearInterval(cleanup));
  server.listen(port, "127.0.0.1", () => console.log("GuardRail workbench at http://127.0.0.1:" + port));
}

main().catch(error => {
  console.error(error.shortMessage || error.message);
  process.exitCode = 1;
});
