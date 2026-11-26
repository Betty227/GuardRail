require("@nomicfoundation/hardhat-toolbox");
module.exports = {
  networks: {
    localhost: { url: process.env.GUARDRAIL_LOCAL_RPC || "http://127.0.0.1:8545" },
    aevum: {
      url: "https://rpc-test.qday.info",
      chainId: 44005,
      accounts: [],
    },
  },
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" } },
};
