const fs = require("fs");
const path = require("path");
const axios = require("axios");
const colors = require("colors");
const readline = require("readline");
const { Web3 } = require("web3");
const { HttpsProxyAgent } = require("https-proxy-agent");
const settings = require("./config/config");
const { sleep, loadData, getRandomNumber, saveToken, isTokenExpired, saveJson, updateEnv } = require("./utils");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

const contractABI = [
  {
    inputs: [],
    name: "claimReward",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

const bridgeABI = [
  {
    inputs: [
      {
        internalType: "uint32",
        name: "destinationNetwork",
        type: "uint32",
      },
      {
        internalType: "address",
        name: "destinationAddress",
        type: "address",
      },
      {
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
      {
        internalType: "address",
        name: "token",
        type: "address",
      },
      {
        internalType: "bool",
        name: "forceUpdateGlobalExitRoot",
        type: "bool",
      },
      {
        internalType: "bytes",
        name: "permitData",
        type: "bytes",
      },
    ],
    name: "bridgeAsset",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
];

const CONTRACT_ADDRESS = "0xa18f6FCB2Fd4884436d10610E69DB7BFa1bFe8C7";
const RPC_URL = "https://rpc.testnet.humanity.org/";
const MIN_GAS_PRICE = "1000000000";

class HumanityClient {
  constructor(queryId, accountIndex, proxy, wallets) {
    this.web3 = new Web3(new Web3.providers.HttpProvider(RPC_URL));
    this.contract = new this.web3.eth.Contract(contractABI, CONTRACT_ADDRESS);
    this.proxy = proxy;
    this.queryId = queryId;
    this.accountIndex = accountIndex;
    this.proxyIP = null;
    this.session_name = null;
    this.wallets = wallets;
    this.headers = {
      accept: "*/*",
      "accept-encoding": "gzip, deflate, br, zstd",
      "accept-language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
      "content-type": "application/json",
      origin: "https://faucet.testnet.humanity.org",
      referer: "https://faucet.testnet.humanity.org/",
      "sec-ch-ua": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    };
  }

  setProxy(proxy) {
    this.proxy = proxy;
  }

  async checkProxyIP(proxy) {
    try {
      const proxyAgent = new HttpsProxyAgent(proxy);
      const response = await axios.get("https://api.ipify.org?format=json", {
        httpsAgent: proxyAgent,
        timeout: 10000,
      });

      if (response.status === 200) {
        return response.data.ip;
      } else {
        throw new Error(`Không thể kiểm tra IP của proxy. Status code: ${response.status}`);
      }
    } catch (error) {
      this.log(`Error khi kiểm tra IP của proxy: ${error.message}`, "error");
      return "Unknown";
    }
  }

  async makeRequest(url, method = "get", data = null) {
    const config = {
      method,
      url,
      headers: this.headers,
      httpsAgent: this.proxy ? new HttpsProxyAgent(this.proxy) : undefined,
      timeout: 30000,
    };

    if (data) {
      config.data = data;
    }

    return axios(config);
  }

  log(msg, type = "info") {
    const timestamp = new Date().toLocaleTimeString();
    switch (type) {
      case "success":
        console.log(`[${timestamp}] [✓] ${msg}`.green);
        break;
      case "custom":
        console.log(`[${timestamp}] [*] ${msg}`.magenta);
        break;
      case "error":
        console.log(`[${timestamp}] [✗] ${msg}`.red);
        break;
      case "warning":
        console.log(`[${timestamp}] [!] ${msg}`.yellow);
        break;
      default:
        console.log(`[${timestamp}] [ℹ] ${msg}`.blue);
    }
  }

  async countdown(seconds) {
    for (let i = seconds; i > 0; i--) {
      const timestamp = new Date().toLocaleTimeString();
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(`[${timestamp}] [*] Chờ ${i} giây để tiếp tục...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
  }

  async claimTHP(address) {
    const url = "https://faucet.testnet.humanity.org/api/claim";
    const payload = { address };

    try {
      const response = await this.makeRequest(url, "post", payload);
      if (response.status === 200 && response.data.msg) {
        const txHash = response.data.msg.split("Txhash: ")[1];
        return { success: true, txHash };
      } else {
        return { success: false, error: "Invalid response format" };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getBalance(address) {
    try {
      const balance = await this.web3.eth.getBalance(address);
      return this.web3.utils.fromWei(balance, "ether");
    } catch (error) {
      return "0";
    }
  }

  async getSafeGasPrice() {
    try {
      const gasPrice = await this.web3.eth.getGasPrice();
      const safeGasPrice = Math.max(Number(gasPrice), Number(MIN_GAS_PRICE)).toString();

      return Math.floor(Number(safeGasPrice) * 1.2).toString();
    } catch (error) {
      return MIN_GAS_PRICE;
    }
  }

  async claimReward(privateKey, address) {
    try {
      const formattedPrivateKey = privateKey.trim();
      const finalPrivateKey = formattedPrivateKey.startsWith("0x") ? formattedPrivateKey : `0x${formattedPrivateKey}`;

      const balance = await this.getBalance(address);
      if (parseFloat(balance) < 0.001) {
        return { success: false, error: `Insufficient balance: ${balance} THP` };
      }

      const gasPrice = await this.getSafeGasPrice();
      this.log(`Using gas price: ${this.web3.utils.fromWei(gasPrice, "gwei")} gwei`, "custom");

      const account = this.web3.eth.accounts.privateKeyToAccount(finalPrivateKey);
      this.web3.eth.accounts.wallet.add(account);

      try {
        await this.contract.methods.claimReward().call({ from: address });
      } catch (error) {
        if (error.message.includes("revert")) {
          return { success: false, error: "Reward not available or already claimed" };
        }
      }

      let gasLimit;
      try {
        gasLimit = await this.contract.methods.claimReward().estimateGas({
          from: address,
          gasPrice: gasPrice,
        });
        gasLimit = Math.floor(Number(gasLimit) * 1.2).toString();
      } catch (error) {
        this.log("Ước tính gas không thành công, sử dụng mặc định", "warning");
        gasLimit = "300000";
      }

      const tx = {
        from: address,
        to: CONTRACT_ADDRESS,
        gas: gasLimit,
        gasPrice: gasPrice,
        data: this.contract.methods.claimReward().encodeABI(),
        nonce: await this.web3.eth.getTransactionCount(address),
      };

      this.log(`Transaction details:`, "custom");
      this.log(`Gas Price: ${this.web3.utils.fromWei(gasPrice, "gwei")} gwei`, "custom");
      this.log(`Gas Limit: ${gasLimit}`, "custom");
      this.log(`Nonce: ${tx.nonce}`, "custom");

      const signedTx = await this.web3.eth.accounts.signTransaction(tx, finalPrivateKey);
      const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);

      if (receipt.status) {
        return { success: true, txHash: receipt.transactionHash };
      } else {
        return { success: false, error: "Transaction failed" };
      }
    } catch (error) {
      if (error.message.includes("revert")) {
        const reason = await this.getRevertReason(error);
        return { success: false, error: `Transaction reverted: ${reason}` };
      }

      this.log(`Detailed error: ${error.message}`, "error");
      return { success: false, error: `Transaction failed: ${error.message}` };
    }
  }

  async getRevertReason(error) {
    try {
      if (error.data) {
        const reason = this.web3.eth.abi.decodeParameter("string", error.data);
        return reason;
      }
    } catch (e) {
      return "Unknown reason";
    }
    return "Unknown reason";
  }

  async bridgeAssets(privateKey, address) {
    try {
      const BRIDGE_CONTRACT = "0x5F7CaE7D1eFC8cC05da97D988cFFC253ce3273eF";
      const bridgeContract = new this.web3.eth.Contract(bridgeABI, BRIDGE_CONTRACT);

      const formattedPrivateKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;

      const balance = await this.getBalance(address);
      if (parseFloat(balance) < 1.1) {
        return { success: false, error: `Insufficient balance: ${balance} ETH` };
      }

      const gasPrice = await this.getSafeGasPrice();
      this.log(`Using gas price: ${this.web3.utils.fromWei(gasPrice, "gwei")} gwei`, "custom");

      const account = this.web3.eth.accounts.privateKeyToAccount(formattedPrivateKey);
      this.web3.eth.accounts.wallet.add(account);

      const params = {
        destinationNetwork: 0,
        destinationAddress: address,
        amount: "1000000000000000000",
        token: "0x0000000000000000000000000000000000000000",
        forceUpdateGlobalExitRoot: true,
        permitData: "0x",
      };

      let gasLimit;
      try {
        gasLimit = await bridgeContract.methods
          .bridgeAsset(params.destinationNetwork, params.destinationAddress, params.amount, params.token, params.forceUpdateGlobalExitRoot, params.permitData)
          .estimateGas({
            from: address,
            value: params.amount,
          });
        gasLimit = Math.floor(Number(gasLimit) * 1.2).toString();
      } catch (error) {
        this.log("Ước tính gas không thành công, sử dụng mặc định", "warning");
        gasLimit = "300000";
      }

      const tx = {
        from: address,
        to: BRIDGE_CONTRACT,
        gas: gasLimit,
        gasPrice: gasPrice,
        value: params.amount,
        data: bridgeContract.methods.bridgeAsset(params.destinationNetwork, params.destinationAddress, params.amount, params.token, params.forceUpdateGlobalExitRoot, params.permitData).encodeABI(),
        nonce: await this.web3.eth.getTransactionCount(address),
      };

      this.log(`Transaction details:`, "custom");
      this.log(`Bridge Amount: ${this.web3.utils.fromWei(params.amount, "ether")} ETH`, "custom");
      this.log(`Gas Price: ${this.web3.utils.fromWei(gasPrice, "gwei")} gwei`, "custom");
      this.log(`Gas Limit: ${gasLimit}`, "custom");
      this.log(`Destination Address: ${params.destinationAddress}`, "custom");
      this.log(`Nonce: ${tx.nonce}`, "custom");

      const signedTx = await this.web3.eth.accounts.signTransaction(tx, formattedPrivateKey);
      const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);

      if (receipt.status) {
        return { success: true, txHash: receipt.transactionHash };
      } else {
        return { success: false, error: "Transaction failed" };
      }
    } catch (error) {
      this.log(`Detailed error: ${error.message}`, "error");
      return { success: false, error: `Transaction failed: ${error.message}` };
    }
  }

  async runAccount() {
    const addresses = this.wallets;
    for (let i = 0; i < addresses.length; i++) {
      const address = addresses[i];
      const privateKey = this.queryId;
      const proxy = this.proxy;

      this.setProxy(proxy);
      let proxyIP = "No proxy";

      if (proxy) {
        try {
          proxyIP = await this.checkProxyIP(proxy);
        } catch (error) {
          this.log(`Lỗi kiểm tra proxy: ${error.message}`, "error");
        }
      }

      console.log(`========== Ví ${i + 1} | ${address.green} | ip: ${proxyIP} ==========`);

      const balance = await this.getBalance(address);
      this.log(`Số dư hiện tại: ${balance} THP`, "custom");

      const claimResult = await this.claimTHP(address);
      if (claimResult.success) {
        this.log(`Claim tHP thành công | Txhash: ${claimResult.txHash}`, "success");
      } else {
        this.log(`Claim tHP thất bại: ${claimResult.error}`, "error");
      }

      this.log(`Waiting for 10 seconds to continue claim RWT...`);
      await sleep(10);

      const rewardResult = await this.claimReward(privateKey, address);
      if (rewardResult.success) {
        this.log(`Claim reward thành công | Txhash: ${rewardResult.txHash}`, "success");
      } else {
        this.log(`Claim reward thất bại: ${rewardResult.error}`, "warning");
      }

      await sleep(3);
      if (settings.AUTO_BRIDGE) {
        const bridgeResult = await this.bridgeAssets(privateKey, address);
        if (bridgeResult.success) {
          this.log(`Bridge asset thành công | Txhash: ${bridgeResult.txHash}`, "success");
        } else {
          this.log(`Bridge asset thất bại: ${bridgeResult.error}`, "warning");
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function runWorker(workerData) {
  const { queryId, accountIndex, proxy, wallets } = workerData;
  const to = new HumanityClient(queryId, accountIndex, proxy, wallets);
  try {
    await Promise.race([to.runAccount(), new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 24 * 60 * 60 * 1000))]);
    parentPort.postMessage({
      accountIndex,
    });
  } catch (error) {
    parentPort.postMessage({ accountIndex, error: error.message });
  } finally {
    if (!isMainThread) {
      parentPort.postMessage("taskComplete");
    }
  }
}

async function main() {
  const queryIds = loadData("privateKeys.txt");
  const proxies = loadData("proxy.txt");
  const wallets = loadData("wallets.txt");
  if (wallets.length == 0) {
    this.log(`Not found wallet in wallets.txt`);
    process.exit(1);
  }
  if (queryIds.length > proxies.length) {
    console.log("Số lượng proxy và data phải bằng nhau.".red);
    console.log(`Data: ${queryIds.length}`);
    console.log(`Proxy: ${proxies.length}`);
    process.exit(1);
  }
  console.log("Tool được phát triển bởi nhóm tele Airdrop Hunter Siêu Tốc (https://t.me/airdrophuntersieutoc)".yellow);
  let maxThreads = settings.MAX_THEADS;

  await sleep(1);
  while (true) {
    let currentIndex = 0;
    const errors = [];

    while (currentIndex < queryIds.length) {
      const workerPromises = [];
      const batchSize = Math.min(maxThreads, queryIds.length - currentIndex);
      for (let i = 0; i < batchSize; i++) {
        const worker = new Worker(__filename, {
          workerData: {
            queryId: queryIds[currentIndex],
            accountIndex: currentIndex,
            proxy: proxies[currentIndex % proxies.length],
            wallets,
          },
        });

        workerPromises.push(
          new Promise((resolve) => {
            worker.on("message", (message) => {
              if (message === "taskComplete") {
                worker.terminate();
              }
              if (settings.ENABLE_DEBUG) {
                console.log(message);
              }
              resolve();
            });
            worker.on("error", (error) => {
              console.log(`Lỗi worker cho tài khoản ${currentIndex}: ${error.message}`);
              worker.terminate();
              resolve();
            });
            worker.on("exit", (code) => {
              worker.terminate();
              if (code !== 0) {
                errors.push(`Worker cho tài khoản ${currentIndex} thoát với mã: ${code}`);
              }
              resolve();
            });
          })
        );

        currentIndex++;
      }

      await Promise.all(workerPromises);

      if (errors.length > 0) {
        errors.length = 0;
      }

      if (currentIndex < queryIds.length) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    await sleep(3);
    console.log("Tool được phát triển bởi nhóm tele Airdrop Hunter Siêu Tốc (https://t.me/airdrophuntersieutoc)".yellow);
    console.log(`=============Hoàn thành tất cả tài khoản | Chờ ${settings.TIME_SLEEP} phút=============`.magenta);
    await sleep(settings.TIME_SLEEP * 60);
  }
}

if (isMainThread) {
  main().catch((error) => {
    console.log("Lỗi rồi:", error);
    process.exit(1);
  });
} else {
  runWorker(workerData);
}
