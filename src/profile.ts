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
    checkWalletPnL,
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

                    // [新增] 1.1 死狗过滤 (Dead Dog Filter)
                    // 如果币龄 > 6天 (144h) 且 FDV < $500k，说明是僵尸币，里面的"早期买家"大概率是被套的
                    const ageHours = (Date.now() - meta.createdAt) / 3600000;
                    if (ageHours > 144 && meta.fdv < 500000) {
                        console.log(`   [Skip] ${target.name} is a dead old dog (Age: ${ageHours.toFixed(1)}h, FDV: $${(meta.fdv/1000).toFixed(0)}k)`);
                        return;
                    }

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
                        remoteProvider,
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

                                    // 1. 基础审计：过滤小额杂鱼
                                    if (buyAmount.lt(ethers.utils.parseEther("0.05"))) return;

                                    // 2. 获取当前余额
                                    const tokenContract = new ethers.Contract(target.address, LOG_ABI, localProvider);
                                    const currentBalance = await withRetry(() => tokenContract.balanceOf(buyer) as Promise<ethers.BigNumber>).catch(() => ethers.BigNumber.from(0));

                                    // 3. 计算留存率
                                    let retentionRate = 0;
                                    if (!buyAmount.isZero()) {
                                        retentionRate = currentBalance.mul(100).div(buyAmount).toNumber();
                                    }

                                    // 4. 计算当前浮盈倍数
                                    // [修复] 只有 24h 内的新币，initialPriceEstimate 才是准的 (基于 24h 涨跌幅反推)
                                    // 对于老币，这个倍数毫无意义 (是相对于 24h 前的价格)，直接置为 0 避免误导
                                    const isGenesis = ageHours < 24;
                                    const priceMultiple = isGenesis ? (meta.currentPrice / meta.initialPriceEstimate) : 0;

                                    // 5. [核心修复] 重新定义“赢家”逻辑
                                    let isCandidate = false;
                                    let reason = "";

                                    // 情况 A: 钻石手 (还持有 > 10%) - 逻辑不变，但要求更高
                                    if (retentionRate > 10) {
                                        const holdValueUSD = parseFloat(ethers.utils.formatEther(currentBalance)) * meta.currentPrice;
                                        
                                        if (isGenesis) {
                                            // 新币：看倍数 + 持仓
                                            if (priceMultiple > 3.0 && holdValueUSD > 200) {
                                                isCandidate = true;
                                                reason = `💎 Diamond: ${priceMultiple.toFixed(1)}x | Bags: $${holdValueUSD.toFixed(0)}`;
                                            }
                                        } else {
                                            // 老币：倍数不准，只看持仓价值 (硬门槛 $500)
                                            // 逻辑：能拿住 $500 以上的老币，且总 PnL 为正，说明是稳健的持有者
                                            if (holdValueUSD > 500) {
                                                isCandidate = true;
                                                reason = `💎 Diamond (Old): Bags $${holdValueUSD.toFixed(0)}`;
                                            }
                                        }
                                    } 
                                    // 情况 B: 止盈大师 (已清仓 或 持有 < 10%) - [新增逻辑]
                                    else {
                                        // 只有当该钱包进行了 "Legit Sell" (在 DEX 卖出) 时才算
                                        // 这一步虽然费 RPC，但必须做，否则分不清是转账跑路还是卖出
                                        const sellAudit = await checkLegitSell(
                                            localProvider, 
                                            remoteProvider, 
                                            buyer, 
                                            target.address, 
                                            searchStart, 
                                            searchEnd,
                                            buyAmount
                                        );

                                        if (sellAudit.status === "YES") {
                                            // 如果他卖了，我们很难算出具体每一笔的卖出价(太费资源)
                                            // 但我们可以假设：如果他是一个长期盈利的钱包(Moralis PnL check)，
                                            // 且他在这里卖出了，那大概率是赚的。
                                            isCandidate = true;
                                            reason = `Ck Sniper: Sold Out via DEX`;
                                        }
                                    }

                                    // 6. 最终验证 (这一步不仅是 PnL 检查，更是为了确认 "Sold Out" 的人是不是真大佬)
                                    if (isCandidate) {
                                        // 调用 Moralis 查祖宗三代 (GMGN 风格)
                                        const pnlPass = await checkWalletPnL(buyer);
                                        
                                        if (!pnlPass) {
                                            // 虽然这把操作看着像赢了，但总账是亏的，或者是刷子 -> 剔除
                                            // console.log(`      [Skip] ${buyer} failed global PnL check.`);
                                        } else {
                                            if (!walletHits[buyer]) {
                                                walletHits[buyer] = { tokens: [], totalPnL: 0 };
                                            }
                                            walletHits[buyer].tokens.push(target.name);
                                            hitCount++;

                                            // 粗略估算 PnL (为了排序):
                                            // 如果是持有者，用浮盈; 如果是卖出者，给一个固定权重(比如假设赚了$1000)或者忽略
                                            const estimatedProfit = retentionRate > 10 
                                                ? parseFloat(ethers.utils.formatEther(currentBalance)) * meta.currentPrice 
                                                : 1000; // 卖出者默认给个权重，主要靠 hitCount 排序

                                            walletHits[buyer].totalPnL += estimatedProfit;

                                            console.log(`      [Legend] [${target.name}] ${buyer} | ${reason}`);
                                        }
                                    }
                                }),
                            );

                            // [Rate Limit] Add delay between batches to let CU bucket refill
                            await new Promise((r) => setTimeout(r, 50)); // [付费版优化] 缩短等待时间
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
        // [优化] 优先检查本地余额。
        const currentBalance = await withRetry(() => tokenContract.balanceOf(wallet) as Promise<ethers.BigNumber>).catch(
            () => ethers.BigNumber.from(0),
        );

        // [修改] 只有余额 > 90% 买入量才算没卖 (容忍一点点磨损)
        if (buyAmount && currentBalance.gte(buyAmount.mul(90).div(100))) {
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
                    fdv: parseFloat(p.fdv || "0"), // [新增] FDV 用于过滤死狗
                };
            }
        }
        return fallback
            ? { createdAt: fallback * 1000, currentPrice: 0, initialPriceEstimate: 0.00001, fdv: 999999999 }
            : null;
    } catch (e) {
        return fallback
            ? { createdAt: fallback * 1000, currentPrice: 0, initialPriceEstimate: 0.00001, fdv: 999999999 }
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
            await new Promise((r) => setTimeout(r, 10)); // [付费版优化] 几乎移除等待
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
            if (delta > CONFIG.FILTER_MAX_WEEKLY_TXS) return { pass: false, reason: "Freq" }; // [恢复] 过滤高频 Bot
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

function exportProfileData(walletHits: Record<string, { tokens: string[]; totalPnL: number }>): string[] {
    console.log(`\n================ LEGENDARY SNIPERS FOUND ================`);
    
    // 定义段位计算函数
    const getTier = (pnl: number) => {
        if (pnl >= 50000) return "🐋 WHALE";
        if (pnl >= 10000) return "🦈 SHARK";
        if (pnl >= 2000)  return "🐬 DOLPHIN";
        return "🐟 FISH";
    };

    const sorted = Object.entries(walletHits)
        .filter(([_, data]) => data.tokens.length >= CONFIG.MIN_HIT_COUNT)
        .sort((a, b) => b[1].totalPnL - a[1].totalPnL); // 按总 PnL 排序，而不是命中数

    const lines = [];
    const richData = [];

    for (const [wallet, data] of sorted) {
        const tier = getTier(data.totalPnL);
        const line = `[${tier}] ${wallet} | PnL: +$${data.totalPnL.toFixed(0)} | Bags: ${data.tokens.join(", ")}`;
        console.log(line);
        lines.push(line);
        
        // 保存丰富数据结构
        richData.push({ address: wallet, tier, pnl: data.totalPnL, tokens: data.tokens });
    }

    const addresses = sorted.map(([wallet]) => wallet);

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

    // [修改] 保存为包含 Tier 信息的丰富 JSON，方便人工查看
    fs.writeFileSync(`${DATA_DIR}/legends_base.json`, JSON.stringify(richData, null, 2));
    console.log(`\n[Success] Saved ${addresses.length} legends (with Tiers) to ${DATA_DIR}/legends_base.json`);

    return addresses;
}

if (require.main === module) {
    profileEarlyBuyers();
}
