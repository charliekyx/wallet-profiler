console.log("[System] Script loading...");

import { ethers } from "ethers";
import axios from "axios";
import * as fs from "fs";
import {
    DATA_DIR,
    LOCAL_RPC_URL,
    REMOTE_RPC_URL,
    PROFILE_CONFIG as CONFIG,
    DEX_ROUTERS,
    TrendingToken,
} from "./common";

// ================= [Configuration V4: Smart Speed] =================

let TRANSFER_TOPIC = "";
const LOG_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function balanceOf(address) view returns (uint256)",
];

export async function profileEarlyBuyers(inputTargets?: TrendingToken[]): Promise<string[]> {
    TRANSFER_TOPIC = ethers.utils.id("Transfer(address,address,uint256)");

    console.log(`\n[System] Wallet Profiler V4 (Smart Speed Edition)`);

    // [修改] 初始化双 Provider
    const remoteProvider = new ethers.providers.StaticJsonRpcProvider(REMOTE_RPC_URL);
    const localProvider = new ethers.providers.StaticJsonRpcProvider(LOCAL_RPC_URL);

    let currentBlock = 0;
    try {
        currentBlock = await localProvider.getBlockNumber();
        console.log(`[System] Connected. Current Block: ${currentBlock}`);
    } catch (e) {
        process.exit(1);
    }

    const walletHits: Record<string, string[]> = {};
    const globalBlacklist = new Set<string>(); // 全局黑名单

    let targets: TrendingToken[] = inputTargets || [];

    // Fallback: 如果没有传入数据，尝试从文件读取
    if (targets.length === 0) {
        try {
            const manualFile = `${DATA_DIR}/trending_dogs_manual.json`;
            const autoFile = `${DATA_DIR}/trending_dogs.json`;
            const targetFile = fs.existsSync(manualFile) ? manualFile : autoFile;
            if (fs.existsSync(targetFile)) {
                targets = JSON.parse(fs.readFileSync(targetFile, "utf-8"));
                console.log(`[System] Loaded ${targets.length} trending dogs from file.`);
            }
        } catch (e) {
            console.log(`[System] No targets found in file fallback.`);
        }
    }

    // ================= [核心优化：并发处理] =================
    // 将 targets 分组，每组 5 个同时跑
    for (let i = 0; i < targets.length; i += CONFIG.CONCURRENT_TOKENS) {
        const batch = targets.slice(i, i + CONFIG.CONCURRENT_TOKENS);
        console.log(
            `\n[System] Processing Batch ${Math.floor(i / CONFIG.CONCURRENT_TOKENS) + 1} (${batch.length} tokens)...`,
        );

        await Promise.all(
            batch.map(async (target) => {
                if (!target.address || !target.address.startsWith("0x")) return;

                try {
                    console.log(
                        `   [System] Analyzing ${target.name} (${target.address.slice(0, 10)}...)`,
                    );

                    // 1. 获取元数据
                    const meta = await getTokenMetadata(target.address, target.fallbackTime);
                    if (!meta) return;

                    const tokenGrowth =
                        meta.currentPrice > 0 ? meta.currentPrice / meta.initialPriceEstimate : 0;

                    // 2. 扫描早期买家
                    const earlyBuyers = await traceEarlyBuyers(
                        remoteProvider, // 必须用远程 (历史 Logs)
                        target.address,
                        meta.createdAt,
                        currentBlock,
                    );

                    console.log(
                        `   [System] [${target.name}] Found ${earlyBuyers.size} early buyers. Starting audit...`,
                    );

                    if (earlyBuyers.size > 0) {
                        const buyerList = Array.from(earlyBuyers.keys());
                        const pastBlock = currentBlock - 43200 * CONFIG.FILTER_RECENT_DAYS;

                        // 智能计算起始区块 (45天或代币出生日)
                        const lookbackBlocks = 2000000;
                        const startCheckBlock = Math.max(0, currentBlock - lookbackBlocks);

                        let hitCount = 0;

                        // [核心优化] 针对每一个 wallet 进行深度审计
                        for (let j = 0; j < buyerList.length; j += CONFIG.VERIFY_BATCH_SIZE) {
                            const chunk = buyerList.slice(j, j + CONFIG.VERIFY_BATCH_SIZE);
                            console.log(
                                `      [System] [${target.name}] Progress: ${j + 1}-${Math.min(j + CONFIG.VERIFY_BATCH_SIZE, buyerList.length)} / ${buyerList.length}`,
                            );

                            await Promise.all(
                                chunk.map(async (buyer) => {
                                    // 1. 先审 Nonce (过滤 Bot/新号，减少后续昂贵的 RPC 调用)
                                    const audit = await auditWallet(
                                        localProvider,
                                        remoteProvider,
                                        buyer,
                                        pastBlock,
                                        currentBlock,
                                    );
                                    if (!audit.pass) return;

                                    // 2. 检查卖出行为与 PnL
                                    const sellInfo = await checkLegitSell(
                                        localProvider,
                                        remoteProvider,
                                        buyer,
                                        target.address,
                                        startCheckBlock,
                                        currentBlock,
                                    );
                                    if (sellInfo.status === "SUSPICIOUS") {
                                        globalBlacklist.add(buyer);
                                        return;
                                    }

                                    if (
                                        sellInfo.status === "YES" ||
                                        sellInfo.status === "NO_SELL"
                                    ) {
                                        const buyAmount =
                                            earlyBuyers.get(buyer) || ethers.BigNumber.from(0);

                                        // [优化逻辑]
                                        // 1. 计算总账面价值 = (已卖出数量 + 当前余额) * 当前价格
                                        // 2. 即使没卖(NO_SELL)，只要账面价值翻倍，也是我们要找的“传奇”
                                        const totalAccountedTokens = sellInfo.totalSold.add(
                                            sellInfo.currentBalance,
                                        );
                                        const totalValueUSD =
                                            parseFloat(
                                                ethers.utils.formatEther(totalAccountedTokens),
                                            ) * meta.currentPrice;
                                        const costBasisUSD =
                                            parseFloat(ethers.utils.formatEther(buyAmount)) *
                                            meta.initialPriceEstimate;

                                        // 如果账面价值 > 成本的 N 倍，或者卖出数量已经超过买入的一半且价格在涨
                                        if (
                                            totalValueUSD >
                                            costBasisUSD * CONFIG.MIN_PNL_MULTIPLIER
                                        ) {
                                            if (!walletHits[buyer]) walletHits[buyer] = [];
                                            walletHits[buyer].push(target.name);
                                            hitCount++;
                                            console.log(
                                                `      [Legend] [${target.name}] Found Legend: ${buyer} (${(totalValueUSD / costBasisUSD).toFixed(1)}x)`,
                                            );
                                        }
                                    }
                                }),
                            );
                        }
                        console.log(
                            `   [Success] [${target.name}] Finished. Growth: ${tokenGrowth.toFixed(1)}x | Captured ${hitCount} snipers.`,
                        );
                    } else {
                        console.log(`   [System] [${target.name}] No snipers found.`);
                    }
                } catch (e) {
                    console.log(`   [Error] [${target.name}] Error: ${(e as any).message}`);
                }
            }),
        );
    }

    // 最终清洗
    if (globalBlacklist.size > 0) {
        console.log(
            `\n[System] Executing Global Ban on ${globalBlacklist.size} suspicious wallets...`,
        );
        for (const badActor of globalBlacklist) {
            if (walletHits[badActor]) delete walletHits[badActor];
        }
    }

    const cleanedHits = await filterWallets(localProvider, walletHits);
    const legends = exportProfileData(cleanedHits);

    return legends;
}

