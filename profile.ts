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
    { name: "KEYCAT", address: "0x9a26F5433671751C3276a065f57e5a02D281797d", fallbackTime: 1711060000 }, // Mar 2024
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

    // 3. 输出精英名单
    exportProfileData(walletHits);
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
            const basePairs = pairs.filter((p: any) => p.chainId === "base");
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
