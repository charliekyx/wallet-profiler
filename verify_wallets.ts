import { Network, Alchemy } from "alchemy-sdk";
import axios from "axios";
import * as fs from "fs";
import { ethers } from "ethers";

// ================= 配置区域 =================
const ALCHEMY_API_KEY = "Dy8qDdgHXfCqzP-o1Bw2X"; // 你的 Alchemy Key
const MIN_WALLET_VALUE_USD = 1000; // 提高门槛：至少 1000U，过滤掉纯粹的屌丝号

// 只需要检查这几个核心资产
const TOKENS: Record<string, string> = {
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    VIRTUAL: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
    LUNA: "0x55f1fa9b4244d5276aa3e3aaf1ad56ebbc55422d",
    AIXBT: "0x4F9Fd6Be4a90f2620860d680c0d4d5Fb53d1A825",
    SEKOIA: "0x231d61c6762391062df09a6327b729f939023479",
    CLANKER: "0x1a337774783329D4d3600F6236b2A3b68077D322",
    LUMIO: "0x0b62372a392b92440360a760670929949704772b",
    GAME: "0x1c4cca7c5db003824208adda61bd749e55f463a3",
    BRETT: "0x532f27101965dd16442e59d40670faf5ebb142e4",
    DEGEN: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed",
    TOSHI: "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4",
    KEYCAT: "0x9a26f5433671751c3276a065f57e5a02d281797d",
    MOG: "0x2Da56AcB9Ea78330f947bD57C54119Debda7AF71"
};

// ===========================================

const settings = {
    apiKey: ALCHEMY_API_KEY,
    network: Network.BASE_MAINNET,
};
const alchemy = new Alchemy(settings);

