import axios from "axios";
import * as fs from "fs";

// ================= 配置区域 =================
const CONFIG = {
    // 目标链
    CHAIN: "base",
    
    // 核心锚定资产 (WETH)
    // 我们查 WETH 的所有交易对，因为绝大多数金狗都是和 WETH 组池子的
    ANCHOR_TOKEN: "0x4200000000000000000000000000000000000006", 

    // 过滤标准
    MAX_AGE_HOURS: 336,      // 扩大时间范围到 14 天，寻找更稳健的趋势
    MIN_LIQUIDITY_USD: 20000, // 提高门槛，只看真正跑出来的金狗
    MIN_VOLUME_24H: 10000,   // 24小时成交量至少 $10k (活跃!)
    MIN_FDV: 50000,          // 市值至少 $50k
};

async function main() {
    console.log(`🚀 Starting GeckoTerminal Trend Hunter...`);
    console.log(`🎯 Chain: ${CONFIG.CHAIN} | Max Age: ${CONFIG.MAX_AGE_HOURS}h | Min Vol: $${CONFIG.MIN_VOLUME_24H}`);

    try {
        // 1. 改用 GeckoTerminal Trending Pools API (更精准抓取热门新池子)
        const url = `https://api.geckoterminal.com/api/v2/networks/${CONFIG.CHAIN}/trending_pools?include=base_token`;
        const response = await axios.get(url, { timeout: 10000 });
        
        if (!response.data || !response.data.data) {
            console.error("❌ API Error: No data found.");
            return;
        }

        const pools = response.data.data;
        console.log(`📡 Fetched ${pools.length} trending pools from GeckoTerminal.`);

        // 2. 核心过滤逻辑
        const now = Date.now();
        const candidates = [];

        for (const pool of pools) {
            const attr = pool.attributes;

            // A. 创建时间筛选
            if (!attr.pool_created_at) continue;
            const createdAt = new Date(attr.pool_created_at).getTime();
            const ageHours = (now - createdAt) / (1000 * 60 * 60);
            
            if (ageHours > CONFIG.MAX_AGE_HOURS) continue;

            // B. 数据指标过滤
            const liquidity = parseFloat(attr.reserve_in_usd || "0");
            const volume24h = parseFloat(attr.volume_usd?.h24 || "0");
            const fdv = parseFloat(attr.fdv_usd || "0");

            if (liquidity < CONFIG.MIN_LIQUIDITY_USD) continue;
            if (volume24h < CONFIG.MIN_VOLUME_24H) continue;
            if (fdv < CONFIG.MIN_FDV) continue;

            // C. 获取 Token 地址 (从 relationships 中提取)
            // id 格式通常是 "base_0x..."
            const baseTokenId = pool.relationships?.base_token?.data?.id;
            if (!baseTokenId) continue;
            // [修正] 兼容 "base_0x..." 和直接 "0x..." 的格式，并去除潜在空格
            const tokenAddress = (baseTokenId.includes("_") ? baseTokenId.split("_")[1] : baseTokenId).trim();
            const name = attr.name.split(" / ")[0];

            // 排除稳定币和 WETH
            if (["USDC", "USDT", "DAI", "WETH"].includes(name)) continue;

            candidates.push({
                name: name,
                address: tokenAddress,
                ageHours: ageHours.toFixed(1),
                liquidity: liquidity,
                volume: volume24h,
                priceChange: 0, // GeckoTerminal 此接口不直接提供涨幅，暂置0
                pairCreatedAt: Math.floor(createdAt / 1000),
                fallbackTime: Math.floor(createdAt / 1000)
            });
        }

        // 3. 排序 (按成交量降序，资金最诚实)
        candidates.sort((a, b) => b.volume - a.volume);

        // 4. 输出结果
        console.log(`\n================ 💎 FRESH GOLDEN DOGS (${candidates.length}) ================`);
        
        const outputList = [];
        
        candidates.forEach((c, index) => {
            console.log(`\n#${index + 1} [${c.name}]`);
            console.log(`   Contract: ${c.address}`);
            console.log(`   Age: ${c.ageHours} hrs | Vol: $${(c.volume/1000).toFixed(1)}k | Liq: $${(c.liquidity/1000).toFixed(1)}k`);
            
            // 构造可以直接贴进 profile.ts 的格式
            outputList.push(`    { name: "${c.name}", address: "${c.address}", fallbackTime: ${c.pairCreatedAt} }, // Vol: $${(c.volume/1000).toFixed(0)}k`);
        });

        console.log(`\n\n👇 [COPY PASTE BELOW] Update your profile.ts GOLDEN_DOGS with this: 👇\n`);
        console.log(`const GOLDEN_DOGS = [`);
        outputList.forEach(line => console.log(line));
        console.log(`];`);

        // 5. 保存到文件供 pipeline 使用
        const pipelineData = candidates.map(c => ({
            name: c.name,
            address: c.address,
            fallbackTime: c.fallbackTime
        }));
        fs.writeFileSync("trending_dogs.json", JSON.stringify(pipelineData, null, 2));
        console.log(`\n✅ Saved ${candidates.length} dogs to trending_dogs.json for pipeline.`);

    } catch (e) {
        console.error("❌ Error fetching data:", (e as any).message);
    }
}

main();