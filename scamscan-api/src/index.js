"use strict";

const { RPC_PROVIDERS } = require("./config/rpc");
const { detectType, detectChain } = require("./utils/domainUtils");

const { analyzeBtcAddressOnChain } = require("./services/btcService");
const { analyzeWebsiteContent } = require("./services/contentService");
const denylistStore = require("./services/denylistStore");
const evm = require("./services/evmService");
const onChainErrorNormalizer = require("./services/onChainErrorNormalizer");
const { getPageContent } = require("./services/renderService");
const { analyzeSolanaAddressOnChain } = require("./services/solanaService");
const { analyzeTonAddress, analyzeTonAddressOnChain } = require("./services/tonService");
const { analyzeTronAddressOnChain } = require("./services/tronService");
const { fetchTrc20MetaByCalls } = require("./services/tronTrc20Meta");
const { analyzeWallet } = require("./services/walletService");
const { fetchDomainWhois, analyzeWhois } = require("./services/whoisService");

module.exports = {
  RPC_PROVIDERS,
  detectType,
  detectChain,
  analyzeWallet,
  analyzeWebsiteContent,
  analyzeBtcAddressOnChain,
  analyzeSolanaAddressOnChain,
  analyzeTonAddress,
  analyzeTonAddressOnChain,
  analyzeTronAddressOnChain,
  fetchDomainWhois,
  analyzeWhois,
  getPageContent,
  fetchTrc20MetaByCalls,
  denylistStore,
  onChainErrorNormalizer,
  ...evm
};
