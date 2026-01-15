import { ethers } from 'ethers';
import * as fs from 'fs';

// ================= [Filter Configuration V2] =================

const RPC_URL = 'http://127.0.0.1:8545'; 

const CONFIG = {
    // [硬指标 1] 历史总交易数 (Total Nonce)
    // Base 链才不到2年，普通人手动操作很难超过 3000 次
    // 调低这个阈值，直接过滤老牌 Bot
    MAX_TOTAL_NONCE: 5000, 

    // [硬指标 2] 近期活跃窗口 (天)
    RECENT_WINDOW_DAYS: 7,

    // [硬指标 3] 窗口内的实际交易笔数 (Real Tx Count)
    // 包含了：转账、Swap、调用合约、失败的交易、取消的交易
    // 这是最真实的活跃度指标
    MIN_WEEKLY_TXS: 0,    // [Modified] 暂时允许不活跃，寻找钻石手
    MAX_WEEKLY_TXS: 200,   // [Modified] 放宽高频限制
};

// ================= [Core Logic] =================

async function main() {
    // 检查 ethers 是否加载成功
    if (!ethers || !ethers.providers) {
        console.error("[Fatal] ethers 库加载失败。请确保安装了 ethers v5");
        process.exit(1);
    }

    console.log(`\n[System] 🧹 Wallet Filter System V2 (Nonce Delta Edition)`);
    console.log(`[System] Node: ${RPC_URL}`);
    
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    
    // 1. 检查节点连接 & 获取当前区块
    let currentBlock = 0;
    try {
        currentBlock = await provider.getBlockNumber();
        console.log(`[System] Current Block: ${currentBlock}`);
    } catch (e) {
        console.error(`[Fatal] Cannot connect to RPC.`);
        process.exit(1);
    }

    // 2. 加载名单
    let candidates = await loadCandidates();
    // 如果文件没读到，使用测试用的 Manual List
    if (candidates.length === 0) {
        // 这里为了方便你测试，我把你提到的那个 Bot 放进去，看看能不能杀掉
        candidates = ["0x404e927b203375779a6abd52a2049ce0adf6609b"];
        console.log(`[Test] Using manual candidate for testing...`);
    }
    
    candidates = [...new Set(candidates.map(a => a.toLowerCase()))];
    console.log(`[System] Auditing ${candidates.length} candidates...\n`);

    const passedWallets: string[] = [];
    const blocksPerDay = 43200; // Base ~2s/block
    const startBlock = currentBlock - (blocksPerDay * CONFIG.RECENT_WINDOW_DAYS);

    // 3. 逐个审计
    for (let i = 0; i < candidates.length; i++) {
        const wallet = candidates[i];
        process.stdout.write(`[${i + 1}/${candidates.length}] ${wallet.slice(0, 8)}... `);
        
        const result = await auditWallet(provider, wallet, startBlock, currentBlock);
        
        if (result.pass) {
            console.log(`✅ PASS | ${result.reason}`);
            passedWallets.push(wallet);
        } else {
            console.log(`❌ FAIL | ${result.reason}`);
        }
    }

    // 4. 输出
    exportCleanList(passedWallets);
}

// --- 审计核心函数 (V2: Delta Nonce) ---
async function auditWallet(
    provider: ethers.providers.JsonRpcProvider, 
    address: string,
    pastBlock: number,
    currentBlock: number
) {
    try {
        // [Check 1] 是否是合约
        const code = await provider.getCode(address);
        if (code !== '0x') return { pass: false, reason: "Is Contract" };

        // [Check 2] 现在的 Nonce (Total)
        const nonceNow = await provider.getTransactionCount(address, currentBlock);
        
        if (nonceNow > CONFIG.MAX_TOTAL_NONCE) {
            return { pass: false, reason: `Total Nonce High (${nonceNow} > ${CONFIG.MAX_TOTAL_NONCE})` };
        }
        if (nonceNow < 2) {
            return { pass: false, reason: `Total Nonce Low (${nonceNow})` };
        }

        // [Check 3] 7天前的 Nonce (Past)
        // 这是一个非常强大的 RPC 技巧，查看过去的快照
        const noncePast = await provider.getTransactionCount(address, pastBlock);
        
        // 计算差值：这就是过去 7 天他真实发出的交易总数 (不管成功失败，不管是否有 Log)
        const deltaNonce = nonceNow - noncePast;

        if (deltaNonce < CONFIG.MIN_WEEKLY_TXS) {
            return { pass: false, reason: `Inactive (${deltaNonce} txs in 7d)` };
        }

        if (deltaNonce > CONFIG.MAX_WEEKLY_TXS) {
            // 如果一周发了 100+ 笔交易，肯定是 Bot 或者疯狗
            return { pass: false, reason: `High Freq (${deltaNonce} txs in 7d)` };
        }

        return { 
            pass: true, 
            reason: `Human (Total: ${nonceNow}, 7d-Activity: ${deltaNonce})` 
        };

    } catch (e) {
        return { pass: false, reason: `RPC Error` };
    }
}

async function loadCandidates(): Promise<string[]> {
    const files = fs.readdirSync('.');
    const legendFiles = files.filter(f => f.startsWith('legends_base_') && f.endsWith('.txt'));
    if (legendFiles.length === 0) return [];
    legendFiles.sort().reverse();
    const targetFile = legendFiles[0];
    console.log(`[System] Reading candidates from ${targetFile}`);
    const content = fs.readFileSync(targetFile, 'utf-8');
    const wallets: string[] = [];
    const lines = content.split('\n');
    for (const line of lines) {
        const match = line.match(/0x[a-fA-F0-9]{40}/);
        if (match) wallets.push(match[0]);
    }
    return wallets;
}

function exportCleanList(wallets: string[]) {
    console.log(`\n================ 🧬 HUMAN VERIFIED (${wallets.length}) 🧬 ================`);
    if (wallets.length === 0) {
        console.log("⚠️ All candidates were filtered out.");
    } else {
        const output = wallets.join(',');
        const dateStr = new Date().toISOString().slice(0, 10);
        const fileName = `verified_humans_${dateStr}.txt`;
        fs.writeFileSync(fileName, output);
        
        // 同时保存一个可读列表
        const readable = wallets.join('\n');
        fs.writeFileSync(fileName.replace('.txt', '_list.txt'), readable);

        console.log(`✅ Saved clean list to ${fileName}`);
        console.log(`👉 TARGET_WALLETS=${output}`);
    }
}

main().catch(console.error);