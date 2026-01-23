import axios from "axios";
import * as fs from "fs";
import { ethers } from "ethers";
import { DATA_DIR, TrendingToken, LOCAL_RPC_URL } from "./common";

// ================= 配置区域 =================
const CONFIG = {
    CHAIN: "base",
    MAX_AGE_HOURS: 720, // 30天
    MIN_LIQUIDITY_USD: 5000,
    MIN_VOLUME_24H: 2000,
    MIN_FDV: 5000,
    
    // [策略 1] GeckoTerminal 配置
    FETCH_PAGES: 5, // 免费版限制，我们只抓前 5 页最热的

    // [策略 2] CoinGecko 配置 (补充老金狗)
    FETCH_CG_TOP_COUNT: 100, // 抓取市值前 100 的 Base 代币

    // [策略 3] RPC 链上扫描配置 (补充最新狗)
    RPC_SCAN_BLOCKS: 2000, // 扫描过去 N 个区块 (约 1 小时)
};

// [移至全局] 手动注入的老金狗名单 (Base 链上的蓝筹 Meme)
const LEGENDS = [
    { name: "BRETT", address: "0x532f27101965dd16442e59d40670faf5ebb142e4" },
    { name: "TOSHI", address: "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4" },
    { name: "DEGEN", address: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed" },
    { name: "KEYCAT", address: "0x9a26f5433671751c3276a065f57e5a02d281797d" },
    { name: "MOG", address: "0x2Da56AcB9Ea78330f947bD57C54119Debda7AF71" },
    { name: "VIRTUAL", address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b" },
    { name: "HIGHER", address: "0x0578d8d485ebb2720521fb692b012495a070e3ed" },
    { name: "BENJI", address: "0xbc45647ea894030a4e9801ec03479739fa2485f0" },
    { name: "MIGGLES", address: "0xb1a03eda10342529ab8f34b31e5e7b51b7a40363" },
    { name: "MFER", address: "0xe3086852a4b125803c815a158249ae46c7f25283" },
    { name: "AERO", address: "0x940181a94a35a4569e4529a3cdfb74e38fd98631" },
    { name: "CHOMP", address: "0x48e14620579e0000a65e75185d2630d421852100" },
    { name: "TYBG", address: "0x0d97F261b1e88845184f678e2d1e7a98D9FD38dE" }, // Base God
    { name: "DOGINME", address: "0x6921B130D297cc43754afba22e5EAc0FBf8Db75b" },
    { name: "MOCHI", address: "0xF6e932Ca12afa26665dC4dDE7e27be02A7c02e50" },
    { name: "BLOO", address: "0x57e114B691Db790C35207b2e685D4A69cd48782C" }, // Bloo Foster Coin
    { name: "SKI", address: "0x07ac5529022243723329D8135114b9e8C84d747b" }   // Ski Mask Dog
];

// Base 链上的 Uniswap V3 Factory 地址
const UNIV3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const POOL_CREATED_TOPIC = ethers.utils.id("PoolCreated(address,address,uint24,int24,address)");

export async function fetchTrending(): Promise<TrendingToken[]> {
    console.log(`\n[System] 🚀 Starting MULTI-SOURCE Trend Hunter...`);
    
    const candidates: Map<string, TrendingToken> = new Map();

    // ================= 1. GeckoTerminal (Trending) =================
    await fetchFromGeckoTerminal(candidates);

    // ================= 2. CoinGecko (Established Winners) =================
    await fetchFromCoinGecko(candidates);

    // ================= 3. RPC Direct Scan (Fresh Mints) =================
    await fetchFromRPC(candidates);

    // ================= 4. 汇总与保存 =================
    // [修改] 智能混合策略：防止"一刀切"把新狗和老狗切掉
    const allTokens = Array.from(candidates.values());
    const legendAddrSet = new Set(LEGENDS.map(l => l.address.toLowerCase()));

    const groupLegends: TrendingToken[] = [];
    const groupFresh: TrendingToken[] = [];
    const groupTrending: TrendingToken[] = [];

    for (const t of allTokens) {
        if (legendAddrSet.has(t.address.toLowerCase())) {
            groupLegends.push(t);
        } else if (t.name === "RPC_FRESH") {
            groupFresh.push(t);
        } else {
            groupTrending.push(t);
        }
    }

    console.log(`\n[System] Classification: Legends=${groupLegends.length}, Fresh=${groupFresh.length}, Trending=${groupTrending.length}`);

    // 组装最终列表
    // 1. Legends: 全都要 (用于交集分析)
    // 2. Fresh: 取最新的 20 个 (用于 Genesis Hunter)
    // 3. Trending: 取 Volume 最高的 40 个 (用于发现当下热点)
    
    groupFresh.sort((a, b) => b.fallbackTime - a.fallbackTime); // 按时间倒序
    groupTrending.sort((a, b) => (b.volume || 0) - (a.volume || 0)); // 按量倒序

    const keepFresh = groupFresh.slice(0, 20);
    const keepTrending = groupTrending.slice(0, 40);
    
    // 合并
    const finalList = [...groupLegends, ...keepFresh, ...keepTrending];

    // 最终排序：为了 CLI 好看，把 Fresh 放前面，然后是 Legends，然后是 Trending
    finalList.sort((a, b) => {
        const typeA = a.name === "RPC_FRESH" ? 0 : (legendAddrSet.has(a.address.toLowerCase()) ? 1 : 2);
        const typeB = b.name === "RPC_FRESH" ? 0 : (legendAddrSet.has(b.address.toLowerCase()) ? 1 : 2);
        if (typeA !== typeB) return typeA - typeB;
        return (b.volume || 0) - (a.volume || 0);
    });

    console.log(`\n================ FINAL TARGET LIST (${finalList.length}) ================`);
    // 预览前 10 个
    finalList.slice(0, 10).forEach((c, i) => {
        console.log(`#${i+1} ${c.name} (${c.ageHours}h) - Vol: $${(c.volume/1000).toFixed(0)}k`);
    });

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
    fs.writeFileSync(`${DATA_DIR}/trending_dogs.json`, JSON.stringify(finalList, null, 2));
    console.log(`\n[Success] Saved ${finalList.length} tokens to ${DATA_DIR}/trending_dogs.json`);

    return finalList;
}

// --- 策略 1: GeckoTerminal (抓取热门) ---
async function fetchFromGeckoTerminal(map: Map<string, TrendingToken>) {
    console.log(`\n[Source 1] Fetching GeckoTerminal Trending...`);
    try {
        for (let page = 1; page <= CONFIG.FETCH_PAGES; page++) {
            process.stdout.write(`   Page ${page}... `);
            const url = `https://api.geckoterminal.com/api/v2/networks/${CONFIG.CHAIN}/trending_pools?include=base_token&page=${page}`;
            const res = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 5000 });
            
            if (!res.data?.data) continue;

            for (const pool of res.data.data) {
                const attr = pool.attributes;
                if (!pool.relationships?.base_token?.data?.id) continue;
                
                const baseTokenId = pool.relationships.base_token.data.id;
                const address = (baseTokenId.includes("_") ? baseTokenId.split("_")[1] : baseTokenId).toLowerCase();
                
                if (map.has(address)) continue;

                const name = attr.name.split(" / ")[0];
                if (isStableCoin(name)) continue;

                // [新增] 严格过滤：剔除流动性差或交易量低的垃圾盘
                const vol = parseFloat(attr.volume_usd?.h24 || "0");
                const liq = parseFloat(attr.reserve_in_usd || "0");
                if (vol < CONFIG.MIN_VOLUME_24H) continue;
                if (liq < CONFIG.MIN_LIQUIDITY_USD) continue;

                const createdAt = new Date(attr.pool_created_at).getTime();
                const ageHours = (Date.now() - createdAt) / 36e5;

                map.set(address, {
                    name,
                    address,
                    ageHours: ageHours.toFixed(1),
                    fallbackTime: Math.floor(createdAt / 1000),
                    volume: parseFloat(attr.volume_usd?.h24 || "0"),
                    liquidity: parseFloat(attr.reserve_in_usd || "0")
                });
            }
            await new Promise(r => setTimeout(r, 1500)); // Rate limit
        }
        console.log(`Done. Total so far: ${map.size}`);
    } catch (e) {
        console.log(`[Error] GeckoTerminal failed: ${(e as any).message}`);
    }
}

