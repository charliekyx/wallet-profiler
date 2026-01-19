import { Network, Alchemy, AssetTransfersCategory, SortingOrder } from "alchemy-sdk";

// ================= 配置 =================
const ALCHEMY_API_KEY = "Dy8qDdgHXfCqzP-o1Bw2X"; 
// Aerodrome V3 Router
const TARGET_ROUTER = "0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5".toLowerCase();
// 扫描过去 5 分钟 (Base 2s/block -> 150 blocks)
const SCAN_BLOCKS = 300; 

const settings = { apiKey: ALCHEMY_API_KEY, network: Network.BASE_MAINNET };
const alchemy = new Alchemy(settings);

async function main() {
    console.log("🔥 Radar scanning for LIVE EOA TRADERS (No Contracts)...");
    
    const currentBlock = await alchemy.core.getBlockNumber();
    const fromBlock = "0x" + (currentBlock - SCAN_BLOCKS).toString(16);
    console.log(`📡 Scanning blocks: ${currentBlock - SCAN_BLOCKS} -> ${currentBlock}`);

    // 1. 抓取交互
    const resp = await alchemy.core.getAssetTransfers({
        fromBlock: fromBlock,
        toAddress: TARGET_ROUTER,
        category: [AssetTransfersCategory.EXTERNAL, AssetTransfersCategory.ERC20],
        excludeZeroValue: true,
        order: SortingOrder.DESCENDING,
        maxCount: 1000
    });

    const txs = resp.transfers;
    console.log(`📊 Found ${txs.length} interactions.`);

    // 2. 统计活跃度
    const leaderboard: Record<string, number> = {};
    txs.forEach(tx => {
        const sender = (tx.from || "").toLowerCase();
        if (!leaderboard[sender]) leaderboard[sender] = 0;
        leaderboard[sender]++;
    });

    // 3. 排序
    const sortedCandidates = Object.entries(leaderboard)
        .sort((a, b) => b[1] - a[1]); // 降序

    console.log(`🔍 Verifying top candidates (Filtering out contracts)...`);

    // 4. [核心] 逐个检查是否是合约
    let bestTarget = "";
    let bestCount = 0;

    for (const [address, count] of sortedCandidates) {
        // 跳过路由器本身或其他已知合约
        if (address === TARGET_ROUTER) continue;

        // 查 Code
        const code = await alchemy.core.getCode(address);
        
        // 如果 code 是 "0x"，说明是 EOA (普通钱包)，是我们想要的
        if (code === "0x") {
            bestTarget = address;
            bestCount = count;
            console.log(`✅ FOUND EOA: ${address} (Code size: 0)`);
            break; // 找到第一个最活跃的真人就停止
        } else {
            // console.log(`❌ Skipped Contract: ${address}`);
        }
    }

    console.log(`\n================ 🎯 LIVE EOA TARGET FOUND 🎯 ================`);
    
    if (!bestTarget) {
        console.log("⚠️ No active EOA found. Try again in 1 min.");
        return;
    }

    console.log(`🥇 [BEST TARGET] ${bestTarget}`);
    console.log(`   🔥 Activity: ${bestCount} txs in last 10 mins`);
    console.log(`   👤 Type: EOA (Real Wallet)`);
    
    console.log(`\n👇 COPY THIS TO YOUR .env NOW: 👇`);
    console.log(`TARGET_WALLETS=${bestTarget}`);
    
    console.log(`\n(This is a REAL human/bot wallet initiating txs. Run Rust bot NOW!)`);
}

main();