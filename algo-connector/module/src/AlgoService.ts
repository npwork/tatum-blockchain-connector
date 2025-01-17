import { PinoLogger } from 'nestjs-pino';
import axios, {AxiosRequestConfig} from 'axios';
import {
  Currency,
  generateAlgoWallet,
  generateAlgodAddressFromPrivatetKey,
  getAlgoClient,
  getAlgoIndexerClient,
  AlgoTransaction,
  prepareAlgoSignedTransaction
} from '@tatumio/tatum';

import { BroadcastOrStoreKMSTransaction, AlgoNodeType } from '@tatumio/blockchain-connector-common';
import { AlgoError } from './AlgoError';
import { Request } from 'express';
export abstract class AlgoService {

  private static mapBlock(block: any) {
    return {
      genesisHash: block['genesis-hash'],
      genesisId: block['genesis-id'],
      previousBlockHash: block['previous-block-hash'],
      rewards: block.rewards,
      round: block.round,
      seed: block.seed,
      timestamp: block.timestamp,
      txns: block.transactions.map(AlgoService.mapTransaction),
      txn: block['transactions-root'],
      txnc: block['txn-counter'],
      upgradeState: block['upgrade-state'],
      upgradeVote: block['upgrade-vote']
    };
  }

  private static mapTransaction(tx: any) {
    return {
      closeRewards: tx['close-rewards'],
      closingAmount: tx['closing-amount'] ? tx['closing-amount'] / 1000000 : tx['closing-amount'],
      confirmedRound: tx['confirmed-round'],
      fee: tx.fee / 1000000,
      firstValid: tx['first-valid'],
      genesisHash: tx['genesis-hash'],
      genesisId: tx['genesis-id'],
      id: tx.id,
      intraRoundOffset: tx['intra-round-offset'],
      lastValid: tx['last-valid'],
      note: tx.note,
      paymentTransaction: tx['payment-transaction'] ? { ...tx['payment-transaction'], amount: tx['payment-transaction'].amount / 1000000 } : tx['payment-transaction'],
      receiverRewards: tx['receiver-rewards'],
      roundTime: tx['round-time'],
      sender: tx.sender,
      senderRewards: tx['sender-rewards'],
      signature: tx.signature,
      txType: tx['tx-type'],
    };
  };

  protected constructor(protected readonly logger: PinoLogger) {
  }

  protected abstract isTestnet(): Promise<boolean>;

  public abstract getNodesUrl(nodeType: AlgoNodeType): Promise<string[]>;

  protected abstract storeKMSTransaction(txData: string, currency: string, signatureId: string[], index?: number): Promise<string>;

  protected abstract completeKMSTransaction(txId: string, signatureId: string): Promise<void>;

  public async getClient(testnet?: boolean) {
    return getAlgoClient(testnet !== undefined ? testnet : await this.isTestnet(), (await this.getNodesUrl(AlgoNodeType.ALGOD))[0]);
  }

  public async getIndexerClient() {
    return getAlgoIndexerClient(await this.isTestnet(), (await this.getNodesUrl(AlgoNodeType.INDEXER))[0]);
  }

  public async generateWallet(mnem?: string) {
    return generateAlgoWallet(mnem);
  }

  public async generateAddress(fromPrivateKey: string) {
    return generateAlgodAddressFromPrivatetKey(fromPrivateKey);
  }

  public async sendTransaction(tx: AlgoTransaction) {
    const txData = await prepareAlgoSignedTransaction(await this.isTestnet(), tx, (await this.getNodesUrl(AlgoNodeType.ALGOD))[0]);
    return this.broadcastOrStoreKMSTransaction({ transactionData: txData, signatureId: tx.signatureId, index: tx.index })
  }

  public async getBalance(address: string) {
    const client = await this.getClient();
    const accountInfo = await client.accountInformation(address).do();
    return accountInfo.amount / 1000000;
  }

  private async broadcastOrStoreKMSTransaction({
    transactionData,
    signatureId, index
  }: BroadcastOrStoreKMSTransaction) {
    if (signatureId) {
      return {
        signatureId: await this.storeKMSTransaction(transactionData, Currency.ALGO, [signatureId], index),
      };
    }
    return this.broadcast(transactionData);
  }

