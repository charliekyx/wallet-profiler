console.log("[System] Script loading..."); // 确认脚本开始执行

import { ethers } from 'ethers';
import axios from 'axios';
import * as fs from 'fs';

// ================= [Configuration] =================

// 你的 OVH 节点地址 (HTTP)
const RPC_URL = 'http://127.0.0.1:8545';
// const RPC_URL = "https://mainnet.base.org"

// 筛选配置
const CONFIG = {
    // 最小流动性阈值 (USD) - 过滤纯垃圾盘
    MIN_LIQUIDITY_USD: 5_000, 
    
    // 数据回溯窗口 (天) - 只分析最近 30 天诞生的资产
    MAX_AGE_DAYS: 30, 
    
    // 扩大搜索范围：防止因为时间戳偏差导致找不到开盘点 (Base ~2s/block)
    LOOKBACK_BUFFER_BLOCKS: 3000,

    // "早期"定义: 开盘后多少个区块内买入? (Base ~2s/Block, 150 blocks ≈ 5 mins)
    SNIPE_WINDOW_BLOCKS: 150, 
    
    // 信号阈值: 至少命中多少个金狗才被标记为 Smart Wallet?
    MIN_HIT_COUNT: 2, 
};

// Data Providers (Free Tier)
const API_ENDPOINTS = {
    GECKO_TRENDING: 'https://api.geckoterminal.com/api/v2/networks/base/trending_pools',
    DEXSCREENER_SEARCH: 'https://api.dexscreener.com/latest/dex/search?q=WETH%20Base'
};

// ================= [Core Logic] =================

// Standard Swap Event Topic (Uniswap V2/V3 compatible)
let SWAP_TOPIC = "";
const LOG_ABI = ["event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)"];

interface AssetProfile {
    address: string;
    symbol: string;
    createdAtTimestamp: number; // ms
    dataSource: 'Gecko' | 'DexScr';
}

async function main() {
    // 检查 ethers 是否加载成功
    if (!ethers || !ethers.utils) {
        console.error("[Fatal] ethers 库加载失败。请确保安装了 ethers v5 (npm install ethers@5.7.2) 且 tsconfig.json 配置了 esModuleInterop: true");
        process.exit(1);
    }

    try {
        SWAP_TOPIC = ethers.utils.id("Swap(address,uint256,uint256,uint256,uint256,address)");
    } catch (e) {
        console.error("[启动错误] ethers 初始化失败。你的 node_modules 可能安装了 ethers v6，但代码需要 v5。", e);
        process.exit(1);
    }

    console.log(`\n[System] Initializing Wallet Profiler (Target: Base Chain)...`);
    console.log(`[System] Node Connection: ${RPC_URL}`);
    
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    let currentBlock = 0;
    try {
        currentBlock = await provider.getBlockNumber();
        console.log(`[System] Connection Established. Current Block: ${currentBlock}`);
    } catch (e) {
        console.error(`[Fatal] Node connection failed. Check RPC_URL in .env.`);
        process.exit(1);
    }

    // 1. Data Aggregation
    const assets = await fetchHighPerformanceAssets();
    console.log(`\n[Profiler] Identified ${assets.length} high-performance assets for analysis.`);

    // 2. On-Chain Trace
    const walletHits: Record<string, string[]> = {}; 

    for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        process.stdout.write(`\n[${i + 1}/${assets.length}] Profiling ${asset.symbol} (${asset.dataSource})... `);
        
        try {
            // 严格校验地址格式，防止崩溃
            if (!ethers.utils.isAddress(asset.address)) {
                console.log(`Skipped (Invalid Address Format)`);
                continue;
            }

            const earlyBuyers = await traceEarlyBuyers(provider, asset, currentBlock);
            console.log(`Captured ${earlyBuyers.size} early entires.`);

            for (const buyer of earlyBuyers) {
                if (!walletHits[buyer]) walletHits[buyer] = [];
                walletHits[buyer].push(asset.symbol);
            }
        } catch (e) {
            console.log(`Failed: ${(e as any).message.slice(0, 50)}`);
        }
    }

    // 3. Export Results
    exportProfileData(walletHits);
}