// --- 策略 2: CoinGecko (抓取市值前 100 的老金狗) ---
async function fetchFromCoinGecko(map: Map<string, TrendingToken>) {
    console.log(`\n[Source 2] Fetching CoinGecko Top Market Cap (Base)...`);
    try {
        // CoinGecko 免费 API: 获取 Base 链上按市值排名的币种
        // 注意：category=base-ecosystem 有时包含非 Base 原生币，我们用 vs_currency=usd 配合后续过滤
        const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=base-ecosystem&order=market_cap_desc&per_page=${CONFIG.FETCH_CG_TOP_COUNT}&page=1&sparkline=false`;
        
        const res = await axios.get(url, { timeout: 10000 });
        if (!res.data) return;

        let added = 0;
        // [动态解析] 你的直觉非常准！
        // 前 15 名通常是大家都知道的"龙头" (Page 1-5)。
        // 要填补 GeckoTerminal Page 10-30 的空缺，我们需要下沉到市值排名 16-100 的"中盘币"。
        // 这里我们不再截断，直接扫描 CoinGecko 返回的全部 100 个代币。
        const topCoins = res.data; 
        
        console.log(`   Resolving addresses for ${topCoins.length} coins (Deep Scan for Mid-Caps)...`);

        for (const coin of topCoins) {
            const symbol = coin.symbol.toUpperCase();
            
            // 1. 如果已经在硬编码名单里，跳过 (让后面的逻辑处理)
            if (LEGENDS.some(l => l.name === symbol)) continue;

            // 2. 尝试通过 DexScreener 搜索合约地址
            try {
                process.stdout.write(`   Resolving ${symbol}... `);
                const searchUrl = `https://api.dexscreener.com/latest/dex/search?q=${symbol}`;
                const searchRes = await axios.get(searchUrl, { timeout: 2000 });
                
                if (searchRes.data?.pairs) {
                    // 找到 Base 链上，且 Symbol 匹配的池子 (优先流动性高的)
                    const pair = searchRes.data.pairs.find((p: any) => 
                        p.chainId === "base" && 
                        p.baseToken.symbol.toUpperCase() === symbol
                    );

                    if (pair) {
                        const addr = pair.baseToken.address.toLowerCase();
                        if (!map.has(addr)) {
                            map.set(addr, {
                                name: symbol,
                                address: addr,
                                ageHours: "9999", // 视为老币
                                fallbackTime: 0,
                                volume: parseFloat(pair.volume?.h24 || "0"),
                                liquidity: parseFloat(pair.liquidity?.usd || "0")
                            });
                            added++;
                            console.log(`OK (${addr.slice(0,6)}...)`);
                        } else {
                            console.log(`Skip (Exists)`);
                        }
                    } else {
                        console.log(`Not found on Base`);
                    }
                }
                // 礼貌性延迟，防止 429
                await new Promise(r => setTimeout(r, 300));
            } catch (e) {
                console.log(`Error`);
            }
        }
        
        // [替代方案] 使用硬编码的“历史百倍币”列表 (最稳健的免费方案)
        for (const dog of LEGENDS) {
            const addr = dog.address.toLowerCase();
            if (!map.has(addr)) {
                map.set(addr, {
                    name: dog.name,
                    address: addr,
                    ageHours: "9999", // Old dog
                    fallbackTime: 0,
                    volume: 1000000, // 假定高成交量
                    liquidity: 1000000
                });
                added++;
            }
        }
        console.log(`Done. Injected ${added} Legends.`);

    } catch (e) {
        console.log(`[Error] CoinGecko failed: ${(e as any).message}`);
    }
}

