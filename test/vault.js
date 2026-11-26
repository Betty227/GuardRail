const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("node:fs");
const { hash, canonical } = require("../spec/v1/hashes");
const { execFileSync } = require("node:child_process");
const { types } = require("../spec/v1/receipt");
describe("GuardRail buyer vault", function () {
  let buyer, agent, merchant, verifier, relay, asset, vault, q, domain;
  const intent = ethers.id("purchase-1");
  const outputHash = hash(canonical(require("../spec/v1/report.json")));
  beforeEach(async function () {
    [buyer, agent, merchant, verifier, relay] = await ethers.getSigners();
    asset = await ethers.deployContract("TestAsset");
    vault = await ethers.deployContract("GuardRailVault",[asset.target,buyer.address,verifier.address]);
    await asset.approve(vault.target, 500000);
    await vault.deposit(500000);
    await vault.setPolicy(agent.address,100000,150000);
    await vault.setMerchant(merchant.address,true);
    q = { merchant: merchant.address, amount: 100000, inputHash: hash(fs.readFileSync("spec/v1/order.csv")), serviceVersion: ethers.id("orders-v1"), rulesVersion: ethers.id("buyer-v1"), deadline: await time.latest()+172800 };
    domain = { name:"GuardRail",version:"1",chainId:(await ethers.provider.getNetwork()).chainId,verifyingContract:vault.target };
  });
  async function reserve() {
    const v = vault.connect(agent);
    const id = await v.reserve.staticCall(intent,q);
    await v.reserve(intent,q);
    return id;
  }
  it("one intent, two submissions, one signed receipt and one merchant credit; new intent purchases again", async function () {
    execFileSync("python3",["spec/v1/verify_examples.py"]);
    const id = await reserve();
    expect(await reserve()).to.equal(id);
    const receipt = Object.fromEntries(types.Receipt.map(({name}) => [name, ({paymentId:id,outputHash,...q})[name]]));
    const sig = await verifier.signTypedData(domain,types,receipt);
    await expect(vault.connect(relay).capturePayment(id,ethers.ZeroHash,sig)).to.be.revertedWith("invalid receipt");
    await expect(vault.connect(relay).capturePayment(id,outputHash,sig)).to.emit(vault,"Captured");
    await expect(vault.connect(relay).capturePayment(id,outputHash,sig)).to.be.revertedWith("not capturable");
    expect(await reserve()).to.equal(id);
    expect(await asset.balanceOf(merchant.address)).to.equal(100000);
    expect(await vault.reserved()).to.equal(0);
    await vault.setPolicy(agent.address,100000,200000);
    const next = ethers.id("purchase-2");
    expect(await vault.connect(agent).reserve.staticCall(next,q)).not.to.equal(id);
    await vault.connect(agent).reserve(next,q);
    expect(await vault.reserved()).to.equal(100000);
  });
  it("rejects quote changes and enforces aggregate reservations", async function () {
    await reserve();
    await expect(vault.connect(agent).reserve(intent,{...q,amount:1})).to.be.revertedWith("intent conflict");
    await expect(vault.connect(agent).reserve(ethers.id("other"),q)).to.be.revertedWith("daily cap");
    await expect(vault.withdraw(400001)).to.be.revertedWith("reserved funds");
  });
  it("releases only the original Hong Kong day and preserves terminal intents",async function () {
    const id = await reserve();
    const day = (await vault.payment(id)).budgetDay;
    await time.increaseTo(q.deadline+1);
    await vault.connect(relay).voidPayment(id);
    expect(await vault.dayUsed(day)).to.equal(0);
    expect(await reserve()).to.equal(id);
    expect((await vault.payment(id)).state).to.equal(3);
    expect(await vault.reserved()).to.equal(0);
  });
  it("serializes competing reservations against the same daily cap", async function () {
    const attempts = await Promise.allSettled([
      vault.connect(agent).reserve(intent, q),
      vault.connect(agent).reserve(ethers.id("competing"), q),
    ]);
    const successful = attempts.filter(attempt => attempt.status === "fulfilled");
    expect(successful).to.have.length(1);
    await successful[0].value.wait();
    expect(attempts.find(attempt => attempt.status === "rejected").reason.message).to.include("daily cap");
    expect(await vault.reserved()).to.equal(100000);
  });

  it("lets the verifier reject early, even while paused", async function () {
    const id = await reserve();
    const receipt = { paymentId: id, outputHash, ...q };
    const signature = await verifier.signTypedData(domain, types, receipt);
    await expect(vault.connect(agent).setPaused(true)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    await vault.setPaused(true);
    await expect(vault.connect(agent).reserve(ethers.id("paused"), q)).to.be.revertedWith("policy");
    await expect(vault.connect(relay).capturePayment(id, outputHash, signature)).to.be.revertedWith("not capturable");
    await expect(vault.connect(agent).voidPayment(id)).to.be.revertedWith("not voidable");
    await expect(vault.connect(verifier).voidPayment(id)).to.emit(vault, "Voided").withArgs(id);
    expect(await vault.reserved()).to.equal(0);
    expect(await vault.dayUsed((await vault.payment(id)).budgetDay)).to.equal(0);
    expect(await asset.balanceOf(merchant.address)).to.equal(0);
  });

  it("revokes agent reservations while preserving settlement of an existing signed receipt", async function () {
    const id = await reserve();
    await expect(vault.connect(agent).setPolicy(ethers.ZeroAddress, 0, 0)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    await vault.setPolicy(ethers.ZeroAddress, 100000, 150000);
    await expect(vault.connect(agent).reserve(ethers.id("after-revocation"), q)).to.be.revertedWith("buyer or agent");
    const signature = await verifier.signTypedData(domain, types, { paymentId: id, outputHash, ...q });
    await expect(vault.connect(relay).capturePayment(id, outputHash, signature)).to.emit(vault, "Captured");
    expect(await asset.balanceOf(merchant.address)).to.equal(100000);
  });

  it("matches Python canonicalization for the report and non-ASCII text",function () {
    const value = {...require("../spec/v1/report.json"),order_id:"香港📦"};
    const expected = execFileSync("python3",["-c","import json,sys; print(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(',',':')),end='')"],{input:JSON.stringify(value),encoding:"utf8"});
    expect(canonical(value)).to.equal(expected);
  });
});
