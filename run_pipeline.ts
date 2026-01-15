import { execSync } from "child_process";
import * as fs from "fs";

function runStep(scriptName: string, stepName: string) {
    console.log(`\n==================================================`);
    console.log(`🚀 STEP: ${stepName} (${scriptName})`);
    console.log(`==================================================\n`);
    
    try {
        // 使用 npx ts-node 执行脚本，并继承 stdio 以便看到实时输出
        execSync(`npx ts-node ${scriptName}`, { stdio: "inherit" });
        console.log(`\n✅ ${stepName} Completed Successfully.`);
    } catch (e) {
        console.error(`\n❌ ${stepName} Failed.`);
        process.exit(1);
    }
}

async function main() {
    console.log(`🔥 Starting Golden Dog Hunter Pipeline 🔥`);
    console.log(`This pipeline will find trending tokens, identify early buyers, verify their wealth, and check their activity.\n`);

    // Step 1: 挖掘新金狗
    runStep("fetch_trending.ts", "Fetching Trending Tokens");

    // Step 2: 抓取早期买家 (Profile)
    // 注意：这一步会读取 Step 1 生成的 trending_dogs.json
    runStep("profile.ts", "Profiling Early Buyers");

    // Step 3: 验资 (Verify Wealth)
    // 注意：这一步会读取 Step 2 生成的 legends_base_xxxx.txt (通过 loadCandidates 逻辑)
    // 但为了更稳健，我们在 verify_wallets.ts 里加了读取 profile.ts 输出的逻辑
    runStep("verify_wallets.ts", "Verifying Wallet Wealth");

    // Step 4: 活跃度分析 (Active Traders)
    // 注意：这一步会读取 Step 3 生成的 verified_wallets.json
    runStep("find_active_traders.ts", "Filtering Active Traders");

    console.log(`\n==================================================`);
    console.log(`🎉 PIPELINE COMPLETED! 🎉`);
    console.log(`==================================================`);
    console.log(`Check the output above for the final list of ACTIVE HUNTERS.`);
}

main();