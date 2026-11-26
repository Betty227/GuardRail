const { verifyTypedData } = require("ethers");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { canonical, hash } = require("../spec/v1/hashes");

const directory = process.argv[2];
const read = name => fs.readFileSync(path.join(directory, name));
const report = JSON.parse(read("report.json"));
const outputHash = hash(canonical(report));

if (fs.existsSync(path.join(directory, "receipt.json"))) {
  const bundle = JSON.parse(read("receipt.json"));
  const inputFile = bundle.inputFile || "order.csv";
  if (!["order.csv", "order.xml"].includes(inputFile) || bundle.canonicalization !== "guardrail-report-v1" ||
      hash(read(inputFile)) !== bundle.receipt.inputHash || outputHash !== bundle.receipt.outputHash ||
      verifyTypedData(bundle.domain, bundle.types, bundle.receipt, bundle.signature) !== bundle.verifier) {
    throw Error("Receipt integrity check failed");
  }
  console.log("Input, output and bundled signer matched. Confirm the trusted verifier and settlement against the vault separately.");
} else {
  const decision = JSON.parse(read("decision.json"));
  if (decision.status !== "rejected" || !["csv", "xml"].includes(decision.format)) throw Error("Unknown evidence type");
  const input = read("order." + decision.format);
  if (hash(input) !== decision.inputHash || outputHash !== decision.outputHash) throw Error("Decision integrity check failed");
  const result = JSON.parse(execFileSync("python3", [path.join(__dirname, "../spec/v1/acceptance.py")], {
    input: JSON.stringify({ input: input.toString("utf8"), format: decision.format, report }),
  }));
  const recorded = decision.checks.filter(check => check.status === "fail").map(check => check.id).sort();
  if (!recorded.length || JSON.stringify(recorded) !== JSON.stringify(result.failures)) throw Error("Rejection rules disagree");
  console.log("Reproduced buyer rejection rules:", recorded.join(", "));
  console.log(decision.mode === "aevum"
    ? "Verify the recorded release separately against the Aevum vault."
    : "Verify the recorded release separately while the local chain is available.");
}
