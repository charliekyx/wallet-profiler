import { Network, Alchemy, AssetTransfersCategory, SortingOrder } from "alchemy-sdk";
import * as fs from "fs";
import { ethers } from "ethers";

// ================= 配置区域 =================
const ALCHEMY_API_KEY = "Dy8qDdgHXfCqzP-o1Bw2X"; // 你的 Alchemy Key
const CHECK_DAYS = 7; // 只看最近 7 天的操作
// ===========================================

const settings = {
    apiKey: ALCHEMY_API_KEY,
    network: Network.BASE_MAINNET,
};
const alchemy = new Alchemy(settings);

// Base 常见 DEX 路由地址 (用于识别 Swap 行为)
const DEX_ROUTERS = new Set([
    "0x2626664c2603336e57b271c5c0b26f421741e481", // Uniswap V3
    "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad58", // Uniswap V2
    "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43", // Aerodrome Universal
    "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad", // Universal Router
    "0x1111111254fb6c44bac0bed2854e76f90643097d", // 1inch
    "0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5", // Aerodrome Slipstream (V3)

    // [新增] 对应 Rust 策略中的其他 DEX
    "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86", // BaseSwap V2
    "0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7", // AlienBase V2
    "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891", // SushiSwap V2
    "0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86", // PancakeSwap V3 Router
    "0x04C9f17463a2E8eD375772F412171b963d984531", // SwapBased V2
    "0x4cf76043B3f97ba06917cBd90F9e3A2AFcdb1B78", // RocketSwap V2

    // [Rust Sync] 同步 Rust constants.rs 中的地址
    "0x2948acbbc8795267e62a1220683a48e718b52585", // BaseSwap (Rust)
    "0x1b81D678ffb9C0263b24A97847620C99d213eB14", // PancakeSwap V3 (Rust)
    "0xaaa3b1F1bd7BCc97fD1917c18ade665C5D31F066", // SwapBased (Rust)
    "0x4cf76043B3f97ba06917cBd90F9e3A2AFcd1aCd0", // RocketSwap (Rust)
    "0x743f2f29cdd66242fb27d292ab2cc92f45674635", // Universal Router (Rust)
    "0x8d0d118070b728e104294471fbe93c2e3affd694", // Odos Router
    "0x663dc15d3c1ac63ff12e45ab68fea3f0a883c251", // deBridge
    "0xc479b79e53c1065e5e56a6da78e9d634b4ae1e5d", // Virtuals Protocol (Factory/Router)
    "0x498581fF718922c3f8e6A244956aF099B2652b2b", // Uniswap V4 Pool Manager
]);

async function main() {
    console.log("🚀 Starting Active Trader Filter...");

    // 1. 尝试读取 verified_wallets.json
    let candidates: string[] = [];
    try {
        if (fs.existsSync("verified_wallets.json")) {
            const data = fs.readFileSync("verified_wallets.json", "utf-8");
            candidates = JSON.parse(data);
            console.log(`[System] Loaded ${candidates.length} verified wallets from file.`);
        } else {
            // Fallback to manual input if file missing
            const rawInput = "0xf1c429b0ce94ef9893ef110d2cc100201dce71c8"; // 示例
            candidates = rawInput.split(/[\n,]/).map(s => s.trim().toLowerCase()).filter(s => s.startsWith("0x"));
            console.log(`[System] Using manual input.`);
        }
    } catch (e) {
        console.log(`[System] Error reading file, using empty list.`);
    }

    console.log(`📋 Analyzing activity for ${candidates.length} whales...`);

    // 计算区块范围 (Base 2秒一个块)
    const currentBlock = await alchemy.core.getBlockNumber();
    const blocksPerDay = 43200;
    const fromBlock = "0x" + (currentBlock - (blocksPerDay * CHECK_DAYS)).toString(16);

    const activeHunters = [];
    const sleepingWhales = [];

    for (let i = 0; i < candidates.length; i++) {
        const wallet = candidates[i];
        process.stdout.write(`\r   Scanning ${i+1}/${candidates.length}: ${wallet.slice(0,6)}...`);

        // 查询该钱包发出的交易 (External + ERC20)
        const resp = await alchemy.core.getAssetTransfers({
            fromBlock: fromBlock,
            fromAddress: wallet,
            category: [AssetTransfersCategory.EXTERNAL, AssetTransfersCategory.ERC20],
            excludeZeroValue: true,
            order: SortingOrder.DESCENDING, // 最新的在前
            maxCount: 20 // 只看最近 20 笔，足够判断了
        });

        const txs = resp.transfers;
        
        if (txs.length === 0) {
            sleepingWhales.push({ address: wallet, reason: "No Tx in 7 days" });
            continue;
        }

        let isHunter = false;
        let lastAction = "";

        // 分析交易行为
        for (const tx of txs) {
            const to = (tx.to || "").toLowerCase();
            
            // 行为 1: 给 DEX Router 发 ETH 或 Token -> 这是一个 Swap 信号
            if (DEX_ROUTERS.has(to)) {
                isHunter = true;
                lastAction = `Swapped on DEX (${tx.asset})`;
                break;
            }
            
            // 行为 2: 转出 USDT/USDC/ETH 到普通合约 (可能是买土狗)
            if (["USDC", "USDT", "ETH", "WETH"].includes(tx.asset || "") && !DEX_ROUTERS.has(to)) {
                // 这里可以进一步调 API 查 to 是不是 Token 合约，为了速度暂且放宽
                isHunter = true; 
                lastAction = `Sent ${tx.asset} (Potential Buy)`;
                break;
            }
        }

        if (isHunter) {
            activeHunters.push({ address: wallet, action: lastAction });
        } else {
            sleepingWhales.push({ address: wallet, reason: "Only passive transfers / No buys" });
        }
    }

    console.log(`\n\n================ 🎯 TARGET LIST (COPY THESE!) ================`);
    if (activeHunters.length === 0) {
        console.log("⚠️ No active hunters found in last 7 days.");
    } else {
        activeHunters.forEach(h => {
            console.log(`🟢 [ACTIVE] ${h.address} | Last: ${h.action}`);
        });
        console.log(`\n👉 Export for Bot:`);
        console.log(activeHunters.map(h => h.address).join(","));
    }

    console.log(`\n================ 💤 SLEEPING WATCHLIST (SET ALERTS) ================`);
    console.log(`(Do NOT copy trade yet, wait for them to wake up)`);
    sleepingWhales.forEach(w => {
        console.log(`🟡 ${w.address}`);
    });
}

main();