async function main() {
    console.log("🚀 Starting Wallet Wealth Verifier...");

    // 1. 读取候选名单 (自动读取最新的 legends_base_xxxx.txt)
    const candidates = await loadCandidates();
    
    if (candidates.length === 0) {
        console.log("⚠️ No candidates found. Please run profile.ts first.");
        return;
    }
    console.log(`📋 Loaded ${candidates.length} candidates.`);

    // 2. 获取 Token 价格
    console.log("📈 Fetching current prices...");
    const prices = await getTokenPrices(Object.values(TOKENS));
    // 手动添加 ETH 价格 (WETH价格近似)
    const ethPrice = prices[TOKENS.WETH.toLowerCase()] || 3000;
    console.log(`   ETH Price: $${ethPrice}`);

    const richList = [];

    // 3. 批量查余额
    console.log("💰 Checking balances (This uses Alchemy Compute Units)...");
    
    // Alchemy 支持批量请求，但为了稳妥我们分批处理
    for (let i = 0; i < candidates.length; i++) {
        const wallet = candidates[i];
        process.stdout.write(`\r   Checking ${i+1}/${candidates.length}: ${wallet.slice(0,6)}...`);
        
        try {
            // A. 查 ETH 余额
            const ethBal = await alchemy.core.getBalance(wallet);
            const ethVal = parseFloat(ethers.utils.formatEther(ethBal)) * ethPrice;

            // B. 查 Token 余额
            const tokenBals = await alchemy.core.getTokenBalances(wallet, Object.values(TOKENS));
            
            let totalTokenVal = 0;
            let stableVal = 0; // Track stablecoin value (USDC)
            const holdingDetails: string[] = [];

            tokenBals.tokenBalances.forEach(t => {
                const addr = t.contractAddress.toLowerCase();
                if (prices[addr] && t.tokenBalance && t.tokenBalance !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
                    // 这里需要知道精度，简单起见我们假设绝大部分是 18，USDC 是 6
                    // 严谨做法是调用 metadata，但为了速度我们简化
                    let decimals = 18;
                    if (addr === TOKENS.USDC.toLowerCase()) decimals = 6;
                    
                    // 简单的 Hex 转 Decimal
                    const valBig = BigInt(t.tokenBalance);
                    const valFmt = Number(valBig) / (10 ** decimals);
                    const usdVal = valFmt * prices[addr];
                    
                    if (usdVal > 10) { // 只记录大于 $10 的持仓
                        totalTokenVal += usdVal;
                        
                        // Check for stables (USDC)
                        if (addr === TOKENS.USDC.toLowerCase()) {
                            stableVal += usdVal;
                        }

                        // 找 Token 名字
                        const symbol = Object.keys(TOKENS).find(k => TOKENS[k].toLowerCase() === addr) || "UNKNOWN";
                        holdingDetails.push(`${symbol}: $${usdVal.toFixed(0)}`);
                    }
                }
            });

            const totalNetWorth = ethVal + totalTokenVal;
            const safeAssets = ethVal + stableVal;

            if (totalNetWorth > MIN_WALLET_VALUE_USD) {
                // [Risk Check] Ensure at least 10% is in ETH/Stables (Not full degen)
                if (safeAssets / totalNetWorth < 0.1) return;

                richList.push({
                    address: wallet,
                    netWorth: totalNetWorth,
                    holdings: holdingDetails.join(", "),
                    isWhale: totalNetWorth > 10000
                });
            }

        } catch (e) {
            console.error(`Error checking ${wallet}:`, (e as any).message);
        }
    }

    // 4. 排序并输出
    richList.sort((a, b) => b.netWorth - a.netWorth);

    console.log(`\n\n================ 🏆 REAL WHALES FOUND (${richList.length}) 🏆 ================`);
    console.log(`(Filtered out wallets < $${MIN_WALLET_VALUE_USD})`);
    
    const exportLines: string[] = [];
    richList.forEach(w => {
        const icon = w.netWorth > 10000 ? "🐋" : "🐟";
        const line = `${icon} [${w.address}] Worth: $${w.netWorth.toFixed(0)} | Holds: ${w.holdings || "Mostly ETH"}`;
        console.log(line);
        exportLines.push(w.address);
    });

    console.log(`\n👉 Copy verified wallets for tracking:`);
    console.log(exportLines.join(","));

    // 保存到文件供 pipeline 使用
    fs.writeFileSync("verified_wallets.json", JSON.stringify(exportLines, null, 2));
    console.log(`\n✅ Saved ${exportLines.length} verified wallets to verified_wallets.json for pipeline.`);
}

// Helper: Get Prices from DexScreener (Free, no key needed)
async function getTokenPrices(addresses: string[]) {
    const priceMap: Record<string, number> = {};
    const chunks = [];
    const size = 30;
    for (let i = 0; i < addresses.length; i += size) {
        chunks.push(addresses.slice(i, i + size));
    }

    for (const chunk of chunks) {
        try {
            const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`;
            const res = await axios.get(url);
            if (res.data.pairs) {
                res.data.pairs.forEach((p: any) => {
                    if (p.chainId === "base" && p.baseToken && p.priceUsd) {
                        priceMap[p.baseToken.address.toLowerCase()] = parseFloat(p.priceUsd);
                    }
                });
            }
        } catch (e) {
            console.error("Price fetch error (ignoring)");
        }
    }
    return priceMap;
}

async function loadCandidates(): Promise<string[]> {
    const files = fs.readdirSync('.');
    const legendFiles = files.filter(f => f.startsWith('legends_base_') && f.endsWith('.txt'));
    if (legendFiles.length === 0) return [];
    legendFiles.sort().reverse();
    const targetFile = legendFiles[0];
    console.log(`[System] Reading candidates from ${targetFile}`);
    const content = fs.readFileSync(targetFile, 'utf-8');
    const wallets: string[] = [];
    const lines = content.split('\n');
    for (const line of lines) {
        const match = line.match(/0x[a-fA-F0-9]{40}/);
        if (match) wallets.push(match[0]);
    }
    return wallets;
}

main();