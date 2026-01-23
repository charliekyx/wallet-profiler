import * as fs from "fs";
import Moralis from "moralis";
import { DATA_DIR } from "./src/common";
import { fetchTrending } from "./src/fetch_trending";
import { profileEarlyBuyers } from "./src/profile";
import { verifyWalletWealth } from "./src/verify_wallets";
import { findActiveTraders } from "./src/find_active_traders";

process.on('uncaughtException', (error) => {
    console.error(`[Fatal] Uncaught Exception:`, error);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error(`[Fatal] Unhandled Rejection:`, reason);
    process.exit(1);
});

async function main() {
    console.log(`[System] Starting Golden Dog Hunter Pipeline`);

    // [新增] 初始化 Moralis (请替换为你的 API Key)
    // 免费 Key 获取: https://admin.moralis.io/
    try {
        await Moralis.start({ apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IjcwZGZmMmE5LWY3YjQtNDkwOC1hODFkLWI0NjU5YzcyNjI3YSIsIm9yZ0lkIjoiNDkzNjU3IiwidXNlcklkIjoiNTA3OTgyIiwidHlwZUlkIjoiOWJmYTQxYzAtODI1MC00YTI3LWE1ZmQtMGZjMTliYjZmZjA1IiwidHlwZSI6IlBST0pFQ1QiLCJpYXQiOjE3NjkxNTc1OTksImV4cCI6NDkyNDkxNzU5OX0.Ot_C_0RoOwmkiFBvmJHTMV3jKtzxhlkIGycTejMdEZg" });
        console.log("[System] Moralis initialized.");
    } catch (e) { console.log("[System] Moralis init skipped (Check API Key)."); }

    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR);
        console.log(`[System] Created data directory: ${DATA_DIR}`);
    }

    try {
        // Step 1: 挖掘新金狗
        console.log(`\n=== STEP 1: Fetching Trending Tokens ===`);
        const trendingDogs = await fetchTrending();

        // Step 2: 抓取早期买家 (Profile)
        console.log(`\n=== STEP 2: Profiling Early Buyers ===`);
        const legends = await profileEarlyBuyers(trendingDogs);

        // Step 3: 验资 (Verify Wealth)
        console.log(`\n=== STEP 3: Verifying Wallet Wealth ===`);
        const verifiedWallets = await verifyWalletWealth(legends);

        // Step 4: 活跃度分析 (Active Traders)
        console.log(`\n=== STEP 4: Filtering Active Traders ===`);
        await findActiveTraders(verifiedWallets);

        console.log(`\n==================================================`);
        console.log(`[System] PIPELINE COMPLETED!`);
        console.log(`==================================================`);
    } catch (e) {
        console.error(`[Error] Pipeline failed:`, e);
    }
}

main();