  /**
   *
   * @param algodClient algorand Client
   * @param txId transaction id
   * @returns confirmed result
   */
  private async waitForConfirmation(algodClient: any, txId: string) {
    let lastround = (await algodClient.status().do())['last-round'];
    let limit = 0;
    while (limit < 2) {
      const pendingInfo = await algodClient.pendingTransactionInformation(txId).do();
      if (pendingInfo['confirmed-round']) {
        return true;
      } else if (pendingInfo['pool-error']) {
        return false;
      }
      lastround++;
      limit++;
      await algodClient.statusAfterBlock(lastround).do();
    }
    return false;
  }

  public async broadcast(txData: string, signatureId?: string): Promise<{ txId: string, failed?: boolean, }> {
    this.logger.info(`Broadcast tx for ALGO with data '${txData}'`);
    const client = await this.getClient();
    const sendTx = await client.sendRawTransaction(txData).do();
    const confirm = await this.waitForConfirmation(client, sendTx.txId);

    if (confirm) {
      if (signatureId) {
        try {
          await this.completeKMSTransaction(sendTx.txId, signatureId);
        } catch (e) {
          this.logger.error(e);
          return { txId: sendTx.txId, failed: true };
        }
      }
      return sendTx.txId;
    } else {
      throw new AlgoError(`Failed Algo Transaction Signing`, 'algo.error');
    }
  }

  public async getCurrentBlock(testnet?: boolean): Promise<number> {
    const client = await this.getClient(testnet);
    return (await client.getTransactionParams().do()).firstRound;
  }

  public async getBlock(roundNumber: number) {
    try {
      const indexerClient = await this.getIndexerClient();
      const blockInfo = await indexerClient.lookupBlock(roundNumber).do()
      return AlgoService.mapBlock(blockInfo);
    } catch (_) {
      throw new AlgoError(`Failed Algo get block by round number`, 'algo.error');
    }
  }

  public async getTransaction(txid: string) {
    try {
      const indexerClient = await this.getIndexerClient();
      const transactionInfo = (await indexerClient.lookupTransactionByID(txid).do()).transaction;
      return AlgoService.mapTransaction(transactionInfo);
    } catch (_) {
      throw new AlgoError(`Failed Algo get transaction by transaction id`, 'algo.error');
    }
  }

  public async getPayTransactions(from: string, to: string, limit?: string, next?: string, testnet?: boolean) {
    const isTestnet = testnet || (await this.isTestnet());
    const baseurl = (await this.getNodesUrl(AlgoNodeType.INDEXER))[0];
    const apiUrl = `${baseurl}/v2/transactions?tx-type=pay&after-time=${from}&before-time=${to}` + (limit ? `&limit=${limit}` : '') + (next ? `&next=${next}` : '');
    try {
      const res = (await axios({
        method: 'get',
        url: apiUrl,
        headers: isTestnet ? (process.env.TATUM_ALGORAND_TESTNET_THIRD_API_KEY ? {} : { 'X-API-Key': `${process.env.TATUM_ALGORAND_TESTNET_THIRD_API_KEY}` }) :
          (process.env.TATUM_ALGORAND_MAINNET_THIRD_API_KEY ? {} : { 'X-API-Key': `${process.env.TATUM_ALGORAND_MAINNET_THIRD_API_KEY}` })
      })).data;
      const transactions = res.transactions.map(AlgoService.mapTransaction);
      return { nextToken: res['next-token'], transactions: transactions }
    } catch (e) {
      this.logger.error(e);
      throw new AlgoError(`Failed Algo get pay transactions by from and to`, 'algo.error');
    }
  }

  public async nodeMethod(req: Request, key: string, algoNodeType: AlgoNodeType) {
    try {
      const path = req.url;
      const baseURL = (await this.getNodesUrl(algoNodeType))[0];
      const [_, url] = path.split(`/${key}/`);
      const config = {
        method: req.method || 'GET',
        url,
        baseURL,
        headers: {
          'content-type': 'application/json',
          'X-API-Key': key,
        },
        ...(Object.keys(req.body).length ? { data: req.body } : {}),
      };

        return (await axios.request(config as AxiosRequestConfig)).data;
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }
}
