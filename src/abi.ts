// Minimal ABIs, hand-written to match the HoodPaid contracts (only what the keeper needs).

export const registryAbi = [
  { type: "function", name: "bindWallet", stateMutability: "nonpayable",
    inputs: [{ name: "payeeId", type: "bytes32" }, { name: "wallet", type: "address" }], outputs: [] },
  { type: "function", name: "walletOf", stateMutability: "view",
    inputs: [{ name: "payeeId", type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "isKeeper", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "event", name: "WalletBound", inputs: [
    { name: "payeeId", type: "bytes32", indexed: true },
    { name: "wallet", type: "address", indexed: true },
    { name: "keeper", type: "address", indexed: true },
  ] },
] as const;

export const routerAbi = [
  { type: "function", name: "registerToken", stateMutability: "nonpayable", inputs: [
    { name: "token", type: "address" }, { name: "payeeId", type: "bytes32" },
    { name: "asset", type: "address" }, { name: "launchpad", type: "address" },
  ], outputs: [] },
  { type: "function", name: "collect", stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }], outputs: [{ name: "received", type: "uint256" }] },
  { type: "function", name: "collectMany", stateMutability: "nonpayable",
    inputs: [{ name: "tokens", type: "address[]" }], outputs: [] },
  { type: "function", name: "claimable", stateMutability: "view",
    inputs: [{ name: "payeeId", type: "bytes32" }, { name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "pushPayout", stateMutability: "nonpayable", inputs: [
    { name: "payeeId", type: "bytes32" }, { name: "asset", type: "address" }, { name: "amount", type: "uint256" },
  ], outputs: [] },
  { type: "function", name: "protocolAccrued", stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "claimProtocol", stateMutability: "nonpayable",
    inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "event", name: "TokenRegistered", inputs: [
    { name: "token", type: "address", indexed: true },
    { name: "payeeId", type: "bytes32", indexed: true },
    { name: "asset", type: "address", indexed: false },
    { name: "launchpad", type: "address", indexed: false },
  ] },
  { type: "event", name: "FeesRouted", inputs: [
    { name: "token", type: "address", indexed: true },
    { name: "payeeId", type: "bytes32", indexed: true },
    { name: "asset", type: "address", indexed: true },
    { name: "toPayee", type: "uint256", indexed: false },
    { name: "toProtocol", type: "uint256", indexed: false },
  ] },
] as const;

export const allocationsAbi = [
  { type: "function", name: "allocated", stateMutability: "view",
    inputs: [{ name: "token", type: "address" }, { name: "payeeId", type: "bytes32" }],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "pending", stateMutability: "view",
    inputs: [{ name: "token", type: "address" }, { name: "payeeId", type: "bytes32" }],
    outputs: [{ name: "amount", type: "uint256" }, { name: "claimable", type: "bool" }] },
  { type: "function", name: "pushClaim", stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }, { name: "payeeId", type: "bytes32" }],
    outputs: [{ name: "amount", type: "uint256" }] },
  { type: "event", name: "Allocated", inputs: [
    { name: "token", type: "address", indexed: true },
    { name: "payeeId", type: "bytes32", indexed: true },
    { name: "from", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "total", type: "uint256", indexed: false },
  ] },
] as const;

export const erc20Abi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

// Pons fee locker — used to verify a launch really routes to our Router before we register it.
export const lockerAbi = [
  { type: "function", name: "feeRedirects", stateMutability: "view",
    inputs: [{ name: "token", type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getLaunchedToken", stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "tuple", components: [
      { name: "token", type: "address" }, { name: "deployer", type: "address" },
      { name: "pairedToken", type: "address" }, { name: "positionManager", type: "address" },
      { name: "positionId", type: "uint256" }, { name: "dexId", type: "uint256" },
      { name: "launchConfigId", type: "uint256" }, { name: "restrictionsEndBlock", type: "uint256" },
      { name: "supply", type: "uint256" }, { name: "isToken0", type: "bool" },
      { name: "poolFee", type: "uint24" }, { name: "exists", type: "bool" },
      { name: "initialBuyAmount", type: "uint256" },
    ] }] },
] as const;
