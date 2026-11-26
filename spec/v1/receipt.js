const types = {
  Receipt: [
    { name: "paymentId", type: "bytes32" },
    { name: "merchant", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "inputHash", type: "bytes32" },
    { name: "outputHash", type: "bytes32" },
    { name: "rulesVersion", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
};

module.exports = { types };
