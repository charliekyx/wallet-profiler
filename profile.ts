console.log("[System] Script loading..."); // 确认脚本开始执行

import { ethers } from "ethers";
import axios from "axios";
import * as fs from "fs";

// ================= [Configuration V3: Deep Dive] =================

const RPC_URL = "http://127.0.0.1:8545";

// 🎯 Base 链历史级金狗 (人工精选)
// 这些是已经百倍千倍的币，能抓到它们的早期买家才是真神
const GOLDEN_DOGS = [
    { name: "BRETT", address: "0x532f27101965dd16442e59d40670faf5ebb142e4", fallbackTime: 1708820000 }, // Feb 2024
    { name: "DEGEN", address: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed", fallbackTime: 1704670000 }, // Jan 2024
    { name: "TOSHI", address: "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4", fallbackTime: 1691530000 }, // Aug 2023
    { name: "VIRTUAL", address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", fallbackTime: 1727740000 }, // Oct 2024
    { name: "KEYCAT", address: "0x9a26f5433671751c3276a065f57e5a02d281797d", fallbackTime: 1711060000 }, // Mar 2024 (Fixed Checksum)
];

const CONFIG = {
    // 寻找多少个共同点？
    // 如果一个钱包命中了 2 个以上历史金狗，绝对是顶级高手
    MIN_HIT_COUNT: 2,

    // 狙击窗口：开盘后 900 个块 (约 30 分钟)
    // 对于老币，放宽一点，因为早期流动性可能还没加满
    SNIPE_WINDOW_BLOCKS: 900,

    // 回溯缓冲：因为使用了精准的 Binary Search，这里只需要很小的缓冲 (约 5 分钟)
    LOOKBACK_BUFFER_BLOCKS: 150,

    // [New] 自动清洗配置 (Bot/死号过滤)
    FILTER_MAX_TOTAL_NONCE: 5000, // 历史总交易过高 -> Bot
    FILTER_RECENT_DAYS: 7,        // 检查最近 7 天
    FILTER_MIN_WEEKLY_TXS: 1,     // 7天内至少 1 笔交易 -> 排除死号
    FILTER_MAX_WEEKLY_TXS: 500,   // 放宽阈值：7天内超过 500 笔才算 Bot (平均每天 ~70 笔)
};

// ================= [Core Logic] =================

// Standard Transfer Event Topic (ERC20)
let TRANSFER_TOPIC = "";
const LOG_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
];

async function main() {
    // 检查 ethers 是否加载成功
    if (!ethers || !ethers.utils) {
        console.error(
            "[Fatal] ethers 库加载失败。请确保安装了 ethers v5 (npm install ethers@5.7.2) 且 tsconfig.json 配置了 esModuleInterop: true"
        );
        process.exit(1);
    }

    try {
        TRANSFER_TOPIC = ethers.utils.id("Transfer(address,address,uint256)");
    } catch (e) {
        console.error(
            "[启动错误] ethers 初始化失败。你的 node_modules 可能安装了 ethers v6，但代码需要 v5。",
            e
        );
        process.exit(1);
    }

    console.log(`\n[System] 🚀 Wallet Profiler V3 (Golden Dog Edition)`);
    console.log(`[System] Node Connection: ${RPC_URL}`);
    console.log(`[System] Targets: ${GOLDEN_DOGS.map((t) => t.name).join(", ")}`);

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    let currentBlock = 0;
    try {
        currentBlock = await provider.getBlockNumber();
        console.log(`[System] Connected. Current Block: ${currentBlock}`);
    } catch (e) {
        console.error(`[Fatal] Node connection failed.`);
        process.exit(1);
    }

    const walletHits: Record<string, string[]> = {};

    for (let i = 0; i < GOLDEN_DOGS.length; i++) {
        const target = GOLDEN_DOGS[i];
        process.stdout.write(`\n[${i + 1}/${GOLDEN_DOGS.length}] 🕵️  Analyzing ${target.name}... `);

        try {
            // 1. 获取代币创建时间 (为了计算区块高度)
            const createdAt = await getCreationTime(target.address, target.fallbackTime);
            if (!createdAt) {
                console.log(`❌ Failed to get creation time.`);
                continue;
            }

            // 2. 扫描早期买家
            const earlyBuyers = await traceEarlyBuyers(
                provider,
                target.address,
                createdAt,
                currentBlock
            );

            if (earlyBuyers.size > 0) {
                console.log(`✅ Captured ${earlyBuyers.size} snipers.`);
            } else {
                console.log(`⚠️ No entries found. (Check range)`);
            }

            for (const buyer of earlyBuyers) {
                if (!walletHits[buyer]) walletHits[buyer] = [];
                walletHits[buyer].push(target.name);
            }
        } catch (e) {
            console.log(`❌ Error: ${(e as any).message}`);
        }
    }

    // 3. 自动清洗 (去除 Bot 和 死号)
    const cleanedHits = await filterWallets(provider, walletHits);
    exportProfileData(cleanedHits);
}

// --- Helper: Get Token Age ---
async function getCreationTime(address: string, fallback?: number): Promise<number | null> {
    try {
        // 利用 DexScreener 查 pair 信息，间接获取创建时间
        const url = `https://api.dexscreener.com/latest/dex/tokens/${address}`;
        // 添加 User-Agent 防止 403 Forbidden
        const res = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 5000 });
        const pairs = res.data.pairs;

        if (pairs && pairs.length > 0) {
            // 找到 Base 链上最早的 pair
            // 增加 p.pairCreatedAt 检查，防止 API 返回空时间导致 fallback 失效
            const basePairs = pairs.filter((p: any) => p.chainId === "base" && p.pairCreatedAt);
            if (basePairs.length > 0) {
                // 按创建时间排序 (如果有这个字段) - DexScreener API 有时返回 pairCreatedAt
                basePairs.sort((a: any, b: any) => a.pairCreatedAt - b.pairCreatedAt);
                return basePairs[0].pairCreatedAt;
            }
        }
        // API 请求成功但没找到数据，也使用 Fallback
        if (fallback) return fallback * 1000;
        return null;
    } catch (e) {
        if (fallback) return fallback * 1000; // Fallback to hardcoded time (ms)
        return null;
    }
}

