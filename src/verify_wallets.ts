import { Network, Alchemy } from "alchemy-sdk";
import { ethers, BigNumber } from "ethers";
import axios from "axios";
import * as fs from "fs";
import { DATA_DIR, LOCAL_RPC_URL } from "./common";

// ================= 配置区域 =================
const ALCHEMY_API_KEY = "Dy8qDdgHXfCqzP-o1Bw2X"; 
const MIN_WALLET_VALUE_USD = 1000;

const TOKENS: Record<string, string> = {
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    VIRTUAL: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
    
    // [修正] LUNA 地址改回 Token 合约地址 (之前给成了 Pair 地址)
    LUNA: "0x55f1fa9b4244d5276aa3e3aaf1ad56ebbc55422d", 
    
    AIXBT: "0x4F9Fd6Be4a90f2620860d680c0d4d5Fb53d1A825",
    SEKOIA: "0x231d61c6762391062df09a6327b729f939023479",
    CLANKER: "0x1a337774783329D4d3600F6236b2A3b68077D322",
    GAME: "0x1c4cca7c5db003824208adda61bd749e55f463a3",
    
    BRETT: "0x532f27101965dd16442e59d40670faf5ebb142e4",
    DEGEN: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed",
    TOSHI: "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4",
    LUMIO: "0x0b62372a392b92440360a760670929949704772b",
    KEYCAT: "0x9a26f5433671751c3276a065f57e5a02d281797d",
    MOG: "0x2Da56AcB9Ea78330f947bD57C54119Debda7AF71"
};

// [新增] API 挂掉时的保底价格 (估值，确保不会被当成 $0)
const FALLBACK_PRICES: Record<string, number> = {
    [TOKENS.WETH]: 3200,
    [TOKENS.LUNA]: 0.15,   // 保底价
    [TOKENS.AIXBT]: 0.03,  // 保底价
    [TOKENS.SEKOIA]: 0.02, // 保底价
    [TOKENS.CLANKER]: 50,  // 保底价
    [TOKENS.GAME]: 0.005,
    [TOKENS.USDC]: 1.0
};

// [修改] 移除 Alchemy SDK 的强依赖，改用本地 Provider
// const settings = { apiKey: ALCHEMY_API_KEY, network: Network.BASE_MAINNET };
// const alchemy = new Alchemy(settings);

const provider = new ethers.providers.JsonRpcProvider(LOCAL_RPC_URL);

export async function verifyWalletWealth(inputCandidates?: string[]): Promise<string[]> {
    console.log("[System] Starting Wallet Wealth Verifier (FAIL-SAFE MODE)...");
    
    let candidates = inputCandidates || [];
    if (candidates.length === 0) {
        candidates = await loadCandidates();
    }

    if (candidates.length === 0) {
        console.log("[System] No candidates found.");
        return [];
    }
    
    // 测试本地节点连接
    try {
        const block = await provider.getBlockNumber();
        console.log(`[System] Connected to Local Node. Current Block: ${block}`);
    } catch (e) {
        console.error("[Error] Failed to connect to Local Node. Check LOCAL_RPC_URL.");
        return;
    }

    console.log("[System] Fetching prices...");
    const prices = await getTokenPrices(Object.values(TOKENS));
    
    // [调试] 打印最终价格 (绝不会是 undefined)
    console.log("[System] Final Price Table:");
    console.log(`   - AIXBT: $${prices[TOKENS.AIXBT.toLowerCase()].toFixed(4)}`);
    console.log(`   - LUNA:  $${prices[TOKENS.LUNA.toLowerCase()].toFixed(4)}`);
    console.log(`   - CLANKER: $${prices[TOKENS.CLANKER.toLowerCase()].toFixed(2)}`);

    const ethPrice = prices[TOKENS.WETH.toLowerCase()];
    const richList = [];
    console.log("[System] Checking balances...");

    // 预先构建 ERC20 合约对象接口 (只读 balanceOf)
    const erc20Abi = ["function balanceOf(address) view returns (uint256)"];

    for (let i = 0; i < candidates.length; i++) {
        const wallet = candidates[i];
        process.stdout.write(`\r   Checking ${i+1}/${candidates.length}: ${wallet.slice(0,6)}...`);
        try {
            // [优化] 使用本地节点查询 ETH 余额 (免费)
            const ethBal = await provider.getBalance(wallet);
            const ethVal = parseFloat(ethers.utils.formatEther(ethBal)) * ethPrice;
            
            let totalTokenVal = 0;
            const holdingDetails: string[] = [];

            // [新增] 将 ETH 余额加入显示详情
            if (ethVal > 10) {
                holdingDetails.push(`ETH: $${ethVal.toFixed(0)}`);
            }

            // [优化] 使用本地节点循环查询 Token 余额 (免费且极快)
            // 相比 Alchemy getTokenBalances，这里虽然并发请求多，但走本地回环网络几乎无延迟
            const tokenChecks = Object.values(TOKENS).map(async (tokenAddr) => {
                const contract = new ethers.Contract(tokenAddr, erc20Abi, provider);
                try {
                    const bal = await contract.balanceOf(wallet);
                    if (bal.isZero()) return;

                    const addr = tokenAddr.toLowerCase();
                    let decimals = 18;
                    if (addr === TOKENS.USDC.toLowerCase()) decimals = 6;
                    
                    // 简单的格式化，不依赖复杂库
                    const valFmt = parseFloat(ethers.utils.formatUnits(bal, decimals));
                    const usdVal = valFmt * prices[addr];
                    
                    if (usdVal > 10) {
                        totalTokenVal += usdVal;
                        const symbol = Object.keys(TOKENS).find(k => TOKENS[k].toLowerCase() === addr) || "UNKNOWN";
                        holdingDetails.push(`${symbol}: $${usdVal.toFixed(0)}`);
                    }
                } catch (e) {}
            });

            // 等待所有 Token 查询完成
            await Promise.all(tokenChecks);

            const totalNetWorth = ethVal + totalTokenVal;

            // [逻辑] 只要总资产达标就收录，没有其他风控
            if (totalNetWorth > MIN_WALLET_VALUE_USD) {
                richList.push({
                    address: wallet,
                    netWorth: totalNetWorth,
                    holdings: holdingDetails.join(", ")
                });
            }
        } catch (e) {
            // console.error(e);
        }
    }

    richList.sort((a, b) => b.netWorth - a.netWorth);
    console.log(`\n\n================ REAL WHALES FOUND (${richList.length}) ================`);
    richList.forEach(w => {
        const icon = w.netWorth > 10000 ? "[WHALE]" : "[FISH]";
        console.log(`${icon} [${w.address}] Worth: $${w.netWorth.toFixed(0)} | Holds: ${w.holdings}`);
    });

    const exportLines = richList.map(w => w.address);
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
    fs.writeFileSync(`${DATA_DIR}/verified_wallets.json`, JSON.stringify(exportLines, null, 2));
    console.log(`\n[System] Saved ${exportLines.length} wallets to ${DATA_DIR}/verified_wallets.json`);

    return exportLines;
}

