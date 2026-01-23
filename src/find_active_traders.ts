import { ethers } from "ethers";
import * as fs from "fs";
import { DATA_DIR, REMOTE_RPC_URL } from "./common";

// ================= 配置区域 =================
const CHECK_DAYS = 7; // 只看最近 7 天的操作

export async function findActiveTraders(inputCandidates?: string[]) {
    console.log("[System] Starting Active Trader Filter...");

    let candidates: string[] = inputCandidates || [];

    if (candidates.length === 0) {
        // 1. 尝试读取 verified_wallets.json
        try {
            const filePath = `${DATA_DIR}/verified_wallets.json`;
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, "utf-8");
                candidates = JSON.parse(data);
                console.log(`[System] Loaded ${candidates.length} verified wallets from file.`);
            } else {
                // Fallback to manual input if file missing
                const rawInput = "0xf1c429b0ce94ef9893ef110d2cc100201dce71c8"; // 示例
                candidates = rawInput
                    .split(/[\n,]/)
                    .map((s) => s.trim().toLowerCase())
                    .filter((s) => s.startsWith("0x"));
                console.log(`[System] Using manual input.`);
            }
        } catch (e) {
            console.log(`[System] Error reading file, using empty list.`);
        }
    }

    console.log(`Analyzing activity for ${candidates.length} whales...`);

    const provider = new ethers.providers.StaticJsonRpcProvider(REMOTE_RPC_URL);

    // 计算区块范围 (Base 2秒一个块)
    const currentBlock = await provider.getBlockNumber();
    const blocksPerDay = 43200;
    const startBlock = currentBlock - blocksPerDay * CHECK_DAYS;

    const activeHunters = [];
    const sleepingWhales = [];

    for (let i = 0; i < candidates.length; i++) {
        const wallet = candidates[i];
        process.stdout.write(
            `\r   Scanning ${i + 1}/${candidates.length}: ${wallet.slice(0, 6)}...`,
        );

        try {
            // [RPC 优化] 使用 Nonce 差值判断活跃度 (需要 Archive Node)
            // 这种方式不依赖 Alchemy SDK，且速度极快，完全解耦
            const nonceNow = await provider.getTransactionCount(wallet, "latest");
            const nonceOld = await provider.getTransactionCount(wallet, startBlock);
            
            const delta = nonceNow - nonceOld;

            if (delta > 0) {
                activeHunters.push({ address: wallet, action: `Active (+${delta} txs)` });
            } else {
                sleepingWhales.push({ address: wallet, reason: "No Tx in 7 days" });
            }
        } catch (e) {
            console.log(`\n[Error] Check failed for ${wallet}: ${(e as any).message}`);
        }
    }

    console.log(`\n\n================  TARGET LIST  ================`);
    if (activeHunters.length === 0) {
        console.log("No active hunters found in last 7 days.");
    } else {
        activeHunters.forEach((h) => {
            console.log(`[ACTIVE] ${h.address} | Last: ${h.action}`);
        });
        console.log(`\nExport for Bot:`);
        console.log(activeHunters.map((h) => h.address).join(","));
    }

    console.log(`\n================  SLEEPING WATCHLIST (SET ALERTS) ================`);
    console.log(`(Do NOT copy trade yet, wait for them to wake up)`);
    sleepingWhales.forEach((w) => {
        console.log(`${w.address}`);
    });
}

if (require.main === module) {
    findActiveTraders();
}