// --- Module: Time Travel & Trace ---
async function traceEarlyBuyers(
    provider: ethers.providers.JsonRpcProvider,
    address: string,
    createdAtTimestamp: number,
    currentBlock: number
): Promise<Set<string>> {
    const buyers = new Set<string>();

    // 1. 精准定位区块 (Binary Search)
    // 使用二分查找在链上找到对应时间戳的准确区块，解决估算偏差问题
    const targetTimestampSec = Math.floor(createdAtTimestamp / 1000);
    const startBlock = await getBlockByTimestamp(provider, targetTimestampSec, currentBlock);

    // 2. 设定搜索范围
    // 既然定位精准，只需要往前一点点作为 buffer
    const searchStart = Math.max(0, startBlock - CONFIG.LOOKBACK_BUFFER_BLOCKS);
    // 搜索结束 = 开始 + 狙击窗口
    const searchEnd = startBlock + CONFIG.SNIPE_WINDOW_BLOCKS;

    const logs = await provider.getLogs({
        address: address,
        topics: [TRANSFER_TOPIC],
        fromBlock: searchStart,
        toBlock: searchEnd,
    });

    if (logs.length === 0) return buyers;

    // 3. 找到真正的“第一枪” (First Transfer)
    const firstSwapBlock = logs[0].blockNumber;

    // 4. 锁定狙击窗口
    const snipeWindowEnd = firstSwapBlock + CONFIG.SNIPE_WINDOW_BLOCKS;
    const earlyLogs = logs.filter((l) => l.blockNumber <= snipeWindowEnd);

    const INFRA_BLACKLIST = new Set([
        "0x2948acbbc8795267e62a1220683a48e718b52585", // BaseSwap
        "0x8c1a3cf8f83074169fe5d7ad50b978e1cd6b37c7", // AlienBase
        "0x2626664c2603336e57b271c5c0b26f421741e481", // UniV3
        "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad58", // UniV2
        "0x1111111254fb6c44bac0bed2854e76f90643097d", // 1inch
        "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad", // Universal Router
        "0x0000000000000000000000000000000000000000", // Null
    ]);

    const iface = new ethers.utils.Interface(LOG_ABI);

    for (const log of earlyLogs) {
        try {
            const parsed = iface.parseLog(log);
            if (!parsed) continue;
            const to = parsed.args.to.toLowerCase();
            
            // 简单的过滤：排除基础设施、代币合约自己、零地址
            if (!INFRA_BLACKLIST.has(to) && to !== address.toLowerCase()) {
                buyers.add(to);
            }
        } catch (e) {}
    }

    return buyers;
}

// --- Helper: Binary Search Block by Timestamp ---
async function getBlockByTimestamp(
    provider: ethers.providers.JsonRpcProvider, 
    targetTimestamp: number, 
    maxBlock: number
): Promise<number> {
    let min = 0;
    let max = maxBlock;
    let closestBlock = max;

    while (min <= max) {
        const mid = Math.floor((min + max) / 2);
        const block = await provider.getBlock(mid);
        if (block.timestamp < targetTimestamp) {
            min = mid + 1;
        } else {
            closestBlock = mid;
            max = mid - 1;
        }
    }
    return closestBlock;
}

