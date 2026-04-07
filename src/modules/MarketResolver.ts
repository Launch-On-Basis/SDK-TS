import { BasisClient } from '../BasisClient';
import AMarketResolverArtifact from '../abis/AMarketResolver.json';
import IERC20Artifact from '../abis/IERC20.json';
import { Address } from 'viem';

export class MarketResolverModule {
  private client: BasisClient;
  private resolverAddress: Address;

  constructor(client: BasisClient, resolverAddress: Address) {
    this.client = client;
    this.resolverAddress = resolverAddress;
  }

  private async _syncTx(txHash: string) {
    await this.client.api.syncTransaction(txHash);
  }

  private async approveIfNeeded(tokenAddress: Address, spender: Address, amount: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Wallet account is required for approval.");
    }
    const account = this.client.walletClient.account;
    const allowance = await this.client.publicClient.readContract({
      address: tokenAddress,
      abi: IERC20Artifact.abi,
      functionName: 'allowance',
      args: [account.address, spender],
    }) as bigint;

    if (allowance < amount) {
      const { request } = await this.client.publicClient.simulateContract({
        account,
        address: tokenAddress,
        abi: IERC20Artifact.abi,
        functionName: 'approve',
        args: [spender, amount],
      });
      const hash = await this.client.writeContract(request);
      await this.client.publicClient.waitForTransactionReceipt({ hash });
    }
  }

  // -----------------------------------------------------------------------
  // Write methods
  // -----------------------------------------------------------------------

  /**
   * Proposes an outcome for a market.
   * Auto-approves USDB to the resolver for the PROPOSAL_BOND amount.
   * @param marketToken - prediction market token address
   * @param outcomeId - outcome index
   */
  async proposeOutcome(marketToken: Address, outcomeId: number) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const bond = await this.client.publicClient.readContract({
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'PROPOSAL_BOND',
    }) as bigint;
    await this.approveIfNeeded(this.client.usdbAddress, this.resolverAddress, bond);

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'proposeOutcome',
      args: [marketToken, outcomeId],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Disputes a proposed outcome.
   * Auto-approves USDB to the resolver for the PROPOSAL_BOND amount.
   * @param marketToken - prediction market token address
   * @param newOutcomeId - proposed alternative outcome index
   */
  async dispute(marketToken: Address, newOutcomeId: number) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const bond = await this.client.publicClient.readContract({
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'PROPOSAL_BOND',
    }) as bigint;
    await this.approveIfNeeded(this.client.usdbAddress, this.resolverAddress, bond);

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'dispute',
      args: [marketToken, newOutcomeId],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Casts a vote on a disputed market outcome.
   * @param marketToken - prediction market token address
   * @param outcomeId - outcome index to vote for
   */
  async vote(marketToken: Address, outcomeId: number) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'vote',
      args: [marketToken, outcomeId],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Stakes tokens to become a resolver voter.
   * Auto-approves the token to the resolver for MIN_STAKE_AMOUNT.
   * @param token - token contract address to stake
   */
  async stake(token: Address) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const minStake = await this.client.publicClient.readContract({
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'MIN_STAKE_AMOUNT',
    }) as bigint;
    await this.approveIfNeeded(token, this.resolverAddress, minStake);

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'stake',
      args: [token],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Unstakes tokens, removing resolver voter status.
   * @param token - token contract address to unstake
   */
  async unstake(token: Address) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'unstake',
      args: [token],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Finalizes an uncontested market (proposal period expired without dispute).
   * @param marketToken - prediction market token address
   */
  async finalizeUncontested(marketToken: Address) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'finalizeUncontested',
      args: [marketToken],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Finalizes a disputed market after the dispute period.
   * @param marketToken - prediction market token address
   */
  async finalizeMarket(marketToken: Address) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'finalizeMarket',
      args: [marketToken],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Vetoes a proposed outcome.
   * Auto-approves USDB to the resolver for the PROPOSAL_BOND amount.
   * @param marketToken - prediction market token address
   * @param proposedOutcome - outcome index being vetoed
   */
  async veto(marketToken: Address, proposedOutcome: number) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const bond = await this.client.publicClient.readContract({
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'PROPOSAL_BOND',
    }) as bigint;
    await this.approveIfNeeded(this.client.usdbAddress, this.resolverAddress, bond);

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'veto',
      args: [marketToken, proposedOutcome],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Claims the bounty reward for voting correctly on a resolved market.
   * @param marketToken - prediction market token address
   */
  async claimBounty(marketToken: Address) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'claimBounty',
      args: [marketToken],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Claims an early bounty reward for a specific dispute round.
   * @param marketToken - prediction market token address
   * @param round - dispute round number (integer)
   */
  async claimEarlyBounty(marketToken: Address, round: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'claimEarlyBounty',
      args: [marketToken, round],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  // -----------------------------------------------------------------------
  // Read methods
  // -----------------------------------------------------------------------

  /**
   * Returns the dispute data struct for a market.
   * @param marketToken - prediction market token address
   */
  async getDisputeData(marketToken: Address) {
    return this.client.publicClient.readContract({
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'disputes',
      args: [marketToken],
    });
  }

  /**
   * Returns whether a market has been resolved.
   * @param marketToken - prediction market token address
   */
  async isResolved(marketToken: Address): Promise<boolean> {
    return this.client.publicClient.readContract({
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'resolved',
      args: [marketToken],
    }) as Promise<boolean>;
  }

  /**
   * Returns the final outcome of a resolved market.
   * @param marketToken - prediction market token address
   */
  async getFinalOutcome(marketToken: Address): Promise<number> {
    return this.client.publicClient.readContract({
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'finalOutcome',
      args: [marketToken],
    }) as Promise<number>;
  }

  /**
   * Returns whether a market is currently in a dispute.
   * @param marketToken - prediction market token address
   */
  async isInDispute(marketToken: Address): Promise<boolean> {
    return this.client.publicClient.readContract({
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'inDispute',
      args: [marketToken],
    }) as Promise<boolean>;
  }

  /**
   * Returns whether a market is currently in a veto period.
   * @param marketToken - prediction market token address
   */
  async isInVeto(marketToken: Address): Promise<boolean> {
    return this.client.publicClient.readContract({
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'inVeto',
      args: [marketToken],
    }) as Promise<boolean>;
  }

  /**
   * Returns the current dispute round for a market.
   * @param marketToken - prediction market token address
   */
  async getCurrentRound(marketToken: Address): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'currentRound',
      args: [marketToken],
    }) as Promise<bigint>;
  }

  /**
   * Returns the vote count for a specific outcome in a specific round.
   * @param marketToken - prediction market token address
   * @param round - dispute round number (integer)
   * @param outcomeId - outcome index
   */
  async getVoteCount(marketToken: Address, round: bigint, outcomeId: number): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'nftVoteCount',
      args: [marketToken, round, outcomeId],
    }) as Promise<bigint>;
  }

  /**
   * Returns whether a voter has already voted in a specific round.
   * @param marketToken - prediction market token address
   * @param round - dispute round number (integer)
   * @param voter - voter wallet address
   */
  async hasVoted(marketToken: Address, round: bigint, voter: Address): Promise<boolean> {
    return this.client.publicClient.readContract({
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'nftHasVoted',
      args: [marketToken, round, voter],
    }) as Promise<boolean>;
  }

  /**
   * Returns the outcome a voter chose in a specific round.
   * @param marketToken - prediction market token address
   * @param round - dispute round number (integer)
   * @param voter - voter wallet address
   */
  async getVoterChoice(marketToken: Address, round: bigint, voter: Address): Promise<number> {
    return this.client.publicClient.readContract({
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'voterChoice',
      args: [marketToken, round, voter],
    }) as Promise<number>;
  }

  /**
   * Returns the bounty amount per correct vote for a resolved market.
   * @param marketToken - prediction market token address
   */
  async getBountyPerVote(marketToken: Address): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'bountyPerCorrectVote',
      args: [marketToken],
    }) as Promise<bigint>;
  }

  /**
   * Returns whether a voter has already claimed the bounty for a market.
   * @param marketToken - prediction market token address
   * @param voter - voter wallet address
   */
  async hasClaimed(marketToken: Address, voter: Address): Promise<boolean> {
    return this.client.publicClient.readContract({
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'bountyClaimed',
      args: [marketToken, voter],
    }) as Promise<boolean>;
  }

  /**
   * Returns the staked amount for a voter.
   * @param voter - voter wallet address
   */
  async getUserStake(voter: Address): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'userStakedAmount',
      args: [voter],
    }) as Promise<bigint>;
  }

  /**
   * Returns whether an address is a registered voter.
   * @param voter - voter wallet address
   */
  async isVoter(voter: Address): Promise<boolean> {
    return this.client.publicClient.readContract({
      address: this.resolverAddress,
      abi: AMarketResolverArtifact.abi,
      functionName: 'isVoter',
      args: [voter],
    }) as Promise<boolean>;
  }

  /**
   * Returns all system configuration constants.
   */
  async getConstants() {
    const [disputePeriod, proposalPeriod, proposalBond, minStakeAmount] = await Promise.all([
      this.client.publicClient.readContract({
        address: this.resolverAddress,
        abi: AMarketResolverArtifact.abi,
        functionName: 'DISPUTE_PERIOD',
      }) as Promise<bigint>,
      this.client.publicClient.readContract({
        address: this.resolverAddress,
        abi: AMarketResolverArtifact.abi,
        functionName: 'PROPOSAL_PERIOD',
      }) as Promise<bigint>,
      this.client.publicClient.readContract({
        address: this.resolverAddress,
        abi: AMarketResolverArtifact.abi,
        functionName: 'PROPOSAL_BOND',
      }) as Promise<bigint>,
      this.client.publicClient.readContract({
        address: this.resolverAddress,
        abi: AMarketResolverArtifact.abi,
        functionName: 'MIN_STAKE_AMOUNT',
      }) as Promise<bigint>,
    ]);

    return { disputePeriod, proposalPeriod, proposalBond, minStakeAmount };
  }
}
