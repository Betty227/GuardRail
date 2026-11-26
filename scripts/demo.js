// Run with Hardhat. A live run deploys a fresh dedicated demonstration vault.
const { ethers, network } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { hash, canonical } = require("../spec/v1/hashes");
const fields = "bytes32 paymentId,address merchant,uint256 amount,bytes32 inputHash,bytes32 outputHash,bytes32 rulesVersion,uint64 deadline";
async function main() {
  const live = network.name === "aevum";
  if (live) throw Error("Use scripts/deploy.js and scripts/purchase.js for persistent Aevum deployments");
  const net = await ethers.provider.getNetwork();
  if (live && net.chainId !== 44005n) throw Error("Unexpected deployment network");
  const [buyer] = await ethers.getSigners();
  if (!buyer) throw Error("Configure GUARDRAIL_AEVUM_KEY locally for the funded test wallet");
  // A disposable, independent verifier and merchant are used only for this synthetic run.
  const verifier = ethers.Wallet.createRandom();
  const merchant = live ? process.env.GUARDRAIL_MERCHANT : (await ethers.getSigners())[2].address;
  if (!ethers.isAddress(merchant) || merchant === ethers.ZeroAddress) throw Error("Configure GUARDRAIL_MERCHANT");
  const asset = live ? await ethers.getContractAt("IERC20","0x456569838f1d43009A91ebA4263147Afd7233483") : await ethers.deployContract("TestAsset");
  const fee = 100000n;
  if (await asset.balanceOf(buyer.address) < fee) throw Error("Deployment wallet needs at least 0.10 tUSD8");
  if (await ethers.provider.getBalance(buyer.address) === 0n) throw Error("Deployment wallet needs gas");
  execFileSync("python3",["spec/v1/verify_examples.py"]);
  const source = fs.readFileSync("spec/v1/order.csv");
  const output = fs.readFileSync("spec/v1/report.json");
  const outputHash = hash(canonical(JSON.parse(output)));
  const vault = await ethers.deployContract("GuardRailVault",[asset.target,buyer.address,verifier.address]);
  await vault.waitForDeployment();
  async function mined(tx) { return (await tx).wait(); }
  await mined(asset.approve(vault.target,fee));
  await mined(vault.deposit(fee));
  await mined(vault.setPolicy(buyer.address,fee,fee));
  await mined(vault.setMerchant(merchant,true));
  const intent = ethers.hexlify(ethers.randomBytes(32));
  const q = { merchant, amount:fee.toString(), inputHash:hash(source),serviceVersion:ethers.id("orders-v1"),rulesVersion:ethers.id("buyer-v1"),deadline:(await ethers.provider.getBlock("latest")).timestamp + 3600 };
  const paymentId = await vault.reserve.staticCall(intent,q);
  const reservation = await mined(vault.reserve(intent,q));
  const retry = await mined(vault.reserve(intent,q));
  const domain = { name:"GuardRail", version:"1", chainId:net.chainId.toString(), verifyingContract:vault.target };
  const types = {Receipt:fields.split(",").map(s=>{const [type,name]=s.split(" ");return {name,type};})};
  const receipt = { paymentId,merchant,amount:q.amount,inputHash:q.inputHash,outputHash,rulesVersion:q.rulesVersion,deadline:q.deadline };
  const signature = await verifier.signTypedData(domain,types,receipt);
  const settled = await mined(vault.capturePayment(paymentId,outputHash,signature));
  if ((await vault.payment(paymentId)).state !== 2n || await vault.reserved() !== 0n) throw Error("Unexpected final state");
  const dir = path.join("evidence",network.name,paymentId);
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"order.csv"),source);
  fs.writeFileSync(path.join(dir,"report.json"),output);
  fs.writeFileSync(path.join(dir,"receipt.json"),JSON.stringify({canonicalization:"guardrail-report-v1",domain,types,receipt,signature,verifier:verifier.address,intent,quote:q,asset:asset.target,transactions:{reserve:reservation.hash,retry:retry.hash,capture:settled.hash}},null,2));
  console.log(dir);
}
main().catch(error=>{console.error(error.shortMessage || error.message);process.exitCode=1;});