// --- Module: Auto Filter (Integrated) ---
async function filterWallets(
    provider: ethers.providers.JsonRpcProvider,
    hits: Record<string, string[]>
): Promise<Record<string, string[]>> {
    const candidates = Object.keys(hits);
    const validHits: Record<string, string[]> = {};
    
    console.log(`\n[Filter] Auditing ${candidates.length} candidates...`);
    
    const currentBlock = await provider.getBlockNumber();
    const blocksPerDay = 43200; 
    const pastBlock = currentBlock - (blocksPerDay * CONFIG.FILTER_RECENT_DAYS);

    const stats = {
        pass: 0,
        contract: 0,
        highNonce: 0,
        lowNonce: 0,
        inactive: 0,
        highFreq: 0,
        rpcError: 0
    };

    for (let i = 0; i < candidates.length; i++) {
        const wallet = candidates[i];
        if (i % 10 === 0) process.stdout.write(`.`);
        
        const result = await auditWallet(provider, wallet, pastBlock, currentBlock);
        
        if (result.pass) {
            validHits[wallet] = hits[wallet];
            stats.pass++;
        } else {
            if (result.reason.includes("Contract")) stats.contract++;
            else if (result.reason.includes("Total Nonce High")) stats.highNonce++;
            else if (result.reason.includes("Total Nonce Low")) stats.lowNonce++;
            else if (result.reason.includes("Inactive")) stats.inactive++;
            else if (result.reason.includes("High Freq")) stats.highFreq++;
            else if (result.reason.includes("RPC Error")) stats.rpcError++;
        }
    }
    
    console.log(`\n\n[Filter Stats]`);
    console.log(`✅ Passed: ${stats.pass}`);
    console.log(`❌ Contract: ${stats.contract}`);
    console.log(`❌ Bot (High Nonce): ${stats.highNonce}`);
    console.log(`❌ New/Burner (Low Nonce): ${stats.lowNonce}`);
    console.log(`❌ Inactive (<${CONFIG.FILTER_MIN_WEEKLY_TXS} txs): ${stats.inactive}`);
    console.log(`❌ High Freq (>${CONFIG.FILTER_MAX_WEEKLY_TXS} txs): ${stats.highFreq}`);
    console.log(`⚠️ RPC Errors: ${stats.rpcError}`);

    if (stats.rpcError > 0) {
        console.log(`\n[Warning] High RPC errors detected. Your node might not support historical lookups (${CONFIG.FILTER_RECENT_DAYS} days ago).`);
        console.log(`Try reducing FILTER_RECENT_DAYS or using an Archive Node.`);
    }

    return validHits;
}

async function auditWallet(
    provider: ethers.providers.JsonRpcProvider, 
    address: string, 
    pastBlock: number, 
    currentBlock: number
): Promise<{ pass: boolean; reason: string }> {
    try {
        const code = await provider.getCode(address);
        if (code !== '0x') return { pass: false, reason: "Contract" };

        const nonceNow = await provider.getTransactionCount(address, currentBlock);
        if (nonceNow > CONFIG.FILTER_MAX_TOTAL_NONCE) return { pass: false, reason: "Total Nonce High" };
        if (nonceNow < 2) return { pass: false, reason: "Total Nonce Low" };

        // Try historical lookup
        let noncePast = 0;
        try {
            noncePast = await provider.getTransactionCount(address, pastBlock);
        } catch (e) {
            return { pass: false, reason: "RPC Error (History)" };
        }

        const delta = nonceNow - noncePast;
        
        if (delta < CONFIG.FILTER_MIN_WEEKLY_TXS) return { pass: false, reason: "Inactive" };
        if (delta > CONFIG.FILTER_MAX_WEEKLY_TXS) return { pass: false, reason: "High Freq" };

        return { pass: true, reason: "OK" };
    } catch (e) {
        return { pass: false, reason: "RPC Error (General)" };
    }
}

// --- Module: Reporting ---
function exportProfileData(walletHits: Record<string, string[]>) {
    console.log(`\n================ 🏆 LEGENDARY SNIPERS FOUND 🏆 ================`);

    const sorted = Object.entries(walletHits)
        .filter(([_, hits]) => hits.length >= CONFIG.MIN_HIT_COUNT)
        .sort((a, b) => b[1].length - a[1].length);

    if (sorted.length === 0) {
        console.log(`\n⚠️ No wallet hit >= ${CONFIG.MIN_HIT_COUNT} of these legends.`);
        console.log("Try checking wallets with 1 hit manually.");

        // Backup: Show 2 hits
        const backup = Object.entries(walletHits)
            .filter(([_, hits]) => hits.length >= 1)
            .sort((a, b) => b[1].length - a[1].length)
            .slice(0, 10);
        if (backup.length > 0) {
            console.log("\n[Info] Top active wallets (1 hit):");
            backup.forEach(([w, h]) => console.log(`   ${w} -> [${h.join(", ")}]`));
        }
    } else {
        const lines = [];
        const wallets = [];

        for (const [wallet, hits] of sorted) {
            const line = `[💎 ${hits.length} Legends] ${wallet} | Bags: ${hits.join(", ")}`;
            console.log(line);
            lines.push(line);
            wallets.push(wallet);
        }

        const dateStr = new Date().toISOString().slice(0, 10);
        const fileName = `legends_base_${dateStr}.txt`;
        fs.writeFileSync(fileName, lines.join("\n"));
        console.log(`\n✅ Saved to ${fileName}`);
        console.log(`👉 Copy these to .env TARGET_WALLETS:\n`);
        console.log(wallets.join(","));
    }
}

main().catch(console.error);
