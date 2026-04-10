function uniqueUrls(items) {
    return Array.from(new Set((items || []).map((x) => String(x || "").trim()).filter(Boolean)));
}

const RPC_PROVIDERS = {
    ethereum: uniqueUrls([
        process.env.ETH_RPC_URL,
        "https://eth.llamarpc.com",
        "https://rpc.ankr.com/eth",
        "https://1rpc.io/eth"
    ]),
    bsc: uniqueUrls([
        process.env.BSC_RPC_URL,
        "https://bsc-dataseed.bnbchain.org",
        "https://bsc-dataseed1.binance.org",
        "https://1rpc.io/bnb"
    ]),
    base: uniqueUrls([
        process.env.BASE_RPC_URL,
        "https://mainnet.base.org",
        "https://base.llamarpc.com",
        "https://base-rpc.publicnode.com"
    ])
};

module.exports = { RPC_PROVIDERS };
