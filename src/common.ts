import * as path from "path";
import Moralis from "moralis";

// 使用 path.resolve 确保路径是绝对路径，避免因运行目录不同导致找不到文件
export const DATA_DIR = path.resolve(__dirname, "../data");
export const BLACKLIST_FILE = path.join(DATA_DIR, "blacklist.json");

export const LOCAL_RPC_URL = "http://127.0.0.1:8545";
// export const ALCHEMY_API_KEY = "https://base-mainnet.g.alchemy.com/v2/Dy8qDdgHXfCqzP-o1Bw2X";
export const REMOTE_RPC_URL = `https://base-mainnet.infura.io/v3/d424eb23626d4adfade73a662f9d2f19`;;

export const PROFILE_CONFIG = {
    MIN_HIT_COUNT: 1,
    GENESIS_WINDOW_BLOCKS: 7200, // [Mode A] 4 Hours (Base ~2s block)
    SWING_WINDOW_BLOCKS: 43200, // [Mode B] 24 Hours (大幅缩短以适应 Free Tier)
    LOOKBACK_BUFFER_BLOCKS: 3000,
    FILTER_MAX_TOTAL_NONCE: 15000,
    FILTER_RECENT_DAYS: 7,
    FILTER_MIN_WEEKLY_TXS: 2,
    FILTER_MAX_WEEKLY_TXS: 150, // [优化] 下调至 150 (约 20 tx/day)，过滤高频 Bot/Spammer
    MIN_PNL_MULTIPLIER: 2.0,

    // [加速配置]
    VERIFY_BATCH_SIZE: 50, // [付费版优化] 提升并发验证数 (4000 CU/s 足够支撑)
    CONCURRENT_TOKENS: 10, // [付费版优化] 同时处理更多 Token
    RPC_CHUNK_SIZE: 10000, // [付费版优化] 大幅增加日志查询范围 (减少请求次数)
};

// Base 常见 DEX 路由地址 (用于识别 Legit Sell)
export const DEX_ROUTERS = new Set([
    "0x2626664c2603336e57b271c5c0b26f421741e481", // Uniswap V3
    "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad58", // Uniswap V2
    "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43", // Aerodrome Universal

    "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad", // Universal Router
    "0x1111111254fb6c44bac0bed2854e76f90643097d", // 1inch
    "0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5", // Aerodrome Slipstream (V3)

    // [新增] 对应 Rust 策略中的其他 DEX
    "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86", // BaseSwap V2
    "0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7", // AlienBase V2
    "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891", // SushiSwap V2
    "0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86", // PancakeSwap V3 Router
    "0x04C9f17463a2E8eD375772F412171b963d984531", // SwapBased V2
    "0x4cf76043B3f97ba06917cBd90F9e3A2AFcdb1B78", // RocketSwap V2

    // [Rust Sync] 同步 Rust constants.rs 中的地址 (防止误杀)
    "0x2948acbbc8795267e62a1220683a48e718b52585", // BaseSwap (Rust)
    "0x1b81D678ffb9C0263b24A97847620C99d213eB14", // PancakeSwap V3 (Rust)
    "0xaaa3b1F1bd7BCc97fD1917c18ade665C5D31F066", // SwapBased (Rust)
    "0x4cf76043B3f97ba06917cBd90F9e3A2AFcd1aCd0", // RocketSwap (Rust)
    "0x743f2f29cdd66242fb27d292ab2cc92f45674635", // Universal Router (Rust)
    "0x8d0d118070b728e104294471fbe93c2e3affd694", // Odos Router
    "0x663dc15d3c1ac63ff12e45ab68fea3f0a883c251", // deBridge
    "0xc479b79e53c1065e5e56a6da78e9d634b4ae1e5d", // Virtuals Protocol (Factory/Router)
    "0x498581fF718922c3f8e6A244956aF099B2652b2b", // Uniswap V4 Pool Manager
]);

export interface TrendingToken {
    name: string;
    address: string;
    fallbackTime: number;
    ageHours?: string;
    volume?: number;
    liquidity?: number;
}

// [新增] Moralis PnL 检查器 (GMGN 风格逻辑)
export async function checkWalletPnL(address: string): Promise<boolean> {
    try {
        // 调用 Moralis 获取钱包盈利概况 (支持 Base 链)
        // 注意：需确保 main.ts 中已调用 Moralis.start()
        const response = await Moralis.EvmApi.wallets.getWalletProfitabilitySummary({
            chain: "0x2105", // Base Chain ID (8453 in hex)
            address: address,
        });

        const data = response.raw;
        
        // Moralis 返回的字段
        const realizedProfit = parseFloat(data.total_realized_profit_usd || "0");
        const buys = Number(data.total_buys || 0);
        const sells = Number(data.total_sells || 0);

        // 【GMGN 逻辑复刻】
        // 1. 必须是正收益 (Realized PnL > 0)
        // 2. 必须有交易活跃度 (Buys + Sells > 5)
        if (realizedProfit > 0 && (buys + sells) > 5) {
            return true; 
        }
        
        return false;
    } catch (e) {
        // 如果 API 报错或超限，默认放行 (Fail Open)，以免误杀
        // console.log("Moralis check failed, skipping PnL check");
        return true; 
    }
}