// --- Module: Data Fetcher ---
async function fetchHighPerformanceAssets(): Promise<AssetProfile[]> {
    const assetMap = new Map<string, AssetProfile>();
    const now = Date.now();

    // Source A: GeckoTerminal (Market Sentiment)
    try {
        console.log(`\n[Fetcher] Querying GeckoTerminal Trending...`);
        const res = await axios.get(API_ENDPOINTS.GECKO_TRENDING);
        const data = res.data.data || [];
        
        for (const item of data) {
            const attr = item.attributes;
            const createdAt = new Date(attr.pool_created_at).getTime();
            const ageDays = (now - createdAt) / (1000 * 3600 * 24);
            
            if (ageDays <= CONFIG.MAX_AGE_DAYS && ageDays > 0) {
                const addr = attr.address?.toLowerCase();
                if (addr && addr.length === 42) {
                    assetMap.set(addr, {
                        address: addr,
                        symbol: attr.name,
                        createdAtTimestamp: createdAt,
                        dataSource: 'Gecko'
                    });
                }
            }
        }
        console.log(`   -> Retrieved ${assetMap.size} candidates.`);
    } catch (e) {
        console.error(`   -> GeckoTerminal Unavailable.`);
    }

    // Source B: DexScreener (Volume Verification)
    try {
        console.log(`[Fetcher] Querying DexScreener Top Pairs...`);
        const res = await axios.get(API_ENDPOINTS.DEXSCREENER_SEARCH);
        const pairs = res.data.pairs || [];
        let addedCount = 0;

        for (const p of pairs) {
            if (p.chainId !== 'base') continue;
            
            const createdAt = p.pairCreatedAt;
            if (!createdAt) continue;

            const ageDays = (now - createdAt) / (1000 * 3600 * 24);
            const addr = p.pairAddress?.toLowerCase();

            if (addr && addr.length === 42 && !assetMap.has(addr) && ageDays <= CONFIG.MAX_AGE_DAYS && p.liquidity?.usd >= CONFIG.MIN_LIQUIDITY_USD) {
                assetMap.set(addr, {
                    address: addr,
                    symbol: p.baseToken.symbol,
                    createdAtTimestamp: createdAt,
                    dataSource: 'DexScr'
                });
                addedCount++;
            }
        }
        console.log(`   -> Added ${addedCount} additional candidates.`);

    } catch (e) {
        console.error(`   -> DexScreener Unavailable.`);
    }

    return Array.from(assetMap.values());
}

// --- Module: Chain Tracer ---
async function traceEarlyBuyers(provider: ethers.providers.JsonRpcProvider, asset: AssetProfile, currentBlock: number): Promise<Set<string>> {
    const buyers = new Set<string>();
    
    // Block Estimation (Optimization: Avoid Binary Search for speed)
    // Use system time to save RPC call
    const nowSeconds = Math.floor(Date.now() / 1000);
    const createdSeconds = Math.floor(asset.createdAtTimestamp / 1000);
    const ageSeconds = nowSeconds - createdSeconds;
    
    // Base Block Time ~ 2s
    const blocksAgo = Math.floor(ageSeconds / 2);
    const estimatedStartBlock = currentBlock - blocksAgo;
    
    // Search Range: Estimated Start - LOOKBACK_BUFFER_BLOCKS -> + 2000 blocks
    const searchStart = Math.max(0, estimatedStartBlock - CONFIG.LOOKBACK_BUFFER_BLOCKS);
    const searchEnd = Math.min(currentBlock, estimatedStartBlock + 2000);

    const logs = await provider.getLogs({
        address: asset.address,
        topics: [SWAP_TOPIC],
        fromBlock: searchStart,
        toBlock: searchEnd
    });

    if (logs.length === 0) return buyers;

    // Pinpoint the exact "Open Block" (First Swap)
    const firstSwapBlock = logs[0].blockNumber;
    const snipeWindowEnd = firstSwapBlock + CONFIG.SNIPE_WINDOW_BLOCKS;
    
    // Filter: Only transactions within the Sniper Window
    const earlyLogs = logs.filter(l => l.blockNumber <= snipeWindowEnd);

    // Filter: Exclude Infrastructure Addresses
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
            // Heuristic: The 'to' address in a Swap event is usually the recipient (Buyer)
            const to = parsed.args.to.toLowerCase();
            
            if (!INFRA_BLACKLIST.has(to) && to !== asset.address) {
                buyers.add(to);
            }
        } catch (e) {}
    }

    return buyers;
}

// --- Module: Reporting ---
function exportProfileData(walletHits: Record<string, string[]>) {
    console.log(`\n================ [Result] Top Performing Wallets ================`);
    
    const sorted = Object.entries(walletHits)
        .filter(([_, hits]) => hits.length >= CONFIG.MIN_HIT_COUNT)
        .sort((a, b) => b[1].length - a[1].length);

    if (sorted.length === 0) {
        console.log(`No wallets met the MIN_HIT_COUNT (${CONFIG.MIN_HIT_COUNT}) threshold.`);
        
        // Backup: Show 2 hits
        const backup = Object.entries(walletHits)
            .filter(([_, hits]) => hits.length >= 1)
            .sort((a, b) => b[1].length - a[1].length)
            .slice(0, 10);
        if (backup.length > 0) {
             console.log("\n[Info] Displaying top active wallets (for reference):");
             backup.forEach(([w, h]) => console.log(`   ${w} -> [${h.join(', ')}]`));
        }

    } else {
        const lines = [];
        const wallets = [];
        
        for (const [wallet, hits] of sorted) {
            const line = `[Hits: ${hits.length}] Address: ${wallet} | Assets: ${hits.join(', ')}`;
            console.log(line);
            lines.push(line);
            wallets.push(wallet);
        }

        const dateStr = new Date().toISOString().slice(0, 10);
        const fileName = `wallet_profiles_${dateStr}.txt`;
        fs.writeFileSync(fileName, lines.join('\n'));
        
        console.log(`\n[Success] Profile data saved to: ${fileName}`);
        console.log(`[Action] Copy the list below to your .env 'TARGET_WALLETS':\n`);
        console.log(wallets.join(','));
    }
}

main().catch(console.error);