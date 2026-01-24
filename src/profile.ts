console.log("[System] Script loading...");

import { ethers } from "ethers";
import axios from "axios";
import * as fs from "fs";
import {
    DATA_DIR,
    BLACKLIST_FILE,
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

    const walletHits: Record<string, { tokens: string[]; totalPnL: number }> = {};
    
    // [优化] 持久化黑名单加载
    let globalBlacklist = new Set<string>();
    if (fs.existsSync(BLACKLIST_FILE)) {
        const loaded = JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf-8"));
        globalBlacklist = new Set(loaded);
    }

    let targets: TrendingToken[] = inputTargets || [];

    // Fallback: 如果没有传入数据，尝试从文件读取
    if (targets.length === 0) {
        try {
            const targetFile =`${DATA_DIR}/trending_dogs.json`;
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

                    // ================= [Strategy Selector] =================
                    // Mode A: Genesis Hunter (New Tokens < 7 days)
                    // Mode B: Swing Master (Old Tokens > 7 days)
                    const isOldDog = parseFloat(target.ageHours || "0") > 168;
                    let searchStart = 0;
                    let searchEnd = 0;

                    if (isOldDog) {
                        // [Mode B] Swing Master: Scan last 30 days
                        console.log(`   [Strategy] ${target.name} is an OLD DOG. Using Swing Master Mode (Last 30d).`);
                        searchEnd = currentBlock;
                        searchStart = Math.max(0, currentBlock - CONFIG.SWING_WINDOW_BLOCKS);
                    } else {
                        // [Mode A] Genesis Hunter: Scan first 4 hours
                        console.log(`   [Strategy] ${target.name} is a NEW DOG. Using Genesis Hunter Mode.`);
                        const targetTimestampSec = Math.floor(meta.createdAt / 1000);
                        const birthBlock = await getBlockByTimestamp(localProvider, targetTimestampSec, currentBlock);
                        
                        const SKIP_MEV_BLOCKS = 5;
                        searchStart = birthBlock + SKIP_MEV_BLOCKS;
                        searchEnd = Math.min(currentBlock, birthBlock + CONFIG.GENESIS_WINDOW_BLOCKS);
                    }

                    // 2. 扫描买家 (通用逻辑)
                    const buyersMap = await scanBuyers(
                        localProvider, // [修复] 切换到本地节点查日志 (速度快且免费)
                        target.address,
                        searchStart,
                        searchEnd
                    );

                    console.log(
                        `   [System] [${target.name}] Found ${buyersMap.size} candidates in range [${searchStart} -> ${searchEnd}]. Starting audit...`,
                    );

                    if (buyersMap.size > 0) {
                        const buyerList = Array.from(buyersMap.keys());
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
                                    if (globalBlacklist.has(buyer)) return;

                                    // 1. 先审 Nonce (过滤 Bot/新号，减少后续昂贵的 RPC 调用)
                                    const audit = await auditWallet(
                                        localProvider,
                                        remoteProvider,
                                        buyer,
                                        pastBlock,
                                        currentBlock,
                                    );
                                    if (!audit.pass) return;

                                    const buyerData = buyersMap.get(buyer);
                                    if (!buyerData) return;
                                    const { amount: buyAmount, firstBlock: firstBuyBlock } = buyerData;

                                    // 2. 检查卖出行为与 PnL
                                    const sellInfo = await checkLegitSell(
                                        localProvider,
                                        localProvider, // [修复] 切换到本地节点查个人日志
                                        buyer,
                                        target.address,
                                        startCheckBlock,
                                        currentBlock,
                                        buyAmount
                                    );
                                    if (sellInfo.status === "SUSPICIOUS") {
                                        globalBlacklist.add(buyer);
                                        return;
                                    }

                                    // ================= [The Paper Hand Fix] =================
                                    // 逻辑：不要只看卖了多少，要看剩了多少。
                                    // 只有当 retentionRate > 10% 时，才计算 PnL。
                                    // 这样过滤掉了所有"卖飞"的人。

                                    const currentBalance = sellInfo.currentBalance;
                                    
                                    // 计算持仓率 (0-100)
                                    let passesRetention = false;
                                    if (buyAmount.gt(0)) {
                                        // Check if retention > 10% (currentBalance * 10 > buyAmount)
                                        // Avoids .toNumber() overflow on large balances
                                        if (currentBalance.mul(10).gt(buyAmount)) passesRetention = true;
                                    }

                                    // 门槛：至少持有 10% 的原始仓位 (证明还在车上)
                                    if (passesRetention) {
                                        // 计算 PnL (只基于剩余持仓 + 已实现部分，或者保守点只看剩余部分)
                                        // 这里采用保守策略：如果 [剩余持仓价值] > [总成本 * 2]，那绝对是神
                                        
                                        const currentValueUSD = parseFloat(ethers.utils.formatEther(currentBalance)) * meta.currentPrice;
                                        
                                        // 成本计算：
                                        // Genesis Mode: 使用 initialPriceEstimate
                                        // Swing Mode: 理想情况用买入时价格，但没有API。
                                        // 近似方案：Swing Mode 下，如果他买入后现在还在持有且价值很高，我们假设他是对的。
                                        // 为了统一，我们这里还是用 initialPriceEstimate (注意：对老币这会偏低，导致 PnL 虚高，
                                        // 但我们主要靠 retentionRate 和 audit 过滤)。
                                        // *更优解*：对于老币，我们假设成本是当前价格的 50% (假设他是抄底的)，或者简单地只看持仓金额。
                                        
                                        const costPrice = isOldDog ? meta.currentPrice * 0.5 : meta.initialPriceEstimate;
                                        const costBasisUSD = parseFloat(ethers.utils.formatEther(buyAmount)) * costPrice;

                                        // 判定标准：
                                        // 1. 还没卖完 (Retention > 10)
                                        // 2. 账面浮盈 > 2倍总成本 (说明买的位置极好，或者拿得极久)
                                        // 3. 或者是 Swing Mode 下的大额持仓者
                                        
                                        if (costBasisUSD > 0 && currentValueUSD > costBasisUSD * 2) {
                                            if (!walletHits[buyer]) walletHits[buyer] = { tokens: [], totalPnL: 0 };
                                            walletHits[buyer].tokens.push(target.name);
                                            walletHits[buyer].totalPnL += (currentValueUSD - costBasisUSD);
                                            hitCount++;
                                            console.log(
                                                `      [Legend] [${target.name}] Found Legend: ${buyer} (${(currentValueUSD / costBasisUSD).toFixed(1)}x)`,
                                            );
                                        }
                                    }
                                }),
                            );

                            // [Rate Limit] Add delay between batches to let CU bucket refill
                            await new Promise((r) => setTimeout(r, 1000));
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
        // 保存黑名单
        fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(Array.from(globalBlacklist), null, 2));
        console.log(`[System] Updated blacklist saved to ${BLACKLIST_FILE}`);

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
    buyAmount?: ethers.BigNumber,
): Promise<{
    status: "YES" | "NO_SELL" | "SUSPICIOUS";
    totalSold: ethers.BigNumber;
    currentBalance: ethers.BigNumber;
    lastSellBlock: number;
}> {
    const topic = ethers.utils.id("Transfer(address,address,uint256)");
    const walletPad = ethers.utils.hexZeroPad(wallet, 32);
    const iface = new ethers.utils.Interface(LOG_ABI);
    const tokenContract = new ethers.Contract(tokenAddress, LOG_ABI, localProvider); // 查余额用本地

    try {
        // [优化] 优先检查本地余额。如果余额 >= 买入量，说明没卖，跳过远程日志查询
        const currentBalance = await withRetry(() => tokenContract.balanceOf(wallet) as Promise<ethers.BigNumber>).catch(
            () => ethers.BigNumber.from(0),
        );

        if (buyAmount && currentBalance.gte(buyAmount)) {
            return { status: "NO_SELL", totalSold: ethers.BigNumber.from(0), currentBalance, lastSellBlock: 0 };
        }

        const logs = await getLogsInChunks(
                    remoteProvider, // 查日志用远程
                    startBlock,
                    currentBlock,
                    tokenAddress,
                    [topic, walletPad],
                );

        if (logs.length === 0)
            return { status: "NO_SELL", totalSold: ethers.BigNumber.from(0), currentBalance, lastSellBlock: 0 };

        let totalSold = ethers.BigNumber.from(0);
        let hasLegitSell = false;
        let lastSellBlock = 0;

        for (const log of logs) {
            // 从 Topic2 提取接收者地址 (indexed to)
            const to = ethers.utils.defaultAbiCoder
                .decode(["address"], log.topics[2])[0]
                .toLowerCase();
            const parsed = iface.parseLog(log);

            if (DEX_ROUTERS.has(to)) {
                hasLegitSell = true;
                totalSold = totalSold.add(parsed.args.value);
                lastSellBlock = Math.max(lastSellBlock, log.blockNumber);
            } else {
                const code = await withRetry(
                    () => localProvider.getCode(to) as Promise<string>,
                ).catch(() => "0x");
                if (code !== "0x" && to !== tokenAddress.toLowerCase())
                    return { status: "SUSPICIOUS", totalSold, currentBalance, lastSellBlock: 0 };
            }
        }

        return { status: hasLegitSell ? "YES" : "NO_SELL", totalSold, currentBalance, lastSellBlock };
    } catch (e) {
        console.error(
            `      [Error] [${tokenAddress}] checkLegitSell Error for ${wallet}: ${(e as any).message}`,
        );
        return {
            status: "NO_SELL",
            totalSold: ethers.BigNumber.from(0),
            currentBalance: ethers.BigNumber.from(0),
            lastSellBlock: 0,
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

async function scanBuyers(
    provider: any,
    address: string,
    fromBlock: number,
    toBlock: number,
): Promise<Map<string, { amount: ethers.BigNumber; firstBlock: number }>> {
    const buyers = new Map<string, { amount: ethers.BigNumber; firstBlock: number }>();
    
    // 使用传入的 block range，不再内部计算
    const logs = await getLogsInChunks(provider, fromBlock, toBlock, address, [TRANSFER_TOPIC]);
    if (logs.length === 0) return buyers;

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
    for (const log of logs) {
        try {
            const parsed = iface.parseLog(log);
            if (!parsed) continue;
            const to = parsed.args.to.toLowerCase();
            if (!INFRA_BLACKLIST.has(to) && to !== address.toLowerCase()) {
                const current = buyers.get(to) || { amount: ethers.BigNumber.from(0), firstBlock: log.blockNumber };
                buyers.set(to, {
                    amount: current.amount.add(parsed.args.value),
                    firstBlock: Math.min(current.firstBlock, log.blockNumber)
                });
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
    // [Fix] Respect RPC_CHUNK_SIZE to avoid "10 block range" error on free tier
    const chunkSize = CONFIG.RPC_CHUNK_SIZE;
    if (toBlock - fromBlock + 1 > chunkSize) {
        let allLogs: ethers.providers.Log[] = [];
        for (let i = fromBlock; i <= toBlock; i += chunkSize) {
            const end = Math.min(i + chunkSize - 1, toBlock);
            const logs = await getLogsInChunks(provider, i, end, address, topics);
            allLogs = allLogs.concat(logs);
            // [Rate Limit] Small delay between log chunks
            await new Promise((r) => setTimeout(r, 200));
        }
        return allLogs;
    }

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
        
        // [修改] Copy Trade 策略：放宽 Nonce 上限，允许活跃交易者 (50k)，但过滤 CEX
        if (nonceNow > 50000) return { pass: false, reason: "High" };
        // [修改] 提高门槛，过滤掉只有 1-4 笔交易的纯新号 (通常是 Burner/Bot)
        if (nonceNow < 5) return { pass: false, reason: "Low" };

        // [新增] 2.5 验资 (Local) - 提前过滤穷鬼/Burner，节省 Remote RPC
        const balance = await withRetry(() => localProvider.getBalance(address) as Promise<ethers.BigNumber>);
        if (balance.lt(ethers.utils.parseEther("0.002"))) return { pass: false, reason: "Poor" };

        try {
            // [付费] 3. 只有前两步通过，才用远程节点查历史 Nonce
            const noncePast = await withRetry(
                () => remoteProvider.getTransactionCount(address, pastBlock) as Promise<number>,
            );
            const delta = nonceNow - noncePast;
            // [修改] 只要不是死号即可，移除高频限制
            if (delta < 1) return { pass: false, reason: "Inactive" };
            // if (delta > CONFIG.FILTER_MAX_WEEKLY_TXS) return { pass: false, reason: "Freq" };
        } catch (e: any) {
            // [新增] 容错处理：如果 Infura 挂了/限流了/本地节点不支持历史，直接放行
            // 我们已经查了当前 Nonce 和余额，这已经过滤掉了大部分垃圾号
            const msg = (e.message || "").toLowerCase();
            if (msg.includes("429") || msg.includes("limit") || msg.includes("credit") || msg.includes("missing trie")) {
                // console.log(`      [Audit] Skip history check (RPC Limit/No Archive)`);
                return { pass: true, reason: "SkipHist" };
            }

            console.error(
                `      [Warning] [Audit] RPC Error for ${address} at pastBlock: ${(e as any).message}`,
            );
            // 默认放行，防止因网络波动漏掉大佬
            return { pass: true, reason: "RPC_Skip" };
        }
        return { pass: true, reason: "OK" };
    } catch (e) {
        console.error(`      [Error] [Audit] Critical Error for ${address}: ${(e as any).message}`);
        return { pass: false, reason: "Err" };
    }
}

function exportProfileData(walletHits: Record<string, { tokens: string[]; totalPnL: number }>): string[] {
    console.log(`\n================ 🏆 HALL OF FAME (STRICT MODE) 🏆 ================`);
    
    // 1. [关键] 强制要求至少命中 2 个不同的狗
    // 如果你只扫描了 5-10 个币，这个条件可能太苛刻会导致结果为空。
    // 建议至少扫描 20-30 个热门币，然后开启这个过滤器。
    const SERIAL_KILLER_THRESHOLD = 2; 

    // 定义段位
    const getTier = (pnl: number, hitCount: number) => {
        if (hitCount >= 3) return "👑 KING"; // 命中3个以上，神级
        if (pnl >= 10000) return "🐋 WHALE";
        if (pnl >= 2000)  return "🦈 SHARK";
        return "� FISH";
    };

    // 2. 转换数据并过滤
    let candidates = Object.entries(walletHits)
        .map(([wallet, data]) => ({
            address: wallet,
            tokens: [...new Set(data.tokens)], // 去重，防止同一个币买多次算多次
            totalPnL: data.totalPnL,
            hitCount: new Set(data.tokens).size
        }))
        .filter(c => {
            // 规则 A: 必须命中至少 2 个不同的币 (证明不是运气)
            if (c.hitCount >= SERIAL_KILLER_THRESHOLD) return true;
            
            // 规则 B: 如果只命中 1 个，那 PnL 必须巨大 (比如 > $20k) 且必须是已卖出止盈的 (避免死拿的 Insider)
            // 这里我们暂时只用 PnL 过滤，假设 $20k 以上的单发选手也有一定参考价值
            if (c.hitCount === 1 && c.totalPnL > 20000) return true;

            return false; 
        })
        .sort((a, b) => {
            // 3. [优化排序] 优先按“命中次数”排序，其次才是 PnL
            // 一个赚 $5000 但命中了 3 个币的人，比赚 $50000 但只命中 1 个币的人更有跟单价值
            if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
            return b.totalPnL - a.totalPnL;
        });

    if (candidates.length === 0) {
        console.log(`[Warning] No "Serial Killers" found. Try scanning MORE tokens to find overlapping wallets.`);
        return [];
    }

    const lines = [];
    
    for (const c of candidates) {
        const tier = getTier(c.totalPnL, c.hitCount);
        const icon = c.hitCount >= 3 ? "🔥" : "🎯";
        
        // 格式化输出：突出显示命中次数
        const line = `${icon} [${tier}] ${c.address} | Hits: ${c.hitCount} | PnL: +$${c.totalPnL.toFixed(0)} | Bags: ${c.tokens.join(", ")}`;
        console.log(line);
        lines.push(c.address);
    }

    // 保存结果
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
    fs.writeFileSync(`${DATA_DIR}/legends_base.json`, JSON.stringify(candidates, null, 2));
    console.log(`\n[Success] Saved ${candidates.length} Elite Traders to ${DATA_DIR}/legends_base.json`);

    return lines;
}

if (require.main === module) {
    profileEarlyBuyers();
}
