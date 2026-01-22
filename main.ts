import * as fs from "fs";
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