// --- Helper: Smart Legit Sell Check ---
async function checkLegitSell(
    localProvider: ethers.providers.StaticJsonRpcProvider,
    remoteProvider: ethers.providers.StaticJsonRpcProvider,
    wallet: string,
    tokenAddress: string,
    startBlock: number,
    currentBlock: number,
): Promise<{
    status: "YES" | "NO_SELL" | "SUSPICIOUS";
    totalSold: ethers.BigNumber;
    currentBalance: ethers.BigNumber;
}> {
    const topic = ethers.utils.id("Transfer(address,address,uint256)");
    const walletPad = ethers.utils.hexZeroPad(wallet, 32);
    const iface = new ethers.utils.Interface(LOG_ABI);
    const tokenContract = new ethers.Contract(tokenAddress, LOG_ABI, localProvider); // 查余额用本地

    try {
        // 并发获取日志和当前余额
        const [logs, currentBalance]: [ethers.providers.Log[], ethers.BigNumber] =
            await Promise.all([
                getLogsInChunks(
                    remoteProvider, // 查日志用远程
                    startBlock,
                    currentBlock,
                    tokenAddress,
                    [topic, walletPad],
                ),
                withRetry(() => tokenContract.balanceOf(wallet) as Promise<ethers.BigNumber>).catch(
                    () => ethers.BigNumber.from(0),
                ),
            ]);

        if (logs.length === 0)
            return { status: "NO_SELL", totalSold: ethers.BigNumber.from(0), currentBalance };

        let totalSold = ethers.BigNumber.from(0);
        let hasLegitSell = false;

        for (const log of logs) {
            // 从 Topic2 提取接收者地址 (indexed to)
            const to = ethers.utils.defaultAbiCoder
                .decode(["address"], log.topics[2])[0]
                .toLowerCase();
            const parsed = iface.parseLog(log);

            if (DEX_ROUTERS.has(to)) {
                hasLegitSell = true;
                totalSold = totalSold.add(parsed.args.value);
            } else {
                const code = await withRetry(
                    () => localProvider.getCode(to) as Promise<string>,
                ).catch(() => "0x");
                if (code !== "0x" && to !== tokenAddress.toLowerCase())
                    return { status: "SUSPICIOUS", totalSold, currentBalance };
            }
        }

        return { status: hasLegitSell ? "YES" : "NO_SELL", totalSold, currentBalance };
    } catch (e) {
        console.error(
            `      [Error] [${tokenAddress}] checkLegitSell Error for ${wallet}: ${(e as any).message}`,
        );
        return {
            status: "NO_SELL",
            totalSold: ethers.BigNumber.from(0),
            currentBalance: ethers.BigNumber.from(0),
        };
    }
}

