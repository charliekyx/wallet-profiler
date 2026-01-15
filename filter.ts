import { ethers } from 'ethers';
import * as fs from 'fs';

// ================= [Filter Configuration] =================

const RPC_URL = 'http://127.0.0.1:8545'; 

const CONFIG = {
    // [阈值 1] Nonce (总交易数)
    // 超过这个数通常是 交易所热钱包 或 长期运行的 Arb Bot
    MAX_NONCE: 10000, 

    // [阈值 2] 近期活跃窗口 (天)
    // 检查最近 N 天的表现
    RECENT_WINDOW_DAYS: 7,

    // [阈值 3] 近期交易量范围 (Tx Count in Window)
    // 少于 MIN: 死号/休眠号 (跟单没意义)
    // 多于 MAX: 高频 Bot (跟单会亏死 Gas)
    MIN_RECENT_TXS: 1, 
    MAX_RECENT_TXS: 150, // 平均每天允许 20 多笔，超过这个大概率是疯狗 Bot
};

// 填入你 V3 脚本跑出来的地址，或者读取文件
// 这里示例填入几个，实际使用时脚本会自动读取 saved file
const MANUAL_CANDIDATES: string[] = [
    // 在这里粘贴你抓到的那 107 个地址，或者留空让脚本读取文件
];

// ================= [Core Logic] =================

async function main() {
    // 检查 ethers 是否加载成功
    if (!ethers || !ethers.providers) {
        console.error("[Fatal] ethers 库加载失败。请确保安装了 ethers v5");
        process.exit(1);
    }

    console.log(`\n[System] 🧹 Wallet Filter System (Bot Remover)`);
    console.log(`[System] Node: ${RPC_URL}`);
    
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    
    // 1. 获取候选名单 (优先读取本地文件，没有则使用上方数组)
    let candidates = await loadCandidates();
    if (candidates.length === 0) {
        console.log(`[Warn] No candidates found in file. Using manual list...`);
        candidates = MANUAL_CANDIDATES;
    }
    
    // 去重
    candidates = [...new Set(candidates.map(a => a.toLowerCase()))];
    console.log(`[System] Loaded ${candidates.length} unique candidates for auditing.\n`);

    const passedWallets: string[] = [];

    // 2. 逐个审计
    for (let i = 0; i < candidates.length; i++) {
        const wallet = candidates[i];
        process.stdout.write(`[${i + 1}/${candidates.length}] Auditing ${wallet.slice(0, 8)}... `);
        
        const result = await auditWallet(provider, wallet);
        
        if (result.pass) {
            console.log(`✅ PASS | ${result.reason}`);
            passedWallets.push(wallet);
        } else {
            console.log(`❌ FAIL | ${result.reason}`);
        }
    }

    // 3. 输出清洗后的名单
    exportCleanList(passedWallets);
}

// --- 审计核心函数 ---
async function auditWallet(provider: ethers.providers.JsonRpcProvider, address: string) {
    try {
        // [Check 1] 是否是合约 (Smart Contract)
        const code = await provider.getCode(address);
        if (code !== '0x') {
            return { pass: false, reason: "Is Contract (Not EOA)" };
        }

        // [Check 2] Nonce 检查 (历史总交易量)
        const nonce = await provider.getTransactionCount(address);
        if (nonce > CONFIG.MAX_NONCE) {
            return { pass: false, reason: `Nonce too high (${nonce}) - Likely Exchange/Bot` };
        }
        if (nonce < 1) { 
             return { pass: false, reason: `Nonce too low (${nonce}) - Newbie/Burner` };
        }

        // [Check 3] 近期活跃度 (Log Scanning)
        // 扫描最近 3 天的 Transfer 事件 (发送或接收)
        const currentBlock = await provider.getBlockNumber();
        const blocksPerDay = 43200; // Base ~2s block
        const startBlock = currentBlock - (blocksPerDay * CONFIG.RECENT_WINDOW_DAYS);
        
        // 我们只查 "Transfer" 事件作为活跃度指标 (最轻量)
        // topic0 = Transfer, topic1 = from (spending), topic2 = to (receiving)
        // 只要这个地址出现在 topic1 或 topic2 里，就算活跃
        const transferTopic = ethers.utils.id("Transfer(address,address,uint256)");
        const hexAddress = ethers.utils.hexZeroPad(address, 32);

        // 并行查询 Send 和 Receive (Base op-geth 索引很快)
        const [logsFrom, logsTo] = await Promise.all([
            provider.getLogs({
                fromBlock: startBlock,
                toBlock: 'latest',
                topics: [transferTopic, hexAddress] // Sent
            }),
            provider.getLogs({
                fromBlock: startBlock,
                toBlock: 'latest',
                topics: [transferTopic, null, hexAddress] // Received
            })
        ]);

        const totalRecentTxs = logsFrom.length + logsTo.length;

        if (totalRecentTxs < CONFIG.MIN_RECENT_TXS) {
            return { pass: false, reason: `Inactive (${totalRecentTxs} txs in ${CONFIG.RECENT_WINDOW_DAYS}d)` };
        }

        if (totalRecentTxs > CONFIG.MAX_RECENT_TXS) {
            return { pass: false, reason: `High Freq Bot (${totalRecentTxs} txs in ${CONFIG.RECENT_WINDOW_DAYS}d)` };
        }

        // [Pass] 
        return { 
            pass: true, 
            reason: `Human Behavior (Nonce: ${nonce}, Recent: ${totalRecentTxs})` 
        };

    } catch (e) {
        return { pass: false, reason: `RPC Error` };
    }
}

// --- 辅助：自动读取最新的 legends 文件 ---
async function loadCandidates(): Promise<string[]> {
    const files = fs.readdirSync('.');
    // 找最新的 legends_base_xxxx.txt
    const legendFiles = files.filter(f => f.startsWith('legends_base_') && f.endsWith('.txt'));
    
    if (legendFiles.length === 0) return [];
    
    // 排序取最新的
    legendFiles.sort().reverse();
    const targetFile = legendFiles[0];
    console.log(`[System] Reading candidates from ${targetFile}`);
    
    const content = fs.readFileSync(targetFile, 'utf-8');
    const wallets: string[] = [];
    
    // 解析文件行 [💎 2 Legends] 0x... | Bags: ...
    const lines = content.split('\n');
    for (const line of lines) {
        const match = line.match(/0x[a-fA-F0-9]{40}/);
        if (match) {
            wallets.push(match[0]);
        }
    }
    return wallets;
}

function exportCleanList(wallets: string[]) {
    console.log(`\n================ 🧬 VERIFIED HUMANS (${wallets.length}) 🧬 ================`);
    
    if (wallets.length === 0) {
        console.log("⚠️ No wallets passed the filter.");
        return;
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `verified_humans_${dateStr}.txt`;
    
    // 格式化输出
    const output = wallets.join(',');
    fs.writeFileSync(fileName, output); // 方便直接复制到 .env
    
    // 同时保存一个可读列表
    const readable = wallets.join('\n');
    fs.writeFileSync(fileName.replace('.txt', '_list.txt'), readable);

    console.log(`✅ Saved clean list to ${fileName}`);
    console.log(`👉 Copy this to your .env:\n`);
    console.log(`TARGET_WALLETS=${output}`);
}

main().catch(console.error);