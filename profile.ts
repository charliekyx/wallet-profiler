console.log("[System] Script loading..."); // 确认脚本开始执行

import { ethers } from "ethers";
import axios from "axios";
import * as fs from "fs";

// ================= [Configuration V3: Deep Dive] =================

// 建议使用 Alchemy/Infura 等支持 Archive 模式的节点以查询历史数据
const RPC_URL = "https://base-mainnet.g.alchemy.com/v2/Dy8qDdgHXfCqzP-o1Bw2X";

const CONFIG = {
    // 1. 命中门槛：先降为 1，确保至少能看到数据，不要上来就要求重合
    MIN_HIT_COUNT: 1, 

    // 2. 狙击窗口：900 块 (30分钟) 是合理的
    SNIPE_WINDOW_BLOCKS: 900,

    // 3. 回溯缓冲：加大一点，防止因为区块时间偏差漏掉开盘
    LOOKBACK_BUFFER_BLOCKS: 3000, 

    // 4. 清洗逻辑 (放宽！)
    FILTER_MAX_TOTAL_NONCE: 5000, 
    
    // [关键修改]：检查过去 7 天的活跃度，而不是 3 天
    FILTER_RECENT_DAYS: 7,        
    
    // [关键修改]：暂时允许不活跃 (0)，因为我们要找的是持有者，不一定是高频交易员
    FILTER_MIN_WEEKLY_TXS: 0,     
    
    FILTER_MAX_WEEKLY_TXS: 200,    
    
    // [重要修复]：对于热门代币（Golden Dogs），1000 区块内的交易量极易超过 Alchemy 的 10k 条日志限制。
    // 导致 RPC 返回 400 错误。将分片大小降低到 50 是最稳妥的选择。
    RPC_CHUNK_SIZE: 10,           
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
    console.log(`[System] Targets: (Loading from file or defaults...)`);

    // 使用 StaticJsonRpcProvider 替代 JsonRpcProvider。
    // 这可以避免 ethers 频繁调用 eth_chainId 导致的 "could not detect network" 错误，特别是在使用 Alchemy 等稳定节点时。
    const provider = new ethers.providers.StaticJsonRpcProvider(RPC_URL);
    let currentBlock = 0;
    try {
        currentBlock = await provider.getBlockNumber();
        console.log(`[System] Connected. Current Block: ${currentBlock}`);
    } catch (e) {
        console.error(`[Fatal] Node connection failed.`);
        process.exit(1);
    }

    const walletHits: Record<string, string[]> = {};

    // 尝试读取 trending_dogs.json
    let targets: any[] = [];
    try {
        // [新增] 优先读取手动配置文件 (trending_dogs_manual.json)，防止被 pipeline 脚本的自动抓取覆盖
        const manualFile = "trending_dogs_manual.json";
        const autoFile = "trending_dogs.json";
        const targetFile = fs.existsSync(manualFile) ? manualFile : autoFile;

        if (fs.existsSync(targetFile)) {
            if (targetFile === manualFile) console.log(`[System] 🛡️ Using manual config: ${manualFile}`);
            const data = fs.readFileSync(targetFile, "utf-8");
            targets = JSON.parse(data);
            if (targets.length === 0) {
                console.log(`[System] ⚠️ trending_dogs.json is empty. No fresh dogs found.`);
                console.log(`[System] Exiting pipeline to save time (as requested).`);
                process.exit(0);
            } else {
                console.log(`[System] Loaded ${targets.length} trending dogs from file.`);
            }
        } else {
            console.log(`[System] trending_dogs.json not found. Exiting.`);
            process.exit(0);
        }
    } catch (e) {
        console.error(`[System] Error reading trending_dogs.json: ${(e as any).message}`);
        process.exit(1);
    }

    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        process.stdout.write(`\n[${i + 1}/${targets.length}] 🕵️  Analyzing ${target.name}... `);

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

    const logs = await getLogsInChunks(provider, searchStart, searchEnd, address, TRANSFER_TOPIC);

    if (logs.length === 0) return buyers;

    // 3. 找到真正的“第一枪” (First Transfer)
    const firstSwapBlock = logs[0].blockNumber;
    
    // [优化] 跳过前 3 个区块 (避开 Bundle Bot 和 狙击手)
    // 我们想找的是“聪明钱”或“早期跟随者”，而不是那种拼 Gas 的科学家
    const safeEntryBlock = firstSwapBlock + 3; 

    // 4. 锁定狙击窗口
    const snipeWindowEnd = firstSwapBlock + CONFIG.SNIPE_WINDOW_BLOCKS;
    
    // [优化] 过滤掉太早的日志
    const earlyLogs = logs.filter((l) => l.blockNumber >= safeEntryBlock && l.blockNumber <= snipeWindowEnd);

    const INFRA_BLACKLIST = new Set([
        "0x2948acbbc8795267e62a1220683a48e718b52585", // BaseSwap
        "0x8c1a3cf8f83074169fe5d7ad50b978e1cd6b37c7", // AlienBase
        "0x2626664c2603336e57b271c5c0b26f421741e481", // UniV3 Router
        "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a", // UniV3 Quoter
        "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad58", // UniV2
        "0x1111111254fb6c44bac0bed2854e76f90643097d", // 1inch
        "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad", // Universal Router 1
        "0x743f2f29cdd66242fb27d292ab2cc92f45674635", // Universal Router 2 (Clanker)
        "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43", // Aerodrome V2
        "0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5", // Aerodrome V3 (Slipstream)
        "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b", // Virtuals Token (Hop)
        "0xc479b79e53c1065e5e56a6da78e9d634b4ae1e5d", // Virtuals Factory
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
        
        // 避免请求过快触发 Alchemy 的频率限制 (Compute Units per second)
        await new Promise(resolve => setTimeout(resolve, 100));

        if (block.timestamp < targetTimestamp) {
            min = mid + 1;
        } else {
            closestBlock = mid;
            max = mid - 1;
        }
    }
    return closestBlock;
}

// --- Helper: Get Logs in Chunks (Fix for RPC Limits) ---
async function getLogsInChunks(
    provider: ethers.providers.JsonRpcProvider,
    fromBlock: number,
    toBlock: number,
    address: string,
    topic: string
): Promise<ethers.providers.Log[]> {
    const allLogs: ethers.providers.Log[] = [];
    let start = fromBlock;
    
    // Alchemy Free Tier limit is strict (10 blocks). 
    // If using other RPCs, you can increase CONFIG.RPC_CHUNK_SIZE to 2000.
    const chunkSize = CONFIG.RPC_CHUNK_SIZE; 

    while (start <= toBlock) {
        const end = Math.min(start + chunkSize - 1, toBlock);
        let retries = 3;
        while (retries > 0) {
            try {
                const logs = await provider.getLogs({
                    address: address,
                    topics: [topic],
                    fromBlock: start,
                    toBlock: end,
                });
                allLogs.push(...logs);
                break; // 成功则跳出重试循环
            } catch (e) {
                retries--;
                if (retries === 0) {
                    console.log(`   ⚠️ Chunk failed [${start}-${end}] after 3 attempts: ${(e as any).message.slice(0, 50)}...`);
                } else {
                    // 遇到错误（如频率限制）时等待 1 秒后重试
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }
        start += chunkSize;
    }
    return allLogs;
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
        let delta = -1;
        try {
            const noncePast = await provider.getTransactionCount(address, pastBlock);
            delta = nonceNow - noncePast;
        } catch (e) {
            // [Strict Mode] 如果节点不支持历史查询，直接视为失败，防止僵尸号混入
            return { pass: false, reason: "RPC Error (History Missing - Use Archive Node)" };
        }

        // 只有在成功获取到 delta 时才进行活跃度检查
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
