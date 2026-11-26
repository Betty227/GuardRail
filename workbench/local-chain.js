const path = require("node:path");
const fs = require("node:fs/promises");
const { ethers, network } = require("hardhat");
const { canonical, hash } = require("../spec/v1/hashes");
const { types } = require("../spec/v1/receipt");
const { orderFor, merchants, selectMerchant, deliver, accept } = require("./procurement");

async function createLocalChain(evidenceRoot) {
  if (network.name !== "hardhat" || (await ethers.provider.getNetwork()).chainId !== 31337n) {
    throw Error("The interactive workbench requires an isolated Hardhat chain (31337).");
  }

  const [owner, agent, verifier, merchantA, merchantB] = await ethers.getSigners();
  const asset = await ethers.deployContract("TestAsset", [], owner);
  await asset.waitForDeployment();
  const vault = await ethers.deployContract("GuardRailVault", [asset.target, owner.address, verifier.address], owner);
  await vault.waitForDeployment();
  await (await asset.approve(vault.target, 10000000n)).wait();
  await (await vault.deposit(10000000n)).wait();
  await (await vault.setPolicy(agent.address, 100000, 2000000)).wait();
  await (await vault.setMerchant(merchantA.address, true)).wait();
  await (await vault.setMerchant(merchantB.address, true)).wait();

  const merchantAddresses = { a: merchantA.address, b: merchantB.address };
  const jobs = new Map();
  const domain = { name: "GuardRail", version: "1", chainId: "31337", verifyingContract: vault.target };
  const purchase = async request => {
    const fingerprint = JSON.stringify(request);
    let job = jobs.get(request.intent);
    if (job && job.fingerprint !== fingerprint) throw new Error("This intent already has a different order or quote.");
    if (job?.record) return { ...job.record, recovered: true };

    if (!job) {
      const merchant = selectMerchant(request.format);
      const { input } = orderFor(request);
      const intent = ethers.id(request.intent);
      const paymentId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes32"], [vault.target, intent]));
      const quote = {
        merchant: merchantAddresses[merchant],
        amount: String(merchants[merchant].amount),
        inputHash: hash(Buffer.from(input)),
        serviceVersion: ethers.id("merchant-" + merchant + "-v1"),
        rulesVersion: ethers.id("buyer-v1"),
        deadline: (await ethers.provider.getBlock("latest")).timestamp + 3600,
      };
      job = { fingerprint, merchant, input, intent, paymentId, quote };
      jobs.set(request.intent, job);
    }

    const { merchant, input, intent, paymentId, quote } = job;
    // Once reserved, retries continue with the original quote and chain transaction.
    if (!job.reserved) job.reserved = await (await vault.connect(agent).reserve(intent, quote)).wait();
    const report = deliver(merchant, request);
    const checks = await accept(input, request.format, report);
    const accepted = checks.every(check => check.status === "pass");
    const outputHash = hash(canonical(report));
    const receipt = {
      paymentId, merchant: quote.merchant, amount: quote.amount, inputHash: quote.inputHash,
      outputHash, rulesVersion: quote.rulesVersion, deadline: quote.deadline,
    };
    if (!job.closed) {
      if (accepted) {
        job.signature = await verifier.signTypedData(domain, types, receipt);
        job.closed = await (await vault.connect(agent).capturePayment(paymentId, outputHash, job.signature)).wait();
      } else {
        job.closed = await (await vault.connect(verifier).voidPayment(paymentId)).wait();
      }
    }

    const [reservationBlock, closingBlock, payment] = await Promise.all([
      job.reserved.getBlock(), job.closed.getBlock(), vault.payment(paymentId),
    ]);
    const record = {
      mode: "local", chainId: 31337, vault: vault.target, reference: request.intent, paymentId,
      status: accepted ? "settled" : "rejected", merchant: merchants[merchant].name,
      selection: merchant === "a" ? "Lowest-priced merchant that supports CSV." : "Only Merchant B supports XML.",
      format: request.format, input, report, checks, fee: ethers.formatUnits(quote.amount, 6),
      paid: accepted ? ethers.formatUnits(quote.amount, 6) : "0.00",
      budgetDay: Number(payment.budgetDay),
      authorizedAt: new Date(reservationBlock.timestamp * 1000).toISOString(),
      closedAt: new Date(closingBlock.timestamp * 1000).toISOString(),
      transactions: {
        reserve: job.reserved.hash,
        [accepted ? "capture" : "void"]: job.closed.hash,
      },
      evidence: "/api/evidence/" + paymentId + ".zip",
    };
    const dir = path.join(evidenceRoot, paymentId);
    const inputFile = "order." + request.format;
    await fs.mkdir(dir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(dir, inputFile), input),
      fs.writeFile(path.join(dir, "report.json"), JSON.stringify(report, null, 2)),
      fs.writeFile(path.join(dir, "decision.json"), JSON.stringify({ ...record, input: undefined, report: undefined, inputHash: quote.inputHash, outputHash }, null, 2)),
      accepted && fs.writeFile(path.join(dir, "receipt.json"), JSON.stringify({
        canonicalization: "guardrail-report-v1", domain, types, receipt, signature: job.signature,
        verifier: verifier.address, intent, quote, asset: asset.target, inputFile, transactions: record.transactions,
      }, null, 2)),
    ]);
    job.record = record;
    return record;
  };

  return { purchase, list: () => [...jobs.values()].flatMap(job => job.record ? [job.record] : []) };
}

module.exports = { createLocalChain };