// --- 策略 3: RPC 直接扫描 (抓取最新诞生的池子) ---
async function fetchFromRPC(map: Map<string, TrendingToken>) {
    console.log(`\n[Source 3] Scanning RPC for NEW Uniswap V3 Pools...`);
    const provider = new ethers.providers.StaticJsonRpcProvider(LOCAL_RPC_URL);

    try {
        const currentBlock = await provider.getBlockNumber();
        const fromBlock = currentBlock - CONFIG.RPC_SCAN_BLOCKS;
        console.log(`   Scanning blocks ${fromBlock} -> ${currentBlock} (Uniswap V3 Factory)...`);

        const logs = await provider.getLogs({
            address: UNIV3_FACTORY,
            topics: [POOL_CREATED_TOPIC],
            fromBlock: fromBlock,
            toBlock: currentBlock
        });

        console.log(`   Found ${logs.length} PoolCreated events.`);

        let added = 0;
        for (const log of logs) {
            // 解析日志: PoolCreated(token0, token1, fee, tickSpacing, pool)
            // topic[1] = token0, topic[2] = token1
            const token0 = ethers.utils.defaultAbiCoder.decode(["address"], log.topics[1])[0].toLowerCase();
            const token1 = ethers.utils.defaultAbiCoder.decode(["address"], log.topics[2])[0].toLowerCase();
            
            // 简单的过滤：我们只关心非 WETH/USDC 的那个币
            const WETH = "0x4200000000000000000000000000000000000006";
            const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
            
            let targetToken = "";
            if (token0 === WETH || token0 === USDC) targetToken = token1;
            else if (token1 === WETH || token1 === USDC) targetToken = token0;
            else continue; // 忽略非主流币对

            if (map.has(targetToken)) continue;

            // 注意：RPC 扫描不知道 Token 名字，我们暂时用 "UNKNOWN" 代替
            // profile.ts 后续会自动去 DexScreener 查名字，所以这里没关系
            map.set(targetToken, {
                name: "RPC_FRESH", 
                address: targetToken,
                ageHours: "0.1", // 非常新
                fallbackTime: Math.floor(Date.now() / 1000),
                volume: 0, // 未知
                liquidity: 0 // 未知
            });
            added++;
        }
        console.log(`Done. Found ${added} fresh tokens via RPC.`);

    } catch (e) {
        console.log(`[Error] RPC Scan failed: ${(e as any).message}`);
    }
}

function isStableCoin(name: string) {
    const u = name.toUpperCase();
    return u.includes("USD") || u.includes("DAI") || u.includes("ETH") || u.includes("BTC");
}

if (require.main === module) {
    fetchTrending();
}
