import axios from "axios";
import * as fs from "fs";

// ================= 配置区域 =================
const CONFIG = {
    CHAIN: "base",
    
    // [保持] 30天，允许老金狗进入
    MAX_AGE_HOURS: 720,      
    
    // [门槛] 保持适中
    MIN_LIQUIDITY_USD: 10000, 
    MIN_VOLUME_24H: 5000,   
    MIN_FDV: 10000,          

    // [新增] 抓取深度：抓取前 10 页 (约 200 个池子) - 免费版 API 上限
    // 只有抓得够深，才能在第 50-100 名里找到那些上线了 15-30 天的老币
    FETCH_PAGES: 10,
};

// [新增] 手动注入的老金狗名单 (Base 链上的蓝筹 Meme)
// 这些币经历了时间的考验，持有者通常质量很高，必须包含在内
const HARDCODED_DOGS = [
    { name: "BRETT", address: "0x532f27101965dd16442e59d40670faf5ebb142e4" },
    { name: "TOSHI", address: "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4" },
    { name: "DEGEN", address: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed" },
    { name: "KEYCAT", address: "0x9a26f5433671751c3276a065f57e5a02d281797d" },
    { name: "MOG", address: "0x2Da56AcB9Ea78330f947bD57C54119Debda7AF71" },
    { name: "VIRTUAL", address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b" },
    { name: "HIGHER", address: "0x0578d8d485ebb2720521fb692b012495a070e3ed" }
];

async function main() {
    console.log(`🚀 Starting GeckoTerminal Trend Hunter (Deep Dive)...`);
    console.log(`🎯 Chain: ${CONFIG.CHAIN} | Depth: ${CONFIG.FETCH_PAGES} Pages | Max Age: ${CONFIG.MAX_AGE_HOURS}h`);

    try {
        let allPools: any[] = [];
        
        // ================= [新增] 分页抓取逻辑 =================
        for (let page = 1; page <= CONFIG.FETCH_PAGES; page++) {
            process.stdout.write(`📡 Fetching page ${page}/${CONFIG.FETCH_PAGES}... `);
            const url = `https://api.geckoterminal.com/api/v2/networks/${CONFIG.CHAIN}/trending_pools?include=base_token&page=${page}`;
            
            try {
                const response = await axios.get(url, { 
                    timeout: 10000,
                    headers: { "User-Agent": "Mozilla/5.0" } // 防止被拦截
                });
                
                if (response.data && response.data.data) {
                    const pools = response.data.data;
                    allPools = allPools.concat(pools);
                    console.log(`✅ Found ${pools.length} pools.`);
                } else {
                    console.log(`⚠️ No data.`);
                }
                
                // 礼貌等待，防止触发 API 限制 (30 req/min)
                await new Promise(r => setTimeout(r, 1500));
                
            } catch (e) {
                console.log(`❌ Error fetching page ${page}: ${(e as any).message}`);
            }
        }
        // ========================================================

        console.log(`\n🌊 Total candidates fetched: ${allPools.length}. Filtering...`);

        const now = Date.now();
        const candidates = [];
        const seenAddresses = new Set<string>();

        // 1. 处理 API 数据
        for (const pool of allPools) {
            const attr = pool.attributes;

            // A. 数据完整性检查
            if (!attr.pool_created_at || !pool.relationships?.base_token?.data?.id) continue;

            // B. 获取 Token 地址
            const baseTokenId = pool.relationships.base_token.data.id;
            // 统一转小写以便去重
            const tokenAddress = (baseTokenId.includes("_") ? baseTokenId.split("_")[1] : baseTokenId).trim().toLowerCase();
            
            // 去重
            if (seenAddresses.has(tokenAddress)) continue;
            seenAddresses.add(tokenAddress);

            // C. 核心指标过滤
            const liquidity = parseFloat(attr.reserve_in_usd || "0");
            const volume24h = parseFloat(attr.volume_usd?.h24 || "0");
            const fdv = parseFloat(attr.fdv_usd || "0");
            const name = attr.name.split(" / ")[0];

            // 排除干扰项
            if (["USDC", "USDT", "DAI", "WETH", "cbBTC"].includes(name)) continue;
            if (liquidity < CONFIG.MIN_LIQUIDITY_USD) continue;
            if (volume24h < CONFIG.MIN_VOLUME_24H) continue;
            if (fdv < CONFIG.MIN_FDV) continue;

            // D. 时间过滤
            const createdAt = new Date(attr.pool_created_at).getTime();
            const ageHours = (now - createdAt) / (1000 * 60 * 60);
            
            if (ageHours > CONFIG.MAX_AGE_HOURS) continue;

            candidates.push({
                name: name,
                address: tokenAddress,
                ageHours: ageHours.toFixed(1),
                liquidity: liquidity,
                volume: volume24h,
                pairCreatedAt: Math.floor(createdAt / 1000),
                fallbackTime: Math.floor(createdAt / 1000)
            });
        }

        // 2. 注入 Hardcoded Dogs (如果 API 没抓到)
        console.log(`\n💉 Injecting ${HARDCODED_DOGS.length} legendary dogs...`);
        for (const dog of HARDCODED_DOGS) {
            const addr = dog.address.toLowerCase();
            if (!seenAddresses.has(addr)) {
                // 模拟一个 candidate 对象
                // 注意：这里 fallbackTime 设为 0，会触发 profile.ts 去 DexScreener 查真实创建时间
                candidates.push({
                    name: dog.name,
                    address: addr,
                    ageHours: "999", // 标记为老狗
                    liquidity: 999999, // 假装很高，确保排序靠前
                    volume: 999999,
                    pairCreatedAt: 0, 
                    fallbackTime: 0 
                });
                seenAddresses.add(addr);
                console.log(`   + Added ${dog.name}`);
            } else {
                console.log(`   = ${dog.name} already in list.`);
            }
        }

        // 3. 排序 (按成交量降序)
        candidates.sort((a, b) => b.volume - a.volume);

        // 4. 输出结果
        console.log(`\n================ 💎 FINAL TARGET LIST (${candidates.length}) ================`);
        
        // 只取前 50 个最优质的，避免太长
        const topCandidates = candidates.slice(0, 50);
        
        topCandidates.forEach((c, index) => {
            console.log(`\n#${index + 1} [${c.name}]`);
            console.log(`   Contract: ${c.address}`);
            console.log(`   Age: ${c.ageHours} hrs | Vol: $${(c.volume/1000).toFixed(1)}k`);
        });

        // 5. 保存文件
        const pipelineData = topCandidates.map(c => ({
            name: c.name,
            address: c.address,
            fallbackTime: c.fallbackTime
        }));
        fs.writeFileSync("trending_dogs.json", JSON.stringify(pipelineData, null, 2));
        console.log(`\n✅ Saved ${topCandidates.length} dogs to trending_dogs.json for pipeline.`);

    } catch (e) {
        console.error("❌ Fatal Error:", (e as any).message);
    }
}

main();