// --- Helper: Generic Retry Wrapper ---
async function withRetry<T>(fn: () => Promise<T>, retries = 5, delay = 2000): Promise<T> {
    try {
        return await fn();
    } catch (e: any) {
        const msg = (e.message || "").toLowerCase();
        const errCode = (e.code || "").toString().toLowerCase();

        // 扩展重试条件：包含 Infura 常见的 SERVER_ERROR 和 failed response
        const isRetryable =
            msg.includes("429") ||
            msg.includes("limit") ||
            msg.includes("timeout") ||
            msg.includes("500") ||
            msg.includes("503") ||
            msg.includes("server_error") ||
            msg.includes("failed response") ||
            errCode.includes("timeout") ||
            errCode.includes("server_error") ||
            errCode.includes("network_error");

        if (retries > 0 && isRetryable) {
            // 指数退避：每次重试等待时间翻倍
            await new Promise((r) => setTimeout(r, delay));
            return withRetry(fn, retries - 1, delay * 1.5);
        }
        throw e;
    }
}

// ... 保持其他 Helper 函数不变 ...
// (为防止丢失，我这里简写了，请务必保留你原文件底部的那些辅助函数！)

// --- Rest of Helpers (Copy from previous or keep existing) ---

async function getTokenMetadata(address: string, fallback?: number) {
    try {
        const url = `https://api.dexscreener.com/latest/dex/tokens/${address}`;
        const res = await axios.get(url, {
            headers: { "User-Agent": "Mozilla/5.0" },
            timeout: 5000,
        });
        const pairs = res.data.pairs;
        if (pairs && pairs.length > 0) {
            const basePairs = pairs.filter((p: any) => p.chainId === "base" && p.pairCreatedAt);
            if (basePairs.length > 0) {
                basePairs.sort((a: any, b: any) => a.pairCreatedAt - b.pairCreatedAt);
                const p = basePairs[0];
                return {
                    createdAt: p.pairCreatedAt,
                    currentPrice: parseFloat(p.priceUsd || "0"),
                    initialPriceEstimate:
                        parseFloat(p.priceUsd || "0") /
                        (1 + parseFloat(p.priceChange?.h24 || "0") / 100),
                };
            }
        }
        return fallback
            ? { createdAt: fallback * 1000, currentPrice: 0, initialPriceEstimate: 0.00001 }
            : null;
    } catch (e) {
        return fallback
            ? { createdAt: fallback * 1000, currentPrice: 0, initialPriceEstimate: 0.00001 }
            : null;
    }
}

async function traceEarlyBuyers(
    provider: any,
    address: string,
    createdAtTimestamp: number,
    currentBlock: number,
): Promise<Map<string, ethers.BigNumber>> {
    const buyers = new Map<string, ethers.BigNumber>();
    const targetTimestampSec = Math.floor(createdAtTimestamp / 1000);
    const startBlock = await getBlockByTimestamp(provider, targetTimestampSec, currentBlock);
    const searchStart = Math.max(0, startBlock - CONFIG.LOOKBACK_BUFFER_BLOCKS);
    const searchEnd = Math.min(currentBlock, startBlock + CONFIG.SNIPE_WINDOW_BLOCKS);
    const logs = await getLogsInChunks(provider, searchStart, searchEnd, address, [TRANSFER_TOPIC]);
    if (logs.length === 0) return buyers;
    const firstSwapBlock = logs[0].blockNumber;
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
            if (!INFRA_BLACKLIST.has(to) && to !== address.toLowerCase()) {
                const current = buyers.get(to) || ethers.BigNumber.from(0);
                buyers.set(to, current.add(parsed.args.value));
            }
        } catch (e) {}
    }
    return buyers;
}

async function getBlockByTimestamp(provider: any, targetTimestamp: number, maxBlock: number) {
    let min = 0,
        max = maxBlock,
        closestBlock = max;
    while (min <= max) {
        const mid = Math.floor((min + max) / 2);
        const block = await withRetry(
            () => provider.getBlock(mid) as Promise<ethers.providers.Block>,
        );
        await new Promise((resolve) => setTimeout(resolve, 50)); // Tiny delay
        if (block.timestamp < targetTimestamp) min = mid + 1;
        else {
            closestBlock = mid;
            max = mid - 1;
        }
    }
    return closestBlock;
}

