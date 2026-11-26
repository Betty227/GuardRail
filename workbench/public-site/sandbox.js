/* Browser-only, unsigned simulation. Replay transactions are supplied separately. */
window.GuardRailDemo = (() => {
  const merchants = { a: { name: "Merchant A", amount: 50000 }, b: { name: "Merchant B", amount: 100000 } };
  const orders = new Map();
  const encoder = new TextEncoder();
  const rule = (id, label, ok) => ({ id, label, status: ok ? "pass" : "fail" });

  function filesToZip(files) {
    // Stored ZIP entries are small. No third-party scripts or network service needed.
    const local = [], directory = [];
    let offset = 0, centralSize = 0;
    for (const [filename, text] of Object.entries(files)) {
      const name = encoder.encode(filename), data = encoder.encode(text);
      let crc = 0xffffffff;
      for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      const header = new DataView(new ArrayBuffer(30));
      header.setUint32(0, 0x04034b50, true);
      header.setUint16(4, 20, true);
      header.setUint16(12, 0x21, true);
      for (const index of [18, 22]) header.setUint32(index, data.length, true);
      header.setUint32(14, crc, true);
      header.setUint16(26, name.length, true);
      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true);
      entry.setUint16(4, 20, true);
      new Uint8Array(entry.buffer).set(new Uint8Array(header.buffer, 4, 26), 6);
      entry.setUint32(42, offset, true);
      local.push(header.buffer, name, data);
      directory.push(entry.buffer, name);
      offset += 30 + name.length + data.length;
      centralSize += 46 + name.length;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    for (const index of [8, 10]) end.setUint16(index, Object.keys(files).length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return URL.createObjectURL(new Blob([...local, ...directory, end.buffer], { type: "application/zip" }));
  }

  function processOrder(request) {
    const orderId = "PO-" + request.intent;
    const lines = [
      { line_id: "L1", sku: "PAPER", qty: request.quantity, unit_minor: 1200, declared_minor: 12500 },
      { line_id: "L2", sku: "CLIP", qty: 2, unit_minor: 350, declared_minor: 700 },
    ];
    const csv = request.format === "csv";
    const input = csv
      ? ["order_id,currency,line_id,sku,qty,unit_minor,declared_minor",
        ...lines.map(line => [orderId, "HKD", ...Object.values(line)].join(","))].join("\n") + "\n"
      : '<order order_id="' + orderId + '" currency="HKD">\n' + lines.map(line =>
        "  <line " + Object.entries(line).map(([key, value]) => key + '="' + value + '"').join(" ") + "/>"
      ).join("\n") + "\n</order>\n";
    const amount = line => line.declared_minor - line.qty * line.unit_minor;
    const report = {
      order_id: orderId, currency: "HKD",
      lines: lines.map((line, i) => ({ ...line, delta_minor: amount(line) + (i === 0 && request.fault ? 1 : 0) })),
    };
    const checks = [
      rule("ORDER", "Order reference", report.order_id === orderId),
      rule("LINES", "Line completeness", report.lines.map(line => line.line_id).join(",") === lines.map(line => line.line_id).join(",")),
      rule("CURRENCY", "Currency", report.currency === "HKD"),
      rule("SOURCE_FIELDS", "Source field match", lines.every((line, i) =>
        Object.entries(line).every(([key, value]) => report.lines[i][key] === value))),
      rule("ARITHMETIC", "Arithmetic in HKD cents", lines.every((line, i) => report.lines[i].delta_minor === amount(line))),
    ];
    const accepted = checks.every(check => check.status === "pass");
    const merchant = csv ? merchants.a : merchants.b;
    const fee = (merchant.amount / 1000000).toFixed(2);
    const timestamp = Date.now();
    const record = {
      mode: "local", reference: request.intent, paymentId: "sim-" + request.intent,
      merchant: merchant.name, status: accepted ? "settled" : "rejected",
      format: request.format, input, report, checks, fee, paid: accepted ? fee : "0.00",
      authorizedAt: new Date(timestamp).toISOString(), closedAt: new Date().toISOString(),
      budgetDay: Math.floor((timestamp + 8 * 3600000) / 86400000), transactions: {},
    };
    record.evidence = filesToZip({
      ["order." + request.format]: input,
      "report.json": JSON.stringify(report, null, 2),
      "simulation.json": JSON.stringify({ ...record, input: undefined, report: undefined,
        mode: "browser-simulation", signing: "unsigned", chain: null }, null, 2),
    });
    return record;
  }

  return {
    async load() {
      const response = await fetch("/replay.json");
      if (!response.ok) return response;
      return Response.json({ records: await response.json(), merchants });
    },
    async purchase(request) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.intent) || !["csv", "xml"].includes(request.format) ||
          !Number.isInteger(request.quantity) || request.quantity < 1 || request.quantity > 1000 ||
          typeof request.fault !== "boolean") {
        return Response.json({ error: "Choose a valid format and whole quantity between 1 and 1,000." }, { status: 400 });
      }
      const fingerprint = JSON.stringify(request);
      const original = orders.get(request.intent);
      if (original) {
        if (fingerprint !== original.fingerprint) return Response.json({ error: "Order details changed. Start a new purchase." }, { status: 409 });
        return Response.json({ ...original.record, recovered: true });
      }
      const record = processOrder(request);
      orders.set(request.intent, { fingerprint, record });
      return Response.json(record);
    },
  };
})();