async function getTokenPrices(addresses: string[]) {
    const priceMap: Record<string, number> = {};
    const missing: string[] = [];

    // 1. 尝试 DexScreener
    try {
        const url = `https://api.dexscreener.com/latest/dex/tokens/${addresses.join(",")}`;
        const res = await axios.get(url);
        if (res.data.pairs) {
            res.data.pairs.forEach((p: any) => {
                if (p.chainId === "base" && p.baseToken && p.priceUsd) {
                    priceMap[p.baseToken.address.toLowerCase()] = parseFloat(p.priceUsd);
                }
            });
        }
    } catch (e) { console.log("DexScreener API Error"); }

    // 2. 检查缺失
    addresses.forEach(addr => {
        if (!priceMap[addr.toLowerCase()]) missing.push(addr);
    });

    // 3. 尝试 GeckoTerminal (带 User-Agent 避免 403)
    if (missing.length > 0) {
        try {
            const gtUrl = `https://api.geckoterminal.com/api/v2/simple/networks/base/token_prices/${missing.join(",")}`;
            const gtRes = await axios.get(gtUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': 'application/json'
                }
            });
            const data = gtRes.data?.data?.attributes?.token_prices || {};
            for (const [addr, price] of Object.entries(data)) {
                priceMap[addr.toLowerCase()] = parseFloat(price as string);
            }
        } catch (e) { console.log("GeckoTerminal API Error (Likely rate limited)"); }
    }

    // 4. [核心] 强制保底机制
    // 如果 API 没取到，就用我们硬编码的价格，防止 $ERROR
    for (const [key, addr] of Object.entries(TOKENS)) {
        const lowerAddr = addr.toLowerCase();
        if (!priceMap[lowerAddr]) {
            // console.log(`[System] Using Fallback price for ${key}`);
            priceMap[lowerAddr] = FALLBACK_PRICES[addr] || 0;
        }
    }

    return priceMap;
}

async function loadCandidates(): Promise<string[]> {
    if (!fs.existsSync(DATA_DIR)) return [];
    const files = fs.readdirSync(DATA_DIR);
    
    // [修改] 优先读取新的 JSON 格式
    if (fs.existsSync(`${DATA_DIR}/legends_base.json`)) {
        const content = fs.readFileSync(`${DATA_DIR}/legends_base.json`, "utf-8");
        return JSON.parse(content);
    }
    
    return [];
}

if (require.main === module) {
    verifyWalletWealth();
}