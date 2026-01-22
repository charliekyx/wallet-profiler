import { Network, Alchemy, AssetTransfersCategory, SortingOrder } from "alchemy-sdk";
import * as fs from "fs";
import { ethers } from "ethers";
import { DATA_DIR, ALCHEMY_API_KEY, DEX_ROUTERS } from "./common";

// ================= 配置区域 =================
const CHECK_DAYS = 7; // 只看最近 7 天的操作

const settings = {
    apiKey: ALCHEMY_API_KEY,
    network: Network.BASE_MAINNET,
};
const alchemy = new Alchemy(settings);

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

    // 计算区块范围 (Base 2秒一个块)
    const currentBlock = await alchemy.core.getBlockNumber();
    const blocksPerDay = 43200;
    const fromBlock = "0x" + (currentBlock - blocksPerDay * CHECK_DAYS).toString(16);

    const activeHunters = [];
    const sleepingWhales = [];

    for (let i = 0; i < candidates.length; i++) {
        const wallet = candidates[i];
        process.stdout.write(
            `\r   Scanning ${i + 1}/${candidates.length}: ${wallet.slice(0, 6)}...`,
        );

        // 查询该钱包发出的交易 (External + ERC20)
        const resp = await alchemy.core.getAssetTransfers({
            fromBlock: fromBlock,
            fromAddress: wallet,
            category: [AssetTransfersCategory.EXTERNAL, AssetTransfersCategory.ERC20],
            excludeZeroValue: true,
            order: SortingOrder.DESCENDING, // 最新的在前
            maxCount: 20, // 只看最近 20 笔，足够判断了
        });

        const txs = resp.transfers;

        if (txs.length === 0) {
            sleepingWhales.push({ address: wallet, reason: "No Tx in 7 days" });
            continue;
        }

        let isHunter = false;
        let lastAction = "";

        // 分析交易行为
        for (const tx of txs) {
            const to = (tx.to || "").toLowerCase();

            // 行为 1: 给 DEX Router 发 ETH 或 Token -> 这是一个 Swap 信号
            if (DEX_ROUTERS.has(to)) {
                isHunter = true;
                lastAction = `Swapped on DEX (${tx.asset})`;
                break;
            }

            // 行为 2: 转出 USDT/USDC/ETH 到普通合约 (可能是买土狗)
            if (["USDC", "USDT", "ETH", "WETH"].includes(tx.asset || "") && !DEX_ROUTERS.has(to)) {
                // 这里可以进一步调 API 查 to 是不是 Token 合约，为了速度暂且放宽
                isHunter = true;
                lastAction = `Sent ${tx.asset} (Potential Buy)`;
                break;
            }
        }

        if (isHunter) {
            activeHunters.push({ address: wallet, action: lastAction });
        } else {
            sleepingWhales.push({ address: wallet, reason: "Only passive transfers / No buys" });
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
