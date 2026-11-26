const fs = require("node:fs");
const path = require("node:path");
const {execFileSync} = require("node:child_process");
const {ethers} = require("hardhat");
const {root, manifest, save, load, signer} = require("./runtime");
const {hash,canonical} = require("../spec/v1/hashes");
const {types} = require("../spec/v1/receipt");
async function purchase(label) {
  if (!label) throw Error("Set GUARDRAIL_INTENT to a stable purchase reference");
  const d = load(manifest);
  const agent = await signer("AGENT",1), verifier = await signer("VERIFIER",2);
  const vault = await ethers.getContractAt("GuardRailVault",d.vault,agent);
  if (!d.ready || (await ethers.provider.getNetwork()).chainId.toString() !== d.chainId ||
      agent.address !== d.agent || verifier.address !== d.verifier || await vault.verifier() !== d.verifier ||
      await vault.token() !== d.asset) throw Error("Deployment or role mismatch");
  const intent = ethers.id(label);
  const paymentId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address","bytes32"],[d.vault,intent]));
  const dir = path.join(root,paymentId);
  fs.mkdirSync(dir,{recursive:true});
  const file = path.join(dir,"receipt.json");
  let p = await vault.payment(paymentId);
  if (p.state === 3n) throw Error("Purchase ended; use a new reference");
  if (p.state === 2n && fs.existsSync(file)) {
    const existing = load(file);
    if (existing.transactions.capture) {
      const tx = await ethers.provider.getTransactionReceipt(existing.transactions.capture);
      if (!tx || !tx.logs.some(log=>log.address.toLowerCase() === d.vault.toLowerCase() &&
        log.topics[0] === vault.interface.getEvent("Captured").topicHash && log.topics[1] === paymentId)) throw Error("Settlement record mismatch");
      execFileSync(process.execPath,["scripts/verify.js",dir]);
      return {status:"recovered",paymentId,transactionHash:tx.hash};
    }
  }
  let b;
  if (fs.existsSync(file)) b = load(file);
  else {
    execFileSync("python3",["spec/v1/verify_examples.py"]);
    const input = fs.readFileSync("spec/v1/order.csv"), output = fs.readFileSync("spec/v1/report.json");
    const q = {merchant:d.merchant,amount:"100000",inputHash:hash(input),serviceVersion:ethers.id("orders-v1"),rulesVersion:ethers.id("buyer-v1"),deadline:(await ethers.provider.getBlock("latest")).timestamp+3600};
    const receipt = {paymentId,merchant:q.merchant,amount:q.amount,inputHash:q.inputHash,outputHash:hash(canonical(JSON.parse(output))),rulesVersion:q.rulesVersion,deadline:q.deadline};
    const domain = {name:"GuardRail",version:"1",chainId:d.chainId,verifyingContract:d.vault};
    const signature = await verifier.signTypedData(domain,types,receipt);
    fs.writeFileSync(path.join(dir,"order.csv"),input);
    fs.writeFileSync(path.join(dir,"report.json"),output);
    b = {canonicalization:"guardrail-report-v1",domain,types,receipt,signature,verifier:d.verifier,intent,quote:q,asset:d.asset,transactions:{}};
    save(file,b);
  }
  if (p.state === 0n) {
    const tx = await (await vault.reserve(intent,b.quote)).wait();
    b.transactions.reserve = tx.hash; save(file,b);
  }
  if (!b.transactions.reserve || p.state === 2n) {
    const end = await ethers.provider.getBlockNumber();
    for (let start=d.block;start<=end;start+=1000) {
      for (const [key,filter] of [["reserve",vault.filters.Reserved(paymentId)],["capture",vault.filters.Captured(paymentId)]]) {
        if (!b.transactions[key]) {
          const events = await vault.queryFilter(filter,start,Math.min(end,start+999));
          if (events.length) b.transactions[key]=events[0].transactionHash;
        }
      }
    }
  }
  if (p.state !== 2n) {
    const tx = await (await vault.capturePayment(paymentId,b.receipt.outputHash,b.signature)).wait();
    b.transactions.capture = tx.hash;
  }
  if (!b.transactions.capture || !b.transactions.reserve) throw Error("Missing transaction evidence");
  save(file,b);
  return {status:"settled",paymentId,transactionHash:b.transactions.capture};
}
module.exports = {purchase};
if (require.main === module) purchase(process.env.GUARDRAIL_INTENT).then(console.log).catch(e=>{console.error(e.shortMessage || e.message);process.exitCode=1;});