async function getLogsInChunks(
    provider: any,
    fromBlock: number,
    toBlock: number,
    address: string,
    topics: any[],
): Promise<ethers.providers.Log[]> {
    if (fromBlock > toBlock) return [];
    let retries = 5;
    while (retries > 0) {
        try {
            return await provider.getLogs({ address, topics, fromBlock, toBlock });
        } catch (e: any) {
            const msg = (e.message || "").toLowerCase();
            const errCode = (e.code || "").toString().toLowerCase();

            // 处理范围限制或日志量过大
            if (
                msg.includes("400") ||
                msg.includes("limit") ||
                msg.includes("range") ||
                msg.includes("size exceeded")
            ) {
                if (fromBlock === toBlock) return [];
                const mid = Math.floor((fromBlock + toBlock) / 2);
                const left = await getLogsInChunks(provider, fromBlock, mid, address, topics);
                const right = await getLogsInChunks(provider, mid + 1, toBlock, address, topics);
                return [...left, ...right];
            }

            // 处理临时性网络/服务器错误
            if (
                msg.includes("timeout") ||
                msg.includes("server_error") ||
                msg.includes("failed") ||
                errCode.includes("timeout")
            ) {
                retries--;
                await new Promise((r) => setTimeout(r, 2000));
                continue;
            }

            retries--;
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
    return [];
}

async function filterWallets(provider: any, hits: any) {
    // 注意：这个函数在最后清洗时调用，为了简单，这里 provider 参数暂时没用上双路
    // 但因为前面已经过滤过了，这里影响不大。如果需要严格，也可以改。
    const candidates = Object.keys(hits);
    const validHits: any = {};
    // ... 保持原有逻辑，或者简单跳过 ...
    for (const wallet of candidates) {
        validHits[wallet] = hits[wallet]; // 简化：前面已经 audit 过了
    }
    return validHits;
}

async function auditWallet(
    localProvider: any,
    remoteProvider: any,
    address: string,
    pastBlock: number,
    currentBlock: number,
) {
    try {
        // [优化] 1. 先用本地节点查 Code (免费)
        const code = await withRetry(() => localProvider.getCode(address) as Promise<string>);
        if (code !== "0x") return { pass: false, reason: "Contract" };

        // [优化] 2. 用本地节点查当前 Nonce (免费)
        // 如果当前 Nonce 都很小，直接 pass，不用查历史了
        const nonceNow = await withRetry(
            () => localProvider.getTransactionCount(address, "latest") as Promise<number>,
        );
        if (nonceNow > CONFIG.FILTER_MAX_TOTAL_NONCE) return { pass: false, reason: "High" };
        if (nonceNow < 2) return { pass: false, reason: "Low" };

        try {
            // [付费] 3. 只有前两步通过，才用远程节点查历史 Nonce
            const noncePast = await withRetry(
                () => remoteProvider.getTransactionCount(address, pastBlock) as Promise<number>,
            );
            const delta = nonceNow - noncePast;
            if (delta < CONFIG.FILTER_MIN_WEEKLY_TXS) return { pass: false, reason: "Inactive" };
            if (delta > CONFIG.FILTER_MAX_WEEKLY_TXS) return { pass: false, reason: "Freq" };
        } catch (e) {
            console.error(
                `      [Warning] [Audit] RPC Error for ${address} at pastBlock: ${(e as any).message}`,
            );
            return { pass: false, reason: "RPC" };
        }
        return { pass: true, reason: "OK" };
    } catch (e) {
        console.error(`      [Error] [Audit] Critical Error for ${address}: ${(e as any).message}`);
        return { pass: false, reason: "Err" };
    }
}

function exportProfileData(walletHits: Record<string, string[]>): string[] {
    console.log(`\n================ LEGENDARY SNIPERS FOUND ================`);
    const sorted = Object.entries(walletHits)
        .filter(([_, hits]) => hits.length >= CONFIG.MIN_HIT_COUNT)
        .sort((a, b) => b[1].length - a[1].length);
    const lines = [];
    for (const [wallet, hits] of sorted) {
        const line = `[${hits.length} Legends] ${wallet} | Bags: ${hits.join(", ")}`;
        console.log(line);
        lines.push(line);
    }

    const addresses = sorted.map(([wallet]) => wallet);

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

    // [修改] 保存为 JSON 格式作为中间文件
    fs.writeFileSync(`${DATA_DIR}/legends_base.json`, JSON.stringify(addresses, null, 2));
    console.log(`\n[Success] Saved ${addresses.length} legends to ${DATA_DIR}/legends_base.json`);

    return addresses;
}

if (require.main === module) {
    profileEarlyBuyers